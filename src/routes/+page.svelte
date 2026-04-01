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
		searchTimezonesRemote,
		type TimezoneInfo,
		type SearchResult,
	} from '$lib/timezones';
	import { X, ChevronUp, ChevronDown, Search, Globe, ChevronLeft, ChevronRight, CalendarDays, Dot } from '@lucide/svelte';
	import * as Popover from '$lib/components/ui/popover';
	import { Calendar } from '$lib/components/ui/calendar';
	import { CalendarDate, today, getLocalTimeZone } from '@internationalized/date';

	interface SelectedTz {
		id: string;
		label: string;
	}

	// State
	let allTimezones: TimezoneInfo[] = $state([]);
	let selectedTimezones: SelectedTz[] = $state([]);
	let query = $state('');
	let searchResults: SearchResult[] = $state([]);
	let remoteSearchTimeout: ReturnType<typeof setTimeout> | null = null;
	let isSearchingRemote = $state(false);
	let searchFocused = $state(false);
	let highlightedIndex = $state(-1);
	let inputEl: HTMLInputElement | undefined = $state();
	let now = $state(new Date());
	let dropdownEl: HTMLDivElement | undefined = $state();
	let hoverPercent: number | null = $state(null);
	let gridOpacity = $state(1);

	// Selected date for the grid (defaults to today)
	let selectedDate: Date = $state(new Date());
	let calendarOpen = $state(false);

	// Derived
	let showDropdown = $derived(searchFocused && query.length > 0 && (searchResults.length > 0 || isSearchingRemote));
	let selectedIds = $derived(selectedTimezones.map((t) => t.id));
	let refTzId = $derived(selectedTimezones[0]?.id);
	let isToday = $derived(isSameDay(selectedDate, new Date()));

	// Calendar value for shadcn calendar
	let calendarValue = $derived(
		new CalendarDate(selectedDate.getFullYear(), selectedDate.getMonth() + 1, selectedDate.getDate())
	);

	// Days to show in the quick-nav bar
	let navDays = $derived(getNavDays(selectedDate));

	const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const hours = Array.from({ length: 24 }, (_, i) => i);

	function isSameDay(a: Date, b: Date): boolean {
		return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	}

	function getNavDays(centerDate: Date): Date[] {
		const days: Date[] = [];
		for (let i = -2; i <= 4; i++) {
			const d = new Date(centerDate);
			d.setDate(d.getDate() + i);
			days.push(d);
		}
		return days;
	}

	function animateDateChange(fn: () => void) {
		gridOpacity = 0;
		setTimeout(() => {
			fn();
			gridOpacity = 1;
		}, 120);
	}

	function goToDate(date: Date) {
		if (isSameDay(date, selectedDate)) return;
		animateDateChange(() => {
			selectedDate = new Date(date);
		});
		calendarOpen = false;
	}

	function goToday() {
		if (isToday) return;
		animateDateChange(() => {
			selectedDate = new Date();
		});
	}

	function shiftDate(days: number) {
		animateDateChange(() => {
			const d = new Date(selectedDate);
			d.setDate(d.getDate() + days);
			selectedDate = d;
		});
	}

	onMount(() => {
		allTimezones = getAllTimezones();

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
		if (remoteSearchTimeout) clearTimeout(remoteSearchTimeout);
		isSearchingRemote = false;

		if (query.trim().length > 0) {
			const localResults = searchTimezones(query, allTimezones);
			searchResults = localResults;
			highlightedIndex = localResults.length > 0 ? 0 : -1;

			// Debounced remote fallback if local results are sparse
			if (localResults.length < 3 && query.length >= 2) {
				isSearchingRemote = true;
				remoteSearchTimeout = setTimeout(async () => {
					const currentQuery = query;
					const remoteResults = await searchTimezonesRemote(currentQuery, allTimezones);
					// Only apply if query hasn't changed
					if (query !== currentQuery) return;
					isSearchingRemote = false;
					if (remoteResults.length > 0) {
						const seen = new Set(localResults.map((r) => r.tz.id + (r.displayName || '')));
						const merged = [...localResults];
						for (const r of remoteResults) {
							const key = r.tz.id + (r.displayName || '');
							if (!seen.has(key)) {
								seen.add(key);
								merged.push(r);
							}
						}
						searchResults = merged.slice(0, 20);
						if (highlightedIndex < 0 && searchResults.length > 0) highlightedIndex = 0;
					}
				}, 300);
			}
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

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (document.activeElement === inputEl || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key.length === 1) {
			e.preventDefault();
			inputEl?.focus();
			query += e.key;
			handleSearch();
		}
	}

	// Use selectedDate as the base for hour calculations (not now)
	function getBaseDate(): Date {
		if (isToday) return now;
		// Use noon of selectedDate to avoid DST edge cases
		const d = new Date(selectedDate);
		d.setHours(12, 0, 0, 0);
		return d;
	}

	function getHourForTimezone(tz: string, hour: number): { displayHour: number; period: string; isCurrentHour: boolean; dayOffset: number } {
		const base = getBaseDate();
		const offsetMinutes = getTimezoneOffset(tz, base);
		const refOffset = getTimezoneOffset(refTzId, base);
		const refDiff = offsetMinutes - refOffset;

		const tzHour = ((hour + Math.round(refDiff / 60)) % 24 + 24) % 24;
		const dayOffset = Math.floor((hour + Math.round(refDiff / 60)) / 24);

		let isCurrentHour = false;
		if (isToday) {
			const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
			isCurrentHour = tzHour === nowInTz.getHours();
		}

		const displayHour = tzHour % 12 || 12;
		const period = tzHour < 12 ? 'AM' : 'PM';

		return { displayHour, period, isCurrentHour, dayOffset };
	}

	function getNowLinePercent(): number {
		if (!refTzId || !isToday) return -1;
		const nowInRef = new Date(now.toLocaleString('en-US', { timeZone: refTzId }));
		return ((nowInRef.getHours() + nowInRef.getMinutes() / 60) / 24) * 100;
	}

	function getTzHourValue(tz: string, hour: number): number {
		const base = getBaseDate();
		const offsetMinutes = getTimezoneOffset(tz, base);
		const refOffset = getTimezoneOffset(refTzId, base);
		const refDiff = offsetMinutes - refOffset;
		return ((hour + Math.round(refDiff / 60)) % 24 + 24) % 24;
	}

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

	function getHoveredTime(tz: string, percent: number): { time: string; date: string } {
		const base = getBaseDate();
		const refHour = (percent / 100) * 24;
		const offsetMinutes = getTimezoneOffset(tz, base);
		const refOffset = getTimezoneOffset(refTzId, base);
		const refDiff = offsetMinutes - refOffset;
		const tzHourRaw = refHour + Math.round(refDiff / 60);
		const dayOffset = Math.floor(tzHourRaw / 24);
		const tzHour = ((tzHourRaw % 24) + 24) % 24;
		const h = Math.floor(tzHour);
		const m = Math.round((tzHour - h) * 60);
		const displayHour = h % 12 || 12;
		const period = h < 12 ? 'AM' : 'PM';
		const time = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;

		const hoveredDate = new Date(selectedDate.getTime() + dayOffset * 86400000);
		const date = new Intl.DateTimeFormat('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(hoveredDate);

		return { time, date };
	}

	function handleCellsMouseMove(e: MouseEvent) {
		const container = e.currentTarget as HTMLElement;
		const cellsEl = container.querySelector('.cells-area');
		if (!cellsEl) return;
		const rect = cellsEl.getBoundingClientRect();
		hoverPercent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
	}

	function handleCellsMouseLeave() {
		hoverPercent = null;
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest('.search-container')) {
			searchFocused = false;
		}
	}

	// Get date for a given timezone at midnight cell
	function getMidnightDateLabel(tz: string, dayOffset: number): { weekday: string; month: string; day: number } {
		const d = new Date(selectedDate.getTime() + dayOffset * 86400000);
		const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d).toUpperCase();
		const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d).toUpperCase();
		const day = d.getDate();
		return { weekday, month, day };
	}

	function formatNavDay(d: Date): { dayNum: string; weekday: string; isWeekend: boolean } {
		const dayNum = String(d.getDate());
		const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
		const dow = d.getDay();
		return { dayNum, weekday, isWeekend: dow === 0 || dow === 6 };
	}

	function formatNavMonth(d: Date): string {
		return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} onclick={handleClickOutside} />

