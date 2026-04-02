<script lang="ts">
	import { onMount, tick } from 'svelte';
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
	import { X, Search, Globe, Plane, ChevronRight, MapPin, Calendar, Plus, LocateFixed, Clock } from '@lucide/svelte';

	// --- Types ---
	interface Leg {
		id: number;
		city: string;       // Display name
		tzId: string;       // IANA timezone
		date: string;       // ISO date string YYYY-MM-DD
	}

	// --- State ---
	let allTimezones: TimezoneInfo[] = $state(getAllTimezones());
	let legs: Leg[] = $state([]);
	let nextLegId = 0;

	// Search state
	let query = $state('');
	let searchResults: SearchResult[] = $state([]);
	let isSearchingRemote = $state(false);
	let searchFocused = $state(false);
	let highlightedIndex = $state(-1);
	let inputEl: HTMLInputElement | undefined = $state();
	let dropdownEl: HTMLDivElement | undefined = $state();
	let remoteSearchTimeout: ReturnType<typeof setTimeout> | null = null;

	// Editing state
	let editingLegId: number | null = $state(null);
	let editingField: 'city' | 'date' | null = $state(null);

	// Timeline state
	let now = $state(new Date());
	let ready = $state(false);

	// --- Derived ---
	let sortedLegs = $derived(
		[...legs].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
	);

	// Timeline: show 72 hours (yesterday/today/tomorrow) centered on now
	const TIMELINE_HOURS = 72;

	let tripSpan = $derived((() => {
		// Start date is just used as reference for hour offsets
		const start = new Date();
		start.setUTCHours(0, 0, 0, 0);
		start.setDate(start.getDate() - 1); // yesterday midnight UTC
		return { startDate: start, days: 3 };
	})());

	let totalHours = TIMELINE_HOURS;

	// For each leg, compute the offset and local time info
	let legTimelines = $derived(sortedLegs.map((leg, i) => {
		const offsetMin = getTimezoneOffset(leg.tzId, new Date(leg.date));
		const abbr = getTimezoneAbbr(leg.tzId, new Date(leg.date));
		const offsetStr = formatOffset(offsetMin);

		// Arrival date as hours from trip start
		const legDate = new Date(leg.date);
		const arrivalHour = (legDate.getTime() - tripSpan.startDate.getTime()) / 3600000;

		// Departure: next leg's arrival or end of timeline
		const nextLeg = sortedLegs[i + 1];
		const departureHour = nextLeg
			? (new Date(nextLeg.date).getTime() - tripSpan.startDate.getTime()) / 3600000
			: arrivalHour + 24;

		return {
			...leg,
			offsetMin,
			abbr,
			offsetStr,
			arrivalHour,
			departureHour,
		};
	}));

	// Now position as hours from trip start
	let nowHourFromStart = $derived(
		(now.getTime() - tripSpan.startDate.getTime()) / 3600000
	);

	// --- Parsing ---
	// Parse input like "sfo apr 3" or "london apr 5" or just "tokyo"
	function parseQuery(raw: string): { city: string; date: string | null } {
		const trimmed = raw.trim();

		// Try to extract a date-like portion at the end
		// Patterns: "apr 3", "apr 10", "april 3", "4/3", "2026-04-03"
		const monthNames: Record<string, number> = {
			jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
			apr: 3, april: 3, may: 4, jun: 5, june: 5,
			jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
			oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
		};

		// Match "city month day" pattern
		const monthDayMatch = trimmed.match(/^(.+?)\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|september|oct|october|nov|november|dec|december)\s+(\d{1,2})$/i);
		if (monthDayMatch) {
			const city = monthDayMatch[1].trim();
			const month = monthNames[monthDayMatch[2].toLowerCase()];
			const day = parseInt(monthDayMatch[3]);
			const year = new Date().getFullYear();
			const d = new Date(year, month, day);
			// If the date is in the past, assume next year
			if (d < new Date()) d.setFullYear(year + 1);
			return { city, date: d.toISOString().split('T')[0] };
		}

		// Match "city m/d" pattern
		const slashMatch = trimmed.match(/^(.+?)\s+(\d{1,2})\/(\d{1,2})$/);
		if (slashMatch) {
			const city = slashMatch[1].trim();
			const month = parseInt(slashMatch[2]) - 1;
			const day = parseInt(slashMatch[3]);
			const year = new Date().getFullYear();
			const d = new Date(year, month, day);
			if (d < new Date()) d.setFullYear(year + 1);
			return { city, date: d.toISOString().split('T')[0] };
		}

		return { city: trimmed, date: null };
	}

	// --- Search ---
	function handleSearch() {
		const { city } = parseQuery(query);
		if (!city) {
			searchResults = [];
			return;
		}
		const local = searchTimezones(city, allTimezones);
		searchResults = local;
		highlightedIndex = local.length > 0 ? 0 : -1;

		// Remote search if few local results
		if (local.length < 3 && city.length >= 2) {
			if (remoteSearchTimeout) clearTimeout(remoteSearchTimeout);
			isSearchingRemote = true;
			remoteSearchTimeout = setTimeout(async () => {
				const remote = await searchTimezonesRemote(city, allTimezones);
				const localIds = new Set(searchResults.map(r => r.tz.id + (r.displayName || '')));
				const merged = [...searchResults, ...remote.filter(r => !localIds.has(r.tz.id + (r.displayName || '')))];
				searchResults = merged.slice(0, 15);
				isSearchingRemote = false;
			}, 300);
		}
	}

	function selectResult(result: SearchResult) {
		const { date } = parseQuery(query);
		const cityName = result.displayName?.split(',')[0] || result.tz.city;

		if (editingLegId !== null) {
			// Update existing leg
			legs = legs.map(l => l.id === editingLegId
				? { ...l, city: cityName, tzId: result.tz.id, ...(date ? { date } : {}) }
				: l
			);
			editingLegId = null;
			editingField = null;
		} else {
			// Add new leg
			const defaultDate = date || (() => {
				if (sortedLegs.length === 0) {
					return new Date().toISOString().split('T')[0];
				}
				// Default to last leg's date + 2 days
				const last = new Date(sortedLegs[sortedLegs.length - 1].date);
				last.setDate(last.getDate() + 2);
				return last.toISOString().split('T')[0];
			})();

			legs = [...legs, { id: nextLegId++, city: cityName, tzId: result.tz.id, date: defaultDate }];
		}

		query = '';
		searchResults = [];
		searchFocused = false;
		syncUrl();
	}

	function removeLeg(id: number) {
		legs = legs.filter(l => l.id !== id);
		syncUrl();
	}

	function editLegCity(id: number) {
		editingLegId = id;
		editingField = 'city';
		const leg = legs.find(l => l.id === id);
		if (leg) query = leg.city;
		tick().then(() => {
			inputEl?.focus();
			searchFocused = true;
			handleSearch();
		});
	}

	function updateLegDate(id: number, newDate: string) {
		legs = legs.map(l => l.id === id ? { ...l, date: newDate } : l);
		syncUrl();
	}

	// --- Keyboard ---
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightedIndex = Math.min(highlightedIndex + 1, searchResults.length - 1);
			scrollToHighlighted();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightedIndex = Math.max(highlightedIndex - 1, 0);
			scrollToHighlighted();
		} else if (e.key === 'Enter' && highlightedIndex >= 0 && searchResults[highlightedIndex]) {
			e.preventDefault();
			selectResult(searchResults[highlightedIndex]);
		} else if (e.key === 'Escape') {
			searchFocused = false;
			editingLegId = null;
			editingField = null;
			query = '';
		}
	}

	function scrollToHighlighted() {
		tick().then(() => {
			const el = dropdownEl?.querySelector(`[data-index="${highlightedIndex}"]`);
			el?.scrollIntoView({ block: 'nearest' });
		});
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (document.activeElement === inputEl || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === '/') {
			e.preventDefault();
			inputEl?.focus();
		}
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest('.search-container')) {
			searchFocused = false;
			if (editingLegId !== null) {
				editingLegId = null;
				editingField = null;
				query = '';
			}
		}
	}

	// --- URL sync ---
	function syncUrl() {
		if (legs.length === 0) {
			goto('/travel', { replaceState: true });
			return;
		}
		const param = legs.map(l => `${encodeURIComponent(l.city)}:${l.tzId}:${l.date}`).join(',');
		goto(`/travel?legs=${param}`, { replaceState: true });
	}

	function loadFromUrl() {
		const param = $page.url.searchParams.get('legs');
		if (!param) return;
		const parsed = param.split(',').map(s => {
			const parts = s.split(':');
			if (parts.length < 3) return null;
			const city = decodeURIComponent(parts[0]);
			const tzId = parts.slice(1, -1).join(':'); // handle tz IDs with colons? unlikely but safe
			const date = parts[parts.length - 1];
			try {
				Intl.DateTimeFormat(undefined, { timeZone: tzId });
			} catch {
				return null;
			}
			return { id: nextLegId++, city, tzId, date };
		}).filter((l): l is Leg => l !== null);
		if (parsed.length > 0) legs = parsed;
	}

	// --- Formatting helpers ---
	function formatDateShort(dateStr: string): string {
		const d = new Date(dateStr + 'T12:00:00');
		return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
	}

	function formatDateFull(dateStr: string): string {
		const d = new Date(dateStr + 'T12:00:00');
		return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
	}

	function formatLocalTime(tzId: string, date: Date): string {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: tzId,
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
		}).format(date);
	}

	function getLocalTimeAtHour(tzId: string, utcHour: number): string {
		const d = new Date(tripSpan.startDate);
		d.setTime(d.getTime() + utcHour * 3600000);
		return formatLocalTime(tzId, d);
	}

	function getTimeDiff(tz1: string, tz2: string, date: Date): string {
		const off1 = getTimezoneOffset(tz1, date);
		const off2 = getTimezoneOffset(tz2, date);
		const diff = (off2 - off1) / 60;
		const sign = diff >= 0 ? '+' : '';
		return `${sign}${diff}h`;
	}

	// Night blocks for a timezone — returns left/width percentages (horizontal)
	function getNightBlocks(tzId: string, startHour: number, endHour: number): { left: number; width: number }[] {
		const offsetMinutes = getTimezoneOffset(tzId, new Date());
		const blocks: { left: number; width: number }[] = [];
		const range = endHour - startHour;
		let blockStart: number | null = null;

		for (let h = startHour; h <= endHour; h += 0.5) {
			const localHour = (((h * 60 + offsetMinutes) / 60) % 24 + 24) % 24;
			const isNight = localHour >= 22 || localHour < 6;

			if (isNight && blockStart === null) {
				blockStart = h;
			} else if (!isNight && blockStart !== null) {
				blocks.push({
					left: ((blockStart - startHour) / range) * 100,
					width: ((h - blockStart) / range) * 100,
				});
				blockStart = null;
			}
		}
		if (blockStart !== null) {
			blocks.push({
				left: ((blockStart - startHour) / range) * 100,
				width: ((endHour - blockStart) / range) * 100,
			});
		}
		return blocks;
	}

	// Daylight arc SVG path — cosine curve peaking at 1pm local time
	function getDaylightPath(tzId: string, startHour: number, endHour: number): string {
		const offsetMinutes = getTimezoneOffset(tzId, new Date());
		const range = endHour - startHour;
		const height = 40;
		const maxArc = height * 0.65;
		const sampleRate = 4; // samples per hour
		const totalSamples = range * sampleRate;
		const points: { x: number; y: number }[] = [];

		for (let i = 0; i <= totalSamples; i++) {
			const utcHour = startHour + (i / sampleRate);
			const continuousLocalHour = (utcHour * 60 + offsetMinutes) / 60;
			// Full day cosine peaking at 1pm
			const radians = ((continuousLocalHour - 13) / 24) * Math.PI * 2;
			const val = (Math.cos(radians) + 1) / 2;
			const x = ((utcHour - startHour) / range) * 100;
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

	// Time labels along the X axis
	function getTimeLabels(startHour: number, endHour: number): { hour: number; label: string; dateLabel: string | null }[] {
		const labels: { hour: number; label: string; dateLabel: string | null }[] = [];
		const step = 6;
		for (let h = Math.ceil(startHour / step) * step; h <= endHour; h += step) {
			const date = new Date(tripSpan.startDate.getTime() + h * 3600000);
			const utcHour = date.getUTCHours();
			const dateStr = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', weekday: 'short' }).format(date);
			labels.push({
				hour: h,
				label: `${utcHour}:00`,
				dateLabel: utcHour === 0 ? dateStr : null,
			});
		}
		return labels;
	}

	// --- Lifecycle ---
	onMount(() => {
		loadFromUrl();
		ready = true;
		const interval = setInterval(() => { now = new Date(); }, 60000);
		return () => clearInterval(interval);
	});

	let showDropdown = $derived(searchFocused && query.length > 0 && (searchResults.length > 0 || isSearchingRemote));
</script>

<svelte:window
	onkeydown={handleGlobalKeydown}
	onclick={handleClickOutside}
/>

<svelte:head>
	<title>Travel — Timezone</title>
</svelte:head>

<div class="h-screen bg-background text-foreground flex flex-col select-none overflow-hidden {ready ? '' : 'invisible'}">
	<!-- Header -->
	<div class="flex flex-col items-center pt-8 max-sm:pt-4 pb-6 max-sm:pb-3 px-4">
		<div class="flex items-center gap-3 mb-2">
			<Plane class="h-6 w-6 max-sm:h-5 max-sm:w-5 text-muted-foreground" strokeWidth={1.5} />
			<h1 class="text-2xl max-sm:text-xl font-light tracking-[0.3em] text-muted-foreground">TRAVEL</h1>
		</div>
		<a href="/" class="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors mb-6">
			← back to timezone
		</a>

		<!-- Search box -->
		<div class="w-full max-w-4xl">
			<div class="search-container relative">
				<div
					class="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 transition-colors focus-within:border-muted-foreground/50 overflow-hidden"
				>
					<Search class="h-4 w-4 text-muted-foreground shrink-0" />
					<input
						bind:this={inputEl}
						bind:value={query}
						oninput={handleSearch}
						onkeydown={handleKeydown}
						onfocus={() => (searchFocused = true)}
						type="text"
						placeholder={legs.length === 0
							? 'Where are you going? Try "london apr 5"'
							: 'Add next stop... e.g. "mumbai apr 10"'}
						class="flex-1 min-w-[120px] bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none select-text"
					/>
					{#if query}
						<button
							type="button"
							onclick={() => { query = ''; searchResults = []; }}
							class="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
						>
							<X class="h-3 w-3" />
						</button>
					{/if}
				</div>

				{#if showDropdown}
					<div
						bind:this={dropdownEl}
						class="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-popover shadow-lg max-h-64 overflow-y-auto z-50"
					>
						{#each searchResults as result, i}
							<button
								data-index={i}
								type="button"
								onclick={() => selectResult(result)}
								class="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center justify-between {highlightedIndex === i ? 'bg-accent' : ''}"
							>
								<span class="flex items-center gap-2">
									<MapPin class="h-3.5 w-3.5 text-muted-foreground shrink-0" />
									<span class="font-medium text-secondary-foreground">{result.displayName || result.tz.city}</span>
								</span>
								<span class="text-xs text-muted-foreground">
									{getTimezoneAbbr(result.tz.id)} · {formatOffset(getTimezoneOffset(result.tz.id))}
								</span>
							</button>
						{/each}
						{#if isSearchingRemote}
							<div class="px-3 py-2 text-xs text-muted-foreground">Searching...</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Parse hint -->
			{#if query && !showDropdown}
				{@const parsed = parseQuery(query)}
				{#if parsed.date}
					<div class="mt-1 text-xs text-muted-foreground px-1">
						Searching for <span class="font-medium text-secondary-foreground">{parsed.city}</span> on <span class="font-medium text-secondary-foreground">{formatDateFull(parsed.date)}</span>
					</div>
				{/if}
			{/if}
		</div>

		<!-- Itinerary chips -->
		{#if sortedLegs.length > 0}
			<div class="flex items-center gap-1.5 mt-5 flex-wrap justify-center max-w-4xl w-full">
				{#each sortedLegs as leg, i}
					{#if i > 0}
						<ChevronRight class="h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mx-0.5" />
					{/if}
					<div class="group inline-flex items-center gap-0 rounded-md bg-secondary text-sm transition-all hover:bg-secondary/80">
						<button
							type="button"
							onclick={() => editLegCity(leg.id)}
							class="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 transition-colors rounded-l-md hover:bg-accent"
						>
							<span class="text-secondary-foreground">{leg.city}</span>
						</button>
						<span class="w-px h-4 bg-border/50"></span>
						<label class="flex items-center gap-1.5 pl-2 pr-1.5 py-1.5 cursor-pointer hover:bg-accent transition-colors">
							<Calendar class="h-3 w-3 text-muted-foreground/50" />
							<input
								type="date"
								value={leg.date}
								onchange={(e) => updateLegDate(leg.id, (e.target as HTMLInputElement).value)}
								class="bg-transparent text-xs text-muted-foreground w-[90px] outline-none cursor-pointer hover:text-secondary-foreground transition-colors"
							/>
						</label>
						<button
							type="button"
							onclick={() => removeLeg(leg.id)}
							class="p-1 mr-0.5 rounded text-muted-foreground/30 hover:text-secondary-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100"
						>
							<X class="h-3 w-3" />
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Timeline visualization — horizontal: time on X (left→right), cities as rows on Y -->
	{#if sortedLegs.length >= 2}
		{@const timelineStart = 0}
		{@const timelineEnd = TIMELINE_HOURS}
		{@const timelineRange = TIMELINE_HOURS}
		{@const timeLabels = getTimeLabels(timelineStart, timelineEnd)}
		{@const nowPct = ((nowHourFromStart - timelineStart) / timelineRange) * 100}
		{@const nowInRange = nowPct >= 0 && nowPct <= 100}
		{@const homeTz = sortedLegs[0].tzId}
		{@const allRows = [...legTimelines, { id: -1, city: 'Body Clock', tzId: homeTz, date: sortedLegs[0].date, offsetMin: getTimezoneOffset(homeTz, new Date(sortedLegs[0].date)), abbr: getTimezoneAbbr(homeTz, new Date(sortedLegs[0].date)), offsetStr: formatOffset(getTimezoneOffset(homeTz, new Date(sortedLegs[0].date))), arrivalHour: legTimelines[0].arrivalHour, departureHour: legTimelines[legTimelines.length - 1].departureHour, isBodyClock: true }]}

		<div class="flex-1 flex flex-col px-4 max-sm:px-2 pb-2 max-w-6xl mx-auto w-full min-h-0">
			<!-- X-axis: time labels (top) -->
			<div class="relative h-6 ml-44 max-sm:ml-0 shrink-0 mb-1">
				{#each timeLabels as label}
					{@const pct = ((label.hour - timelineStart) / timelineRange) * 100}
					{#if pct >= 0 && pct <= 100}
						<div
							class="absolute bottom-0 -translate-x-1/2"
							style="left: {pct}%"
						>
							{#if label.dateLabel}
								<div class="text-[9px] text-muted-foreground/70 font-medium whitespace-nowrap">{label.dateLabel}</div>
							{/if}
							<div class="text-[10px] text-muted-foreground/40 tabular-nums">{label.label}</div>
						</div>
					{/if}
				{/each}
			</div>

			<!-- Rows -->
			<div class="flex flex-col flex-1 min-h-0 gap-1">
				{#each allRows as row, rowIdx}
					{@const isBodyClock = 'isBodyClock' in row && row.isBodyClock}
					{@const nightBlocks = getNightBlocks(row.tzId, timelineStart, timelineEnd)}
					{@const arrivalPct = Math.max(0, ((row.arrivalHour - timelineStart) / timelineRange) * 100)}
					{@const departurePct = Math.min(100, ((row.departureHour - timelineStart) / timelineRange) * 100)}
					{@const stayWidth = departurePct - arrivalPct}
					{@const timeDiff = rowIdx > 0 && !isBodyClock ? getTimeDiff(legTimelines[0].tzId, row.tzId, new Date(row.date)) : null}

					<!-- Separator before body clock -->
					{#if isBodyClock}
						<div class="border-t border-border/20 mt-1 pt-1"></div>
					{/if}

					<div class="flex items-stretch gap-0 flex-1 min-h-0">
						<!-- Row label -->
						<div class="w-44 max-sm:hidden shrink-0 flex flex-col justify-center pr-3 text-right">
							{#if isBodyClock}
								<div class="text-xs font-medium text-amber-500/60 flex items-center justify-end gap-1">
									<Clock class="h-3 w-3" />
									Body Clock
								</div>
								<div class="text-[10px] text-muted-foreground/50">{sortedLegs[0].city} time</div>
							{:else}
								<div class="font-medium text-sm text-secondary-foreground truncate">{row.city}</div>
								<div class="text-[10px] text-muted-foreground/50">
									{row.abbr} · {row.offsetStr}
								</div>
								{#if timeDiff}
									<div class="text-[9px] text-muted-foreground/40">{timeDiff}</div>
								{/if}
							{/if}
						</div>

						<!-- Horizontal strip -->
						<div
							class="relative flex-1 rounded-lg overflow-hidden {isBodyClock ? 'border border-dashed border-amber-500/20' : 'border border-border/50'} bg-card"
						>
							<!-- Night blocks -->
							{#each nightBlocks as block}
								<div
									class="absolute inset-y-0 {isBodyClock ? 'bg-amber-500/[0.06]' : 'bg-foreground/[0.04]'}"
									style="left: {block.left}%; width: {block.width}%"
								></div>
							{/each}

							<!-- Daylight arc -->
							<svg
								class="absolute inset-0 w-full h-full pointer-events-none"
								viewBox="0 0 100 40"
								preserveAspectRatio="none"
							>
								<path
									d={getDaylightPath(row.tzId, timelineStart, timelineEnd)}
									fill={isBodyClock ? 'rgb(245, 158, 11)' : 'white'}
									fill-opacity={isBodyClock ? 0.08 : 0.06}
									stroke={isBodyClock ? 'rgb(245, 158, 11)' : 'white'}
									stroke-opacity={isBodyClock ? 0.15 : 0.1}
									stroke-width="0.4"
								/>
							</svg>

							<!-- Hour gridlines -->
							{#each timeLabels as label}
								{@const pct = ((label.hour - timelineStart) / timelineRange) * 100}
								{#if pct > 1 && pct < 99}
									<div
										class="absolute inset-y-0 w-px {isBodyClock ? 'bg-amber-500/10' : 'bg-border/30'}"
										style="left: {pct}%"
									></div>
									<!-- Local time at this gridline -->
									<div
										class="absolute bottom-0.5 text-[9px] -translate-x-1/2 {isBodyClock ? 'text-amber-500/30' : 'text-muted-foreground/30'}"
										style="left: {pct}%"
									>
										{getLocalTimeAtHour(row.tzId, label.hour)}
									</div>
								{/if}
							{/each}

							<!-- Stay period highlight (not for body clock) -->
							{#if !isBodyClock}
								<div
									class="absolute inset-y-0 border-x-2 border-blue-500/30 bg-blue-500/[0.08]"
									style="left: {arrivalPct}%; width: {stayWidth}%"
								>
									<div class="absolute top-0.5 left-1 text-[9px] font-medium text-blue-400/70">
										{getLocalTimeAtHour(row.tzId, row.arrivalHour)}
									</div>
									<div class="absolute top-0.5 right-1 text-[8px] text-blue-400/50">
										{formatDateShort(row.date)}
									</div>
								</div>
							{/if}

							<!-- Now line (vertical) -->
							{#if nowInRange}
								<div
									class="absolute inset-y-0 w-px bg-red-500/60"
									style="left: {nowPct}%"
								></div>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			<!-- Legend -->
			<div class="mt-2 flex items-center gap-4 text-[10px] text-muted-foreground/50 justify-center shrink-0">
				<span class="flex items-center gap-1">
					<span class="w-3 h-3 rounded-sm bg-blue-500/[0.15] border border-blue-500/30"></span>
					Your stay
				</span>
				<span class="flex items-center gap-1">
					<span class="w-3 h-3 rounded-sm bg-foreground/[0.04]"></span>
					Night (local)
				</span>
				<span class="flex items-center gap-1">
					<span class="w-3 h-3 rounded-sm bg-amber-500/[0.08] border border-dashed border-amber-500/20"></span>
					Body clock
				</span>
				<span class="flex items-center gap-1">
					<span class="w-px h-3 bg-red-500/60"></span>
					Now
				</span>
			</div>
		</div>

	{:else if sortedLegs.length === 1}
		<div class="flex-1 flex flex-col items-center justify-center text-muted-foreground/50 gap-2 pb-20">
			<Plane class="h-8 w-8 mb-2" />
			<p class="text-sm">Add your next destination to see the timeline</p>
			<p class="text-xs">Try typing a city and date, like "london apr 5"</p>
		</div>

	{:else}
		<div class="flex-1 flex flex-col items-center justify-center text-muted-foreground/50 gap-2 pb-20">
			<Globe class="h-8 w-8 mb-2" />
			<p class="text-sm">Plan your trip across timezones</p>
			<p class="text-xs">Start by adding your first stop — e.g. "san francisco apr 3"</p>
		</div>
	{/if}
</div>
