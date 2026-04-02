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
	import { X, Search, Globe, Plane, ChevronRight, ChevronUp, ChevronDown, MapPin, Calendar, Plus, LocateFixed } from '@lucide/svelte';

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
	let hoverPct: number | null = $state(null);

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

	// For each leg, compute the offset and local time info (uses legs order, not date-sorted)
	let legTimelines = $derived(legs.map((leg, i) => {
		const offsetMin = getTimezoneOffset(leg.tzId, new Date(leg.date));
		const abbr = getTimezoneAbbr(leg.tzId, new Date(leg.date));
		const offsetStr = formatOffset(offsetMin);

		// Arrival date as hours from trip start
		const legDate = new Date(leg.date);
		const arrivalHour = (legDate.getTime() - tripSpan.startDate.getTime()) / 3600000;

		// Departure: find next leg by date order
		const datesSorted = [...legs].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
		const myDateIdx = datesSorted.findIndex(l => l.id === leg.id);
		const nextByDate = datesSorted[myDateIdx + 1];
		const departureHour = nextByDate
			? (new Date(nextByDate.date).getTime() - tripSpan.startDate.getTime()) / 3600000
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
				if (legs.length === 0) {
					return new Date().toISOString().split('T')[0];
				}
				// Default to last leg's date + 2 days
				const last = new Date(legs[legs.length - 1].date);
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

	// --- Geolocation ---
	let locatingCity = $state(false);

	async function handlePinpoint() {
		if (!navigator.geolocation) return;
		locatingCity = true;
		navigator.geolocation.getCurrentPosition(async (pos) => {
			try {
				const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json&zoom=10`);
				const data = await res.json();
				const city = data.address?.city || data.address?.town || data.address?.village;
				if (city) {
					const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
					// Add as first leg if no legs, or update first leg
					const defaultDate = new Date().toISOString().split('T')[0];
					if (legs.length === 0) {
						legs = [{ id: nextLegId++, city, tzId: localTz, date: defaultDate }];
					} else {
						// Check if local tz already exists
						const existing = legs.find(l => l.tzId === localTz);
						if (existing) {
							legs = legs.map(l => l.id === existing.id ? { ...l, city } : l);
						} else {
							legs = [{ id: nextLegId++, city, tzId: localTz, date: defaultDate }, ...legs];
						}
					}
					syncUrl();
				}
			} catch {} finally {
				locatingCity = false;
			}
		}, () => { locatingCity = false; }, { timeout: 5000 });
	}

	// --- Reorder ---
	function moveLeg(index: number, direction: -1 | 1) {
		const copy = [...legs];
		const newIndex = index + direction;
		if (newIndex < 0 || newIndex >= copy.length) return;
		[copy[index], copy[newIndex]] = [copy[newIndex], copy[index]];
		legs = copy;
		syncUrl();
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

	function getTimeDiff(tz1: string, tz2: string, date: Date): string {
		const off1 = getTimezoneOffset(tz1, date);
		const off2 = getTimezoneOffset(tz2, date);
		const diff = (off2 - off1) / 60;
		const sign = diff >= 0 ? '+' : '';
		return `${sign}${diff}h`;
	}

	// Day colors — blue for today, cycling for other days (matching main app)
	const DAY_COLORS = [
		{ r: 59, g: 130, b: 246 },   // blue-500 (today)
		{ r: 168, g: 85, b: 247 },   // purple-500
		{ r: 20, g: 184, b: 166 },   // teal-500
		{ r: 245, g: 158, b: 11 },   // amber-500
		{ r: 239, g: 68, b: 68 },    // red-500
		{ r: 34, g: 197, b: 94 },    // green-500
		{ r: 236, g: 72, b: 153 },   // pink-500
	];

	function getDayColor(dayOffset: number): { r: number; g: number; b: number } {
		if (dayOffset === 0) return DAY_COLORS[0]; // today = blue
		const idx = dayOffset > 0 ? dayOffset : DAY_COLORS.length + dayOffset;
		return DAY_COLORS[((idx) % (DAY_COLORS.length - 1)) + 1];
	}

	// Per-day daylight arc segments — returns one path + color per day
	function getDaylightArcs(tzId: string, startHour: number, endHour: number): { path: string; strokePath: string; color: { r: number; g: number; b: number }; dayOffset: number }[] {
		const offsetMinutes = getTimezoneOffset(tzId, new Date());
		const range = endHour - startHour;
		const height = 40;
		const maxArc = height * 0.65;
		const sampleRate = 8;

		// Figure out which days are covered
		const todayStart = new Date();
		todayStart.setHours(0, 0, 0, 0);

		// Find midnight boundaries in this timezone within the range
		const startLocalHour = (startHour * 60 + offsetMinutes) / 60;
		const firstMidnight = Math.ceil(startLocalHour / 24) * 24;
		const firstMidnightUtc = (firstMidnight * 60 - offsetMinutes) / 60;

		// Collect day boundaries (as UTC hours from trip start)
		const dayBoundaries: number[] = [startHour];
		for (let utcH = firstMidnightUtc; utcH < endHour; utcH += 24) {
			if (utcH > startHour) dayBoundaries.push(utcH);
		}
		dayBoundaries.push(endHour);

		const arcs: { path: string; strokePath: string; color: { r: number; g: number; b: number }; dayOffset: number }[] = [];

		for (let d = 0; d < dayBoundaries.length - 1; d++) {
			const segStart = dayBoundaries[d];
			const segEnd = dayBoundaries[d + 1];
			const samples = Math.ceil((segEnd - segStart) * sampleRate);
			if (samples < 2) continue;

			// Determine day offset from today
			const midUtcHour = (segStart + segEnd) / 2;
			const absDate = new Date(tripSpan.startDate.getTime() + midUtcHour * 3600000);
			const absDayStart = new Date(absDate);
			absDayStart.setHours(0, 0, 0, 0);
			const dayOffset = Math.round((absDayStart.getTime() - todayStart.getTime()) / 86400000);
			const color = getDayColor(dayOffset);

			const points: { x: number; y: number }[] = [];
			for (let i = 0; i <= samples; i++) {
				const utcHour = segStart + (i / samples) * (segEnd - segStart);
				const continuousLocalHour = (utcHour * 60 + offsetMinutes) / 60;
				const radians = ((continuousLocalHour - 13) / 24) * Math.PI * 2;
				const val = (Math.cos(radians) + 1) / 2;
				const x = ((utcHour - startHour) / range) * 100;
				const y = height - val * maxArc;
				points.push({ x, y });
			}

			// Stroke path (just the curve)
			let strokeD = `M ${points[0].x} ${points[0].y}`;
			for (let i = 1; i < points.length; i++) {
				const prev = points[i - 1];
				const curr = points[i];
				const cpx = (prev.x + curr.x) / 2;
				strokeD += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
			}

			// Fill path (closed to baseline)
			const fillD = strokeD + ` L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;

			arcs.push({ path: fillD, strokePath: strokeD, color, dayOffset });
		}

		return arcs;
	}

	// Time labels along the X axis — in the reference (top row) timezone
	function getTimeLabels(startHour: number, endHour: number, refTzId: string): { hour: number; label: string; dateLabel: string | null }[] {
		const labels: { hour: number; label: string; dateLabel: string | null }[] = [];
		const offsetMinutes = getTimezoneOffset(refTzId, new Date());
		const step = 6;

		// Find the first gridline aligned to a 6-hour boundary in local time
		const firstLocalHour = (startHour * 60 + offsetMinutes) / 60;
		const firstAligned = Math.ceil(firstLocalHour / step) * step;
		const firstUtcHour = (firstAligned * 60 - offsetMinutes) / 60;

		for (let utcH = firstUtcHour; utcH <= endHour; utcH += step) {
			const absDate = new Date(tripSpan.startDate.getTime() + utcH * 3600000);
			const localTime = new Intl.DateTimeFormat('en-US', {
				timeZone: refTzId,
				hour: 'numeric',
				hour12: true,
			}).format(absDate);
			const localHourVal = Math.round(((utcH * 60 + offsetMinutes) / 60 % 24 + 24) % 24);
			const isLocalMidnight = localHourVal === 0 || localHourVal === 24;
			const dateStr = isLocalMidnight
				? new Intl.DateTimeFormat('en-US', { timeZone: refTzId, month: 'short', day: 'numeric', weekday: 'short' }).format(absDate)
				: null;
			labels.push({
				hour: utcH,
				label: localTime,
				dateLabel: dateStr,
			});
		}
		return labels;
	}

	// Midnight positions for a timezone within the timeline (as percentages)
	function getMidnightPositions(tzId: string, startHour: number, endHour: number): { pct: number; label: string; color: { r: number; g: number; b: number } }[] {
		const offsetMinutes = getTimezoneOffset(tzId, new Date());
		const range = endHour - startHour;
		const todayStart = new Date();
		todayStart.setHours(0, 0, 0, 0);
		const results: { pct: number; label: string; color: { r: number; g: number; b: number } }[] = [];

		const startLocalHour = (startHour * 60 + offsetMinutes) / 60;
		const firstMidnight = Math.ceil(startLocalHour / 24) * 24;
		const firstUtcHour = (firstMidnight * 60 - offsetMinutes) / 60;

		for (let utcH = firstUtcHour; utcH < endHour; utcH += 24) {
			const pct = ((utcH - startHour) / range) * 100;
			if (pct > 1 && pct < 99) {
				const absDate = new Date(tripSpan.startDate.getTime() + utcH * 3600000);
				const label = new Intl.DateTimeFormat('en-US', { timeZone: tzId, month: 'short', day: 'numeric', weekday: 'short' }).format(absDate);
				// Day offset: the day starting at this midnight
				const dayStart = new Date(absDate);
				dayStart.setHours(0, 0, 0, 0);
				const dayOffset = Math.round((dayStart.getTime() - todayStart.getTime()) / 86400000);
				const color = getDayColor(dayOffset);
				results.push({ pct, label, color });
			}
		}
		return results;
	}

	// --- Hover ---
	function handleTimelineMouseMove(e: MouseEvent) {
		const cellsEl = (e.currentTarget as HTMLElement).querySelector('.cells-area');
		if (!cellsEl) return;
		const rect = cellsEl.getBoundingClientRect();
		hoverPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
	}

	function handleTimelineMouseLeave() {
		hoverPct = null;
	}

	function getHoveredTimeForTz(tzId: string, pct: number): { time: string; date: string } {
		const utcHour = (pct / 100) * TIMELINE_HOURS;
		const absDate = new Date(tripSpan.startDate.getTime() + utcHour * 3600000);
		const time = new Intl.DateTimeFormat('en-US', {
			timeZone: tzId,
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
		}).format(absDate);
		const date = new Intl.DateTimeFormat('en-US', {
			timeZone: tzId,
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(absDate);
		return { time, date };
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
					<button
						type="button"
						onclick={handlePinpoint}
						disabled={locatingCity}
						title="Detect my location"
						class="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
					>
						<LocateFixed class="h-4 w-4 {locatingCity ? 'animate-pulse' : ''}" />
					</button>
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
		{#if legs.length > 0}
			<div class="flex items-center gap-1.5 mt-5 flex-wrap justify-center max-w-4xl w-full">
				{#each legs as leg, i}
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
	{#if legs.length >= 1}
		{@const homeTz = legs[0].tzId}
		{@const timelineStart = 0}
		{@const timelineEnd = TIMELINE_HOURS}
		{@const timelineRange = TIMELINE_HOURS}
		{@const timeLabels = getTimeLabels(timelineStart, timelineEnd, homeTz)}
		{@const nowPct = ((nowHourFromStart - timelineStart) / timelineRange) * 100}
		{@const nowInRange = nowPct >= 0 && nowPct <= 100}

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="flex-1 flex flex-col px-4 max-sm:px-2 pb-2 max-w-6xl mx-auto w-full min-h-0"
			onmousemove={handleTimelineMouseMove}
			onmouseleave={handleTimelineMouseLeave}
		>
			<!-- Blue dot (now indicator, top) -->
			<div class="relative h-3 ml-44 max-sm:ml-0 shrink-0">
				{#if nowInRange}
					<div
						class="absolute bottom-0 w-[10px] h-[10px] rounded-full bg-blue-500 z-20 -translate-x-1/2 translate-y-1/2 pointer-events-none"
						style="left: {nowPct}%"
					></div>
				{/if}
			</div>

			<!-- Rows + overlays -->
			<div class="flex flex-col relative">
				{#each legTimelines as row, rowIdx}
					{@const timeDiff = rowIdx > 0 ? getTimeDiff(legTimelines[0].tzId, row.tzId, new Date(row.date)) : null}

					<div class="flex items-stretch gap-0" style="height: {legTimelines.length <= 5 ? 40 : Math.max(24, 200 / legTimelines.length)}px"
						<!-- Row label -->
						<div class="group w-44 max-sm:hidden shrink-0 flex items-center justify-end pr-3 relative">
							<!-- Reorder buttons -->
							<div class="absolute left-0 top-1/2 -translate-y-1/2 flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
								{#if rowIdx > 0}
									<button
										type="button"
										onclick={() => moveLeg(rowIdx, -1)}
										class="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
									>
										<ChevronUp class="h-3 w-3" />
									</button>
								{/if}
								{#if rowIdx < legs.length - 1}
									<button
										type="button"
										onclick={() => moveLeg(rowIdx, 1)}
										class="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
									>
										<ChevronDown class="h-3 w-3" />
									</button>
								{/if}
							</div>
							<div class="text-right">
								<div class="flex items-center gap-1.5 justify-end">
									<span class="font-medium text-sm leading-tight truncate">{row.city}</span>
								</div>
								{#if hoverPct !== null}
									{@const hoveredTime = getHoveredTimeForTz(row.tzId, hoverPct)}
									<div class="flex items-baseline gap-1 justify-end mt-0.5">
										<span class="text-xs font-semibold text-foreground">{hoveredTime.time}</span>
										<span class="text-[10px] text-muted-foreground">{hoveredTime.date}</span>
									</div>
								{:else}
									<div class="flex items-baseline gap-1.5 justify-end mt-0.5">
										<span class="text-xs font-semibold text-foreground/90 tabular-nums">{formatLocalTime(row.tzId, now)}</span>
										<span class="text-[10px] text-muted-foreground">{row.abbr}</span>
										<span class="text-[10px] text-muted-foreground/60">{row.offsetStr}</span>
									</div>
									{#if timeDiff}
										<div class="text-[9px] text-muted-foreground/40">{timeDiff}</div>
									{/if}
								{/if}
							</div>
						</div>

						<!-- Horizontal strip -->
						<div class="relative flex-1 overflow-hidden bg-card cells-area {rowIdx < legTimelines.length - 1 ? 'border-b border-border/30' : ''} {rowIdx === 0 ? 'rounded-t-lg' : ''} {rowIdx === legTimelines.length - 1 ? 'rounded-b-lg' : ''}"
						>
							<!-- Daylight arcs (one per day, colored) -->
							<svg
								class="absolute inset-0 w-full h-full pointer-events-none"
								viewBox="0 0 100 40"
								preserveAspectRatio="none"
							>
								<defs>
									{#each getDaylightArcs(row.tzId, timelineStart, timelineEnd) as arc, arcIdx}
										<linearGradient id="day-grad-{rowIdx}-{arcIdx}" x1="0" y1="0" x2="0" y2="1">
											<stop offset="0%" stop-color="rgb({arc.color.r}, {arc.color.g}, {arc.color.b})" stop-opacity="0.15" />
											<stop offset="100%" stop-color="rgb({arc.color.r}, {arc.color.g}, {arc.color.b})" stop-opacity="0.0" />
										</linearGradient>
									{/each}
								</defs>
								{#each getDaylightArcs(row.tzId, timelineStart, timelineEnd) as arc, arcIdx}
									<!-- Filled area -->
									<path
										d={arc.path}
										fill="url(#day-grad-{rowIdx}-{arcIdx})"
									/>
									<!-- Stroke line -->
									<path
										d={arc.strokePath}
										fill="none"
										stroke="rgb({arc.color.r}, {arc.color.g}, {arc.color.b})"
										stroke-opacity="0.4"
										stroke-width="1"
										vector-effect="non-scaling-stroke"
									/>
								{/each}
							</svg>

							<!-- Per-row midnight gridlines (colored) -->
							{#each getMidnightPositions(row.tzId, timelineStart, timelineEnd) as midnight}
								<div
									class="absolute inset-y-0 w-px"
									style="left: {midnight.pct}%; background: rgba({midnight.color.r}, {midnight.color.g}, {midnight.color.b}, 0.3)"
								></div>
								<div
									class="absolute top-1 text-[8px] font-medium"
									style="left: {midnight.pct + 0.5}%; color: rgba({midnight.color.r}, {midnight.color.g}, {midnight.color.b}, 0.5)"
								>
									{midnight.label}
								</div>
							{/each}

							<!-- Now line (blue, vertical) -->
							{#if nowInRange}
								<div
									class="absolute inset-y-0 w-[2px] bg-blue-500 z-20 -translate-x-1/2"
									style="left: {nowPct}%"
								></div>
							{/if}
						</div>
					</div>
				{/each}

				<!-- Gray hover line spanning all rows (desktop only) -->
				{#if hoverPct !== null}
					<div class="absolute top-0 bottom-0 overflow-hidden pointer-events-none max-sm:hidden" style="left: 11rem; right: 0;">
						<div
							class="absolute top-0 bottom-0 w-[1px] bg-foreground/30 z-30 -translate-x-1/2"
							style="left: {hoverPct}%"
						></div>
					</div>
				{/if}
			</div>
		</div>

	{:else}
		<div class="flex-1 flex flex-col items-center justify-center text-muted-foreground/50 gap-2 pb-20">
			<Globe class="h-8 w-8 mb-2" />
			<p class="text-sm">Plan your trip across timezones</p>
			<p class="text-xs">Start by adding your first stop — e.g. "san francisco apr 3"</p>
		</div>
	{/if}
</div>
