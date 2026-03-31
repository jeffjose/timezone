<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		getAllTimezones,
		getTimezoneAbbr,
		getTimezoneOffset,
		formatOffset,
		isNightHour,
		searchTimezones,
		type TimezoneInfo,
	} from '$lib/timezones';
	import { X, ChevronUp, ChevronDown, Search, Globe } from '@lucide/svelte';

	// State
	let allTimezones: TimezoneInfo[] = $state([]);
	let selectedTimezones: string[] = $state([]);
	let query = $state('');
	let searchResults: TimezoneInfo[] = $state([]);
	let searchFocused = $state(false);
	let highlightedIndex = $state(-1);
	let inputEl: HTMLInputElement | undefined = $state();
	let now = $state(new Date());
	let dropdownEl: HTMLDivElement | undefined = $state();

	// Derived
	let showDropdown = $derived(searchFocused && query.length > 0 && searchResults.length > 0);

	// Get the local timezone
	const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	// Generate hours array (0-23)
	const hours = Array.from({ length: 24 }, (_, i) => i);

	onMount(() => {
		allTimezones = getAllTimezones();

		// Read initial timezones from URL
		const urlTz = $page.url.searchParams.get('tz');
		if (urlTz) {
			selectedTimezones = urlTz.split(',').filter((tz) => {
				try {
					Intl.DateTimeFormat(undefined, { timeZone: tz });
					return true;
				} catch {
					return false;
				}
			});
		}
		if (selectedTimezones.length === 0) {
			selectedTimezones = [localTz];
		}

		// Update clock every 30 seconds
		const interval = setInterval(() => {
			now = new Date();
		}, 30000);

		return () => clearInterval(interval);
	});

	function updateUrl() {
		const url = new URL(window.location.href);
		url.searchParams.set('tz', selectedTimezones.join(','));
		goto(url.toString(), { replaceState: true, keepFocus: true });
	}

	function addTimezone(tz: TimezoneInfo) {
		if (!selectedTimezones.includes(tz.id)) {
			selectedTimezones = [...selectedTimezones, tz.id];
			updateUrl();
		}
		query = '';
		searchResults = [];
		highlightedIndex = -1;
		inputEl?.focus();
	}

	function removeTimezone(tzId: string) {
		selectedTimezones = selectedTimezones.filter((t) => t !== tzId);
		updateUrl();
	}

	function moveTimezone(index: number, direction: -1 | 1) {
		const newIndex = index + direction;
		if (newIndex < 0 || newIndex >= selectedTimezones.length) return;
		const copy = [...selectedTimezones];
		[copy[index], copy[newIndex]] = [copy[newIndex], copy[index]];
		selectedTimezones = copy;
		updateUrl();
	}

	function handleSearch() {
		if (query.trim().length > 0) {
			searchResults = searchTimezones(query, allTimezones).filter(
				(tz) => !selectedTimezones.includes(tz.id)
			);
			highlightedIndex = searchResults.length > 0 ? 0 : -1;
		} else {
			searchResults = [];
			highlightedIndex = -1;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (showDropdown) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				highlightedIndex = Math.min(highlightedIndex + 1, searchResults.length - 1);
				scrollHighlightedIntoView();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				highlightedIndex = Math.max(highlightedIndex - 1, 0);
				scrollHighlightedIntoView();
			} else if (e.key === 'Enter' && highlightedIndex >= 0) {
				e.preventDefault();
				addTimezone(searchResults[highlightedIndex]);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				query = '';
				searchResults = [];
			}
		} else if (e.key === 'Backspace' && query === '' && selectedTimezones.length > 0) {
			removeTimezone(selectedTimezones[selectedTimezones.length - 1]);
		} else if (e.key === 'Escape') {
			inputEl?.blur();
		}
	}

	function scrollHighlightedIntoView() {
		requestAnimationFrame(() => {
			const el = dropdownEl?.querySelector(`[data-index="${highlightedIndex}"]`);
			el?.scrollIntoView({ block: 'nearest' });
		});
	}

	// Global key capture - focus search on any key
	function handleGlobalKeydown(e: KeyboardEvent) {
		if (
			document.activeElement === inputEl ||
			e.ctrlKey ||
			e.metaKey ||
			e.altKey
		)
			return;

		// Only capture printable characters
		if (e.key.length === 1) {
			e.preventDefault();
			inputEl?.focus();
			query += e.key;
			handleSearch();
		}
	}

	function getHourForTimezone(tz: string, hour: number): { displayHour: number; period: string; isCurrentHour: boolean; dayOffset: number } {
		const offsetMinutes = getTimezoneOffset(tz, now);
		const localOffset = getTimezoneOffset(localTz, now);
		const diffMinutes = offsetMinutes - localOffset;

		// Get current hour in the first timezone (reference)
		const refOffset = getTimezoneOffset(selectedTimezones[0], now);
		const refDiff = offsetMinutes - refOffset;

		const tzHour = ((hour + Math.round(refDiff / 60)) % 24 + 24) % 24;
		const dayOffset = Math.floor((hour + Math.round(refDiff / 60)) / 24);

		// Check if this is current hour
		const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
		const currentTzHour = nowInTz.getHours();
		const isCurrentHour = tzHour === currentTzHour;

		const displayHour = tzHour % 12 || 12;
		const period = tzHour < 12 ? 'AM' : 'PM';

		return { displayHour, period, isCurrentHour, dayOffset };
	}

	function getCurrentHourIndex(): number {
		const refTz = selectedTimezones[0];
		if (!refTz) return 0;
		const nowInRef = new Date(now.toLocaleString('en-US', { timeZone: refTz }));
		return nowInRef.getHours();
	}

	function formatTime(tz: string): string {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
		}).format(now);
	}

	function formatDate(tz: string): string {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(now);
	}

	function getCityName(tzId: string): string {
		const parts = tzId.split('/');
		return (parts[parts.length - 1] || tzId).replace(/_/g, ' ');
	}

	// Click outside to close dropdown
	function handleClickOutside(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest('.search-container')) {
			searchFocused = false;
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} onclick={handleClickOutside} />

