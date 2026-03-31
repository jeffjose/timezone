<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		getAllTimezones,
		getTimezoneAbbr,
		getTimezoneOffset,
		formatOffset,
		searchTimezones,
		type TimezoneInfo,
	} from '$lib/timezones';
	import { X, ChevronUp, ChevronDown, Search, Globe } from '@lucide/svelte';

	interface SelectedTz {
		id: string;
		label: string;
	}

	// State
	let allTimezones: TimezoneInfo[] = $state([]);
	let selectedTimezones: SelectedTz[] = $state([]);
	let query = $state('');
	let searchResults: { tz: TimezoneInfo; displayName?: string }[] = $state([]);
	let searchFocused = $state(false);
	let highlightedIndex = $state(-1);
	let inputEl: HTMLInputElement | undefined = $state();
	let now = $state(new Date());
	let dropdownEl: HTMLDivElement | undefined = $state();
	let hoverPercent: number | null = $state(null);

	// Derived
	let showDropdown = $derived(searchFocused && query.length > 0 && searchResults.length > 0);
	let selectedIds = $derived(selectedTimezones.map((t) => t.id));
	let refTzId = $derived(selectedTimezones[0]?.id);

	// Get the local timezone
	const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	// Generate hours array (0-23)
	const hours = Array.from({ length: 24 }, (_, i) => i);

	onMount(() => {
		allTimezones = getAllTimezones();

		// Read initial timezones from URL
		const urlTz = $page.url.searchParams.get('tz');
		if (urlTz) {
			const entries = urlTz.split(',').filter((tz) => {
				try {
					Intl.DateTimeFormat(undefined, { timeZone: tz });
					return true;
				} catch {
					return false;
				}
			});
			selectedTimezones = entries.map((id) => ({ id, label: getCityName(id) }));
		}
		if (selectedTimezones.length === 0) {
			selectedTimezones = [{ id: localTz, label: getCityName(localTz) }];
		}

		// Update clock every second for seconds display
		const interval = setInterval(() => {
			now = new Date();
		}, 1000);

		return () => clearInterval(interval);
	});

	function updateUrl() {
		const url = new URL(window.location.href);
		url.searchParams.set('tz', selectedIds.join(','));
		goto(url.toString(), { replaceState: true, keepFocus: true });
	}

	function addTimezone(tz: TimezoneInfo, displayName?: string) {
		selectedTimezones = [...selectedTimezones, { id: tz.id, label: displayName || tz.city }];
		updateUrl();
		query = '';
		searchResults = [];
		highlightedIndex = -1;
		inputEl?.focus();
	}

	function removeTimezoneAt(index: number) {
		selectedTimezones = selectedTimezones.filter((_, i) => i !== index);
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
			searchResults = searchTimezones(query, allTimezones);
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
				const r = searchResults[highlightedIndex];
				addTimezone(r.tz, r.displayName);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				query = '';
				searchResults = [];
			}
		} else if (e.key === 'Backspace' && query === '' && selectedTimezones.length > 0) {
			removeTimezoneAt(selectedTimezones.length - 1);
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
		if (document.activeElement === inputEl || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key.length === 1) {
			e.preventDefault();
			inputEl?.focus();
			query += e.key;
			handleSearch();
		}
	}

	function getHourForTimezone(tz: string, hour: number): { displayHour: number; period: string; isCurrentHour: boolean; dayOffset: number } {
		const offsetMinutes = getTimezoneOffset(tz, now);
		const refOffset = getTimezoneOffset(refTzId, now);
		const refDiff = offsetMinutes - refOffset;

		const tzHour = ((hour + Math.round(refDiff / 60)) % 24 + 24) % 24;
		const dayOffset = Math.floor((hour + Math.round(refDiff / 60)) / 24);

		const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
		const currentTzHour = nowInTz.getHours();
		const isCurrentHour = tzHour === currentTzHour;

		const displayHour = tzHour % 12 || 12;
		const period = tzHour < 12 ? 'AM' : 'PM';

		return { displayHour, period, isCurrentHour, dayOffset };
	}

	function getNowLinePercent(): number {
		if (!refTzId) return 0;
		const nowInRef = new Date(now.toLocaleString('en-US', { timeZone: refTzId }));
		return ((nowInRef.getHours() + nowInRef.getMinutes() / 60) / 24) * 100;
	}

	function getTzHourValue(tz: string, hour: number): number {
		const offsetMinutes = getTimezoneOffset(tz, now);
		const refOffset = getTimezoneOffset(refTzId, now);
		const refDiff = offsetMinutes - refOffset;
		return ((hour + Math.round(refDiff / 60)) % 24 + 24) % 24;
	}

	// SVG daylight arc: peaks at ~1PM, trough at ~1AM
	function getDaylightPath(tz: string): string {
		const points: { x: number; y: number }[] = [];
		const height = 40;
		const maxArc = height * 0.65;

		for (let i = 0; i <= 48; i++) {
			const actualHour = getTzHourValue(tz, Math.floor(i / 2) % 24);
			const fractionalHour = actualHour + (i % 2) * 0.5;
			const radians = ((fractionalHour - 13) / 24) * Math.PI * 2;
			const val = (Math.cos(radians) + 1) / 2;
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

	function formatTime(tz: string): string {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
		}).format(now);
	}

	function formatTimeWithSeconds(tz: string): string {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit',
			hour12: true,
		}).format(now);
	}

	function getCityName(tzId: string): string {
		const parts = tzId.split('/');
		return (parts[parts.length - 1] || tzId).replace(/_/g, ' ');
	}

	// Hover: compute time + date at hovered x-position for a timezone
	function getHoveredTime(tz: string, percent: number): { time: string; date: string } {
		const refHour = (percent / 100) * 24;
		const offsetMinutes = getTimezoneOffset(tz, now);
		const refOffset = getTimezoneOffset(refTzId, now);
		const refDiff = offsetMinutes - refOffset;
		const tzHourRaw = refHour + Math.round(refDiff / 60);
		const dayOffset = Math.floor(tzHourRaw / 24);
		const tzHour = ((tzHourRaw % 24) + 24) % 24;
		const h = Math.floor(tzHour);
		const m = Math.round((tzHour - h) * 60);
		const displayHour = h % 12 || 12;
		const period = h < 12 ? 'AM' : 'PM';
		const time = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;

		// Compute the date at the hovered position
		const hoveredDate = new Date(now.getTime() + dayOffset * 86400000);
		const date = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(hoveredDate);

		return { time, date };
	}

	function handleCellsMouseMove(e: MouseEvent) {
		// Find the first cells-area element to get exact bounds
		const container = e.currentTarget as HTMLElement;
		const cellsEl = container.querySelector('.cells-area');
		if (!cellsEl) return;
		const rect = cellsEl.getBoundingClientRect();
		hoverPercent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
	}

	function handleCellsMouseLeave() {
		hoverPercent = null;
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

				{#each selectedTimezones as entry, i}
					<span
						class="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-sm text-secondary-foreground"
					>
						{entry.label}
						<button
							type="button"
							onclick={() => removeTimezoneAt(i)}
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
							onclick={() => addTimezone(result.tz, result.displayName)}
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
				<!-- Blue dot above the grid -->
				<div class="flex">
					<div class="w-44 shrink-0"></div>
					<div class="flex-1 relative">
						<div
							class="absolute -top-3 w-[10px] h-[10px] rounded-full bg-blue-500 z-20 -translate-x-1/2"
							style="left: {getNowLinePercent()}%"
						></div>
					</div>
				</div>

				<!-- Grid with lines overlay -->
				<div
					class="relative"
					onmousemove={handleCellsMouseMove}
					onmouseleave={handleCellsMouseLeave}
					role="presentation"
				>
					<!-- Blue now-line (continuous across all rows) -->
					<div class="absolute top-0 bottom-0 flex pointer-events-none" style="left: 0; right: 0;">
						<div class="w-44 shrink-0"></div>
						<div class="flex-1 relative">
							<div
								class="absolute top-0 bottom-0 w-[2px] bg-blue-500 z-20 -translate-x-1/2"
								style="left: {getNowLinePercent()}%"
							></div>
						</div>
					</div>

					<!-- Gray hover-line (continuous across all rows) -->
					{#if hoverPercent !== null}
						<div class="absolute top-0 bottom-0 flex pointer-events-none" style="left: 0; right: 0;">
							<div class="w-44 shrink-0"></div>
							<div class="flex-1 relative">
								<div
									class="absolute top-0 bottom-0 w-[1px] bg-foreground/30 z-30 -translate-x-1/2"
									style="left: {hoverPercent}%"
								></div>
							</div>
						</div>
					{/if}

					<!-- Rows -->
					<div class="space-y-1">
						{#each selectedTimezones as entry, rowIndex}
							<div class="group relative flex items-center gap-0">
								<!-- Remove button -->
								<div class="w-6 shrink-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
									<button
										type="button"
										onclick={() => removeTimezoneAt(rowIndex)}
										class="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
									>
										<X class="h-3.5 w-3.5" />
									</button>
								</div>

								<!-- Timezone label -->
								<div class="w-38 shrink-0 relative pr-2 h-12 flex flex-col justify-center">
									<div class="font-medium text-sm leading-tight flex items-center gap-1.5">
										{entry.label}
										{#if entry.id === localTz}
											<span class="text-[9px] font-medium text-blue-400 bg-blue-400/10 px-1 py-px rounded">HOME</span>
										{/if}
									</div>
									{#if hoverPercent !== null}
										{@const hovered = getHoveredTime(entry.id, hoverPercent)}
										<div class="text-[11px] text-foreground/80 leading-tight mt-0.5 font-medium">
											{hovered.time} &middot; {hovered.date}
										</div>
									{:else}
										<div class="text-[11px] text-muted-foreground leading-tight mt-0.5">
											{formatTimeWithSeconds(entry.id)} &middot; {getTimezoneAbbr(entry.id)}
										</div>
									{/if}

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
								<!-- svelte-ignore binding_property_non_reactive -->
							<div class="flex-1 relative overflow-x-auto no-scrollbar cells-area">
									<!-- Daylight arc SVG -->
									<svg
										class="absolute inset-0 w-full h-full pointer-events-none"
										viewBox="0 0 100 40"
										preserveAspectRatio="none"
									>
										<path
											d={getDaylightPath(entry.id)}
											fill="url(#daylight-{rowIndex})"
										/>
										<defs>
											<linearGradient id="daylight-{rowIndex}" x1="0" y1="0" x2="0" y2="1">
												<stop offset="0%" stop-color="white" stop-opacity="0.08" />
												<stop offset="100%" stop-color="white" stop-opacity="0.01" />
											</linearGradient>
										</defs>
									</svg>

									<!-- Cells -->
									<div class="flex relative z-10">
										{#each hours as hour}
											{@const tzHour = getHourForTimezone(entry.id, hour)}
											{@const actualHour = getTzHourValue(entry.id, hour)}
											{@const isNow = tzHour.isCurrentHour}
											{@const isMidnight = actualHour === 0}
											<div
												class="flex-1 min-w-[2.75rem] h-10 flex items-center justify-center relative
													{isMidnight ? 'border-l border-l-muted-foreground/50' : 'border-l border-l-border/20'}"
											>
												{#if isMidnight}
													<!-- Day-start marker: dashed line + date label -->
													{@const midnightDate = new Date(now.getTime() + tzHour.dayOffset * 86400000)}
													<div class="absolute left-0 top-0 bottom-0 w-px bg-gradient-to-b from-muted-foreground/60 via-muted-foreground/30 to-muted-foreground/60"></div>
													<span class="absolute -top-4 left-0 text-[9px] font-medium text-muted-foreground whitespace-nowrap bg-background px-0.5 rounded">
														{new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(midnightDate)}
													</span>
												{/if}
												<span class="text-xs font-medium
													{isNow
														? 'text-blue-400'
														: actualHour >= 9 && actualHour < 17
															? 'text-foreground'
															: actualHour >= 22 || actualHour < 6
																? 'text-muted-foreground'
																: 'text-foreground/70'}">
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