<svelte:head>
	<title>Timezone</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground flex flex-col">
	<!-- Header -->
	<div class="flex flex-col items-center pt-8 pb-6 px-4">
		<div class="flex items-center gap-3 mb-6">
			<Globe class="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
			<h1 class="text-2xl font-light tracking-[0.3em] text-muted-foreground">TIMEZONE</h1>
		</div>

		<!-- Search + Date nav row -->
		<div class="w-full max-w-4xl flex items-center gap-4">
			<!-- Search box -->
			<div class="search-container relative flex-1">
				<div
					class="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 transition-colors focus-within:border-muted-foreground/50 overflow-hidden"
				>
					<Search class="h-4 w-4 text-muted-foreground shrink-0" />

					{#each selectedTimezones.slice(0, 3) as entry, i}
						<span
							class="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-sm text-secondary-foreground shrink-0"
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

					{#if selectedTimezones.length > 3}
						<span class="text-xs text-muted-foreground shrink-0">
							+{selectedTimezones.length - 3}
						</span>
					{/if}

					<input
						bind:this={inputEl}
						bind:value={query}
						oninput={handleSearch}
						onkeydown={handleKeydown}
						onfocus={() => (searchFocused = true)}
						type="text"
						placeholder={selectedTimezones.length === 0 ? 'Search timezones...' : 'Add timezone...'}
						class="flex-1 min-w-[80px] bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
					/>
				</div>

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
								<span class="font-medium">{result.displayName || result.tz.city}</span>
								<span class="text-muted-foreground text-xs">
									{formatTimeWithSeconds(result.tz.id)} &middot; {getTimezoneAbbr(result.tz.id)}
								</span>
							</button>
						{/each}
						{#if isSearchingRemote}
							<div class="px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
								<div class="h-3 w-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin"></div>
								Searching more cities...
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Date navigator -->
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={() => shiftDate(-1)}
					class="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
				>
					<ChevronLeft class="h-4 w-4" />
				</button>

				<!-- Calendar popover -->
				<Popover.Root bind:open={calendarOpen}>
					<Popover.Trigger class="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
						<CalendarDays class="h-4 w-4" />
					</Popover.Trigger>
					<Popover.Content class="w-auto p-0" align="center">
						<Calendar
							type="single"
							value={calendarValue}
							onValueChange={(v) => {
								if (v) {
									goToDate(new Date(v.year, v.month - 1, v.day));
								}
							}}
						/>
					</Popover.Content>
				</Popover.Root>

				<!-- Quick day nav -->
				{#each navDays as navDay}
					{@const info = formatNavDay(navDay)}
					{@const isSelected = isSameDay(navDay, selectedDate)}
					{@const isDayToday = isSameDay(navDay, new Date())}
					<button
						type="button"
						onclick={() => goToDate(navDay)}
						class="flex flex-col items-center min-w-[2.25rem] px-1 py-0.5 rounded-md text-xs transition-colors
							{isSelected
								? 'bg-primary text-primary-foreground'
								: isDayToday
									? 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25'
									: info.isWeekend
										? 'text-muted-foreground/60 hover:bg-accent'
										: 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
					>
						<span class="text-[9px] leading-tight font-medium">{info.weekday}</span>
						<span class="text-sm font-semibold leading-tight">{info.dayNum}</span>
					</button>
				{/each}

				<button
					type="button"
					onclick={() => shiftDate(1)}
					class="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
				>
					<ChevronRight class="h-4 w-4" />
				</button>

				<!-- Today button (always present, highlighted when not on today) -->
				<button
					type="button"
					onclick={goToday}
					class="p-1 rounded-md transition-colors {isToday
						? 'text-muted-foreground/30 cursor-default'
						: 'text-blue-400 hover:bg-blue-500/15'}"
					title="Go to today"
				>
					<Dot class="h-5 w-5" strokeWidth={6} />
				</button>
			</div>
		</div>
	</div>

	<!-- Timezone rows -->
	{#if selectedTimezones.length > 0}
		<div class="flex-1 px-4 pb-8">
			<div class="max-w-6xl mx-auto">
				<!-- Blue dot above the grid (only when viewing today) -->
				{#if isToday}
					<div class="flex">
						<div class="w-44 shrink-0"></div>
						<div class="flex-1 relative">
							<div
								class="absolute -top-3 w-[10px] h-[10px] rounded-full bg-blue-500 z-20 -translate-x-1/2"
								style="left: {getNowLinePercent()}%"
							></div>
						</div>
					</div>
				{/if}

				<!-- Grid with lines overlay -->
				<div
					class="relative transition-opacity duration-150"
					style="opacity: {gridOpacity}"
					onmousemove={handleCellsMouseMove}
					onmouseleave={handleCellsMouseLeave}
					role="presentation"
				>
					<!-- Blue now-line (only when viewing today) -->
					{#if isToday && getNowLinePercent() >= 0}
						<div class="absolute top-0 bottom-0 flex pointer-events-none" style="left: 0; right: 0;">
							<div class="w-44 shrink-0"></div>
							<div class="flex-1 relative">
								<div
									class="absolute top-0 bottom-0 w-[2px] bg-blue-500 z-20 -translate-x-1/2"
									style="left: {getNowLinePercent()}%"
								></div>
							</div>
						</div>
					{/if}

					<!-- Gray hover-line -->
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
											{hovered.date} &middot; {hovered.time}
										</div>
									{:else}
										<div class="text-[11px] text-muted-foreground leading-tight mt-0.5">
											{#if isToday}
												{formatTimeWithSeconds(entry.id)} &middot; {getTimezoneAbbr(entry.id)}
											{:else}
												{getTimezoneAbbr(entry.id)} &middot; {formatOffset(getTimezoneOffset(entry.id, getBaseDate()))}
											{/if}
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
													{isMidnight ? 'border-l border-l-muted-foreground/40' : 'border-l border-l-border/20'}"
											>
												{#if isMidnight}
													{@const dateLabel = getMidnightDateLabel(entry.id, tzHour.dayOffset)}
													<div class="absolute -top-5 left-0 flex flex-col items-center text-muted-foreground whitespace-nowrap">
														<span class="text-[8px] font-semibold leading-none">{dateLabel.weekday}</span>
														<span class="text-[9px] font-medium leading-tight">{dateLabel.month} {dateLabel.day}</span>
													</div>
													<div class="absolute left-0 top-0 bottom-0 w-px bg-muted-foreground/40"></div>
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