<svelte:head>
	<title>Timezone</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground flex flex-col">
	<!-- Header -->
	<div class="flex flex-col items-center pt-12 pb-8 px-4">
		<div class="flex items-center gap-3 mb-8">
			<Globe class="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
			<h1 class="text-2xl font-light tracking-[0.3em] text-muted-foreground">TIMEZONE</h1>
		</div>

		<!-- Search box -->
		<div class="search-container relative w-full max-w-2xl">
			<div
				class="flex items-center flex-wrap gap-1.5 rounded-lg border border-border bg-card px-3 py-2 transition-colors focus-within:border-muted-foreground/50"
			>
				<Search class="h-4 w-4 text-muted-foreground shrink-0" />

				{#each selectedTimezones as tzId}
					<span
						class="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-sm text-secondary-foreground"
					>
						{getCityName(tzId)}
						<button
							type="button"
							onclick={() => removeTimezone(tzId)}
							class="hover:text-foreground text-muted-foreground transition-colors"
						>
							<X class="h-3 w-3" />
						</button>
					</span>
				{/each}

				<input
					bind:this={inputEl}
					bind:value={query}
					oninput={handleSearch}
					onkeydown={handleKeydown}
					onfocus={() => (searchFocused = true)}
					type="text"
					placeholder={selectedTimezones.length === 0 ? 'Search timezones...' : 'Add timezone...'}
					class="flex-1 min-w-[120px] bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
				/>
			</div>

			<!-- Dropdown -->
			{#if showDropdown}
				<div
					bind:this={dropdownEl}
					class="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-popover shadow-lg max-h-64 overflow-y-auto z-50"
				>
					{#each searchResults as tz, i}
						<button
							type="button"
							data-index={i}
							onclick={() => addTimezone(tz)}
							onmouseenter={() => (highlightedIndex = i)}
							class="w-full flex items-center justify-between px-3 py-2 text-sm transition-colors {highlightedIndex === i
								? 'bg-accent text-accent-foreground'
								: 'text-popover-foreground hover:bg-accent/50'}"
						>
							<span>
								<span class="font-medium">{tz.city}</span>
								<span class="text-muted-foreground ml-2">{tz.region}</span>
							</span>
							<span class="text-muted-foreground text-xs">
								{getTimezoneAbbr(tz.id)} {formatOffset(getTimezoneOffset(tz.id))}
							</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Timezone rows -->
	{#if selectedTimezones.length > 0}
		<div class="flex-1 px-4 pb-8">
			<div class="max-w-6xl mx-auto">
				{#each selectedTimezones as tzId, rowIndex}
					{@const currentHourIdx = getCurrentHourIndex()}
					<div class="group relative flex items-stretch border-b border-border/50 first:border-t">
						<!-- Timezone label -->
						<div class="w-36 shrink-0 flex flex-col justify-center py-3 pr-3 relative">
							<div class="flex items-center gap-1">
								<span class="font-medium text-sm">{getCityName(tzId)}</span>
							</div>
							<div class="text-xs text-muted-foreground">
								{getTimezoneAbbr(tzId)} &middot; {formatOffset(getTimezoneOffset(tzId))}
							</div>
							<div class="text-xs text-muted-foreground mt-0.5">
								{formatTime(tzId)} &middot; {formatDate(tzId)}
							</div>

							<!-- Reorder buttons - visible on hover -->
							<div class="absolute right-0 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
								{#if rowIndex > 0}
									<button
										type="button"
										onclick={() => moveTimezone(rowIndex, -1)}
										class="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
									>
										<ChevronUp class="h-3.5 w-3.5" />
									</button>
								{/if}
								{#if rowIndex < selectedTimezones.length - 1}
									<button
										type="button"
										onclick={() => moveTimezone(rowIndex, 1)}
										class="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
									>
										<ChevronDown class="h-3.5 w-3.5" />
									</button>
								{/if}
							</div>
						</div>

						<!-- Hour cells -->
						<div class="flex-1 flex overflow-x-auto no-scrollbar">
							{#each hours as hour}
								{@const tzHour = getHourForTimezone(tzId, hour)}
								{@const isNight = isNightHour(
									((hour + Math.round((getTimezoneOffset(tzId) - getTimezoneOffset(selectedTimezones[0])) / 60)) % 24 + 24) % 24
								)}
								{@const isNow = tzHour.isCurrentHour}
								<div
									class="flex-1 min-w-[3rem] flex flex-col items-center justify-center py-3 text-xs transition-colors relative
										{isNow ? 'bg-primary/15 ring-1 ring-primary/30' : isNight ? 'bg-muted/40' : ''}"
								>
									{#if isNow}
										<div class="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-primary"></div>
									{/if}
									<span class="font-medium {isNow ? 'text-primary' : isNight ? 'text-muted-foreground' : 'text-foreground'}">
										{tzHour.displayHour}
									</span>
									<span class="text-[10px] {isNow ? 'text-primary/70' : 'text-muted-foreground'}">
										{tzHour.period}
									</span>
									{#if tzHour.dayOffset !== 0}
										<span class="text-[9px] text-muted-foreground/60">
											{tzHour.dayOffset > 0 ? '+1d' : '-1d'}
										</span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{:else}
		<div class="flex-1 flex items-center justify-center text-muted-foreground">
			<p>Type to search and add timezones</p>
		</div>
	{/if}
</div>
