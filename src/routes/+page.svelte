<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		getAllTimezones,
		getTimezoneAbbr,
		getTimezoneOffset,
		formatOffset,
		getDayTier,
		searchTimezones,
		type TimezoneInfo,
	} from '$lib/timezones';
	import { X, ChevronUp, ChevronDown, Search, Globe } from '@lucide/svelte';

	// State
	let allTimezones: TimezoneInfo[] = $state([]);
	let selectedTimezones: string[] = $state([]);
	let query = $state('');
	let searchResults: { tz: TimezoneInfo; displayName?: string }[] = $state([]);
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

		// Update clock every 15 seconds for minute accuracy
		const interval = setInterval(() => {
			now = new Date();
		}, 15000);

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
				(r) => !selectedTimezones.includes(r.tz.id)
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
				addTimezone(searchResults[highlightedIndex].tz);
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

	function getHourForTimezone(tz: string, hour: number): { displayHour: number; period: string; isCurrentHour: boolean; dayOffset: number; minuteProgress: number } {
		const offsetMinutes = getTimezoneOffset(tz, now);

		// Get current hour in the first timezone (reference)
		const refOffset = getTimezoneOffset(selectedTimezones[0], now);
		const refDiff = offsetMinutes - refOffset;

		const tzHour = ((hour + Math.round(refDiff / 60)) % 24 + 24) % 24;
		const dayOffset = Math.floor((hour + Math.round(refDiff / 60)) / 24);

		// Check if this is current hour and get minute progress
		const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
		const currentTzHour = nowInTz.getHours();
		const isCurrentHour = tzHour === currentTzHour;
		const minuteProgress = isCurrentHour ? nowInTz.getMinutes() / 60 : 0;

		const displayHour = tzHour % 12 || 12;
		const period = tzHour < 12 ? 'AM' : 'PM';

		return { displayHour, period, isCurrentHour, dayOffset, minuteProgress };
	}

	function getCurrentHourIndex(): number {
		const refTz = selectedTimezones[0];
		if (!refTz) return 0;
		const nowInRef = new Date(now.toLocaleString('en-US', { timeZone: refTz }));
		return nowInRef.getHours();
	}

	// Compute the blue line's position as a percentage across the 24-cell grid
	// Based on the reference (first) timezone
	function getNowLinePercent(): number {
		const refTz = selectedTimezones[0];
		if (!refTz) return 0;
		const nowInRef = new Date(now.toLocaleString('en-US', { timeZone: refTz }));
		const h = nowInRef.getHours();
		const m = nowInRef.getMinutes();
		return ((h + m / 60) / 24) * 100;
	}

	function getTzHourValue(tz: string, hour: number): number {
		const offsetMinutes = getTimezoneOffset(tz, now);
		const refOffset = getTimezoneOffset(selectedTimezones[0], now);
		const refDiff = offsetMinutes - refOffset;
		return ((hour + Math.round(refDiff / 60)) % 24 + 24) % 24;
	}

	// Generate SVG path for a daylight arc curve
	// Peaks at noon (hour 13), trough at midnight (hour 1)
	function getDaylightPath(tz: string): string {
		const points: { x: number; y: number }[] = [];
		const height = 40;
		const maxArc = height * 0.65;

		for (let i = 0; i <= 48; i++) {
			const actualHour = getTzHourValue(tz, Math.floor(i / 2) % 24);
			const fractionalHour = actualHour + (i % 2) * 0.5;
			// Cosine: peak at hour 13, trough at hour 1
			// cos(0) = 1, so we want radians=0 at hour 13
			const radians = ((fractionalHour - 13) / 24) * Math.PI * 2;
			const val = (Math.cos(radians) + 1) / 2; // 0 at trough, 1 at peak
			const x = (i / 48) * 100;
			const y = height - val * maxArc;
			points.push({ x, y });
		}

		let d = `M ${points[0].x} ${points[0].y}`;
		for (let i = 1; i < points.length; i++) {
			const prev = points[i - 1];
			const curr = points[i];
			const cpx = (prev.x + curr.x) / 2;
			d += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
		}
		d += ` L 100 ${height} L 0 ${height} Z`;
		return d;
	}

	// Get the midnight cell index for a timezone (which of the 24 cells is midnight)
	function getMidnightIndex(tz: string): number {
		for (let h = 0; h < 24; h++) {
			if (getTzHourValue(tz, h) === 0) return h;
		}
		return -1;
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
					{#each searchResults as result, i}
						<button
							type="button"
							data-index={i}
							onclick={() => addTimezone(result.tz)}
							onmouseenter={() => (highlightedIndex = i)}
							class="w-full flex items-center justify-between px-3 py-2 text-sm transition-colors {highlightedIndex === i
								? 'bg-accent text-accent-foreground'
								: 'text-popover-foreground hover:bg-accent/50'}"
						>
							<span>
								<span class="font-medium">{result.displayName || result.tz.city}</span>
								{#if result.displayName}
									<span class="text-muted-foreground ml-2">{result.tz.city}</span>
								{:else}
									<span class="text-muted-foreground ml-2">{result.tz.region}</span>
								{/if}
							</span>
							<span class="text-muted-foreground text-xs">
								{getTimezoneAbbr(result.tz.id)} {formatOffset(getTimezoneOffset(result.tz.id))}
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
				<!-- Grid container with the global blue now-line -->
				<div class="flex">
					<!-- Label spacer -->
					<div class="w-36 shrink-0"></div>
					<!-- Now-line container (positioned over the cells area) -->
					<div class="flex-1 relative">
						<!-- Blue dot at top -->
						<div
							class="absolute -top-3 w-[10px] h-[10px] rounded-full bg-blue-500 z-20 -translate-x-1/2"
							style="left: {getNowLinePercent()}%"
						></div>
					</div>
				</div>

				<div class="relative">
					<!-- Continuous blue now-line spanning all rows -->
					<div class="absolute top-0 bottom-0 flex" style="left: 0; right: 0;">
						<div class="w-36 shrink-0"></div>
						<div class="flex-1 relative">
							<div
								class="absolute top-0 bottom-0 w-[2px] bg-blue-500 z-20 -translate-x-1/2"
								style="left: {getNowLinePercent()}%"
							></div>
						</div>
					</div>

					<!-- Rows -->
					<div class="space-y-1">
						{#each selectedTimezones as tzId, rowIndex}
							<div class="group relative flex items-center gap-3">
								<!-- Timezone label -->
								<div class="w-36 shrink-0 relative pr-2">
									<div class="font-medium text-sm leading-tight">{getCityName(tzId)}</div>
									<div class="text-[11px] text-muted-foreground leading-tight mt-0.5">
										{formatTime(tzId)} &middot; {getTimezoneAbbr(tzId)}
									</div>

									<!-- Reorder buttons -->
									<div class="absolute right-0 top-1/2 -translate-y-1/2 flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
										{#if rowIndex > 0}
											<button
												type="button"
												onclick={() => moveTimezone(rowIndex, -1)}
												class="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
											>
												<ChevronUp class="h-3 w-3" />
											</button>
										{/if}
										{#if rowIndex < selectedTimezones.length - 1}
											<button
												type="button"
												onclick={() => moveTimezone(rowIndex, 1)}
												class="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
											>
												<ChevronDown class="h-3 w-3" />
											</button>
										{/if}
									</div>
								</div>

								<!-- Hour cells with daylight arc -->
								<div class="flex-1 relative overflow-x-auto no-scrollbar">
									<!-- Daylight arc SVG behind cells -->
									<svg
										class="absolute inset-0 w-full h-full pointer-events-none"
										viewBox="0 0 100 40"
										preserveAspectRatio="none"
									>
										<path
											d={getDaylightPath(tzId)}
											fill="url(#daylight-{rowIndex})"
										/>
										<defs>
											<linearGradient id="daylight-{rowIndex}" x1="0" y1="0" x2="0" y2="1">
												<stop offset="0%" stop-color="rgb(250 204 21)" stop-opacity="0.12" />
												<stop offset="100%" stop-color="rgb(250 204 21)" stop-opacity="0.02" />
											</linearGradient>
										</defs>
									</svg>

									<!-- Cells -->
									<div class="flex relative z-10">
										{#each hours as hour}
											{@const tzHour = getHourForTimezone(tzId, hour)}
											{@const actualHour = getTzHourValue(tzId, hour)}
											{@const isNow = tzHour.isCurrentHour}
											{@const isMidnight = actualHour === 0}
											<div
												class="flex-1 min-w-[2.75rem] h-10 flex flex-col items-center justify-center relative
													{isMidnight ? 'border-l-2 border-l-border' : 'border-l border-l-border/20'}"
											>
												{#if isMidnight}
													<!-- Date label at midnight -->
													{@const midnightDate = new Date(now.getTime() + tzHour.dayOffset * 86400000)}
													<span class="absolute -top-4 left-0 text-[9px] font-medium text-muted-foreground whitespace-nowrap">
														{new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric' }).format(midnightDate)}
													</span>
												{/if}
												<span class="text-xs font-medium
													{isNow
														? 'text-blue-400'
														: actualHour >= 9 && actualHour < 17
															? 'text-foreground'
															: actualHour >= 22 || actualHour < 6
																? 'text-muted-foreground/50'
																: 'text-muted-foreground/80'}">
													{tzHour.displayHour}{tzHour.period[0].toLowerCase()}
												</span>
												{#if tzHour.dayOffset !== 0}
													<span class="absolute top-0.5 right-0.5 text-[9px] font-medium text-muted-foreground">
														{tzHour.dayOffset > 0 ? '+1' : '-1'}
													</span>
												{/if}
											</div>
										{/each}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>
		</div>
	{:else}
		<div class="flex-1 flex items-center justify-center text-muted-foreground">
			<p>Type to search and add timezones</p>
		</div>
	{/if}
</div>
