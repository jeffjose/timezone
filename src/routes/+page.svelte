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
	let calendarOpen = $state(false);

	// Carousel state
	// centerHour = UTC fractional hours since UTC midnight today
	// All internal positioning uses UTC. Each timezone row shifts its strip
	// by its UTC offset so local hour boundaries align correctly.
	let centerHour = $state(0);
	let isDragging = $state(false);
	let isDraggingNav = $state(false);
	let dragStartX = $state(0);
	let dragStartCenter = $state(0);
	let containerWidth = $state(1); // measured on mount
	let navContainerWidth = $state(1); // measured on mount

	// Derived
	let showDropdown = $derived(searchFocused && query.length > 0 && (searchResults.length > 0 || isSearchingRemote));
	let selectedIds = $derived(selectedTimezones.map((t) => t.id));
	let refTzId = $derived(selectedTimezones[0]?.id);
	let cellWidth = $derived(containerWidth / 24);

	// The range of UTC hours to render: 264 hours (11 days)
	const BUFFER = 120;
	const TOTAL_CELLS = 24 + 2 * BUFFER; // 264
	let renderAnchor = $state(0);
	let renderStart = $derived(renderAnchor - BUFFER - 12);
	let renderHours = $derived(Array.from({ length: TOTAL_CELLS }, (_, i) => renderStart + i));

	// Re-anchor when centerHour drifts far enough — only when idle
	$effect(() => {
		const drift = Math.abs(centerHour - renderAnchor);
		if (drift > 96 && !smoothPan && !isDragging && !isDraggingNav) {
			renderAnchor = Math.floor(centerHour);
		}
	});

	// Base translateX in UTC space — positions the strip so centerHour is at viewport center
	let stripTranslateX = $derived((() => {
		const centerPosInStrip = (centerHour - renderStart) * cellWidth;
		return containerWidth / 2 - centerPosInStrip;
	})());


	// Current UTC fractional hour (for now-line)
	let currentHourFrac = $derived((() => {
		const n = now;
		return n.getUTCHours() + n.getUTCMinutes() / 60 + n.getUTCSeconds() / 3600;
	})());

	// Now-line position — in UTC space, same for all rows
	let nowLineScreenX = $derived((() => {
		const nowPosInStrip = (currentHourFrac - renderStart) * cellWidth;
		return nowPosInStrip + stripTranslateX;
	})());
	let nowLinePercent = $derived((nowLineScreenX / containerWidth) * 100);
	let nowLineVisible = $derived(nowLinePercent >= 0 && nowLinePercent <= 100);

	// selectedDate follows the center of the viewport, in ref tz local time
	let viewDayOffset = $derived((() => {
		if (!refTzId) return 0;
		const refOffsetHours = getTimezoneOffset(refTzId, offsetBase) / 60;
		return Math.floor((centerHour + refOffsetHours) / 24);
	})());
	let selectedDate = $derived((() => {
		const d = new Date();
		d.setDate(d.getDate() + viewDayOffset);
		d.setHours(0, 0, 0, 0);
		return d;
	})());

	let isToday = $derived(viewDayOffset === 0);
	let calendarValue = $derived(
		new CalendarDate(selectedDate.getFullYear(), selectedDate.getMonth() + 1, selectedDate.getDate())
	);

	// Date carousel: 61 pills with reanchoring (like the grid)
	const NAV_DAYS_COUNT = 61;
	const NAV_DAYS_HALF = 30;
	let navAnchorDay = $state(0); // day offset from today that the nav is centered on
	let navPillWidth = $derived(navContainerWidth / 7); // 7 pills visible
	let navDays = $derived(Array.from({ length: NAV_DAYS_COUNT }, (_, i) => {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		d.setDate(d.getDate() + navAnchorDay + (i - NAV_DAYS_HALF));
		return d;
	}));

	// Reanchor nav when we drift >20 days from the anchor
	$effect(() => {
		const currentDay = viewDayOffset;
		const drift = Math.abs(currentDay - navAnchorDay);
		if (drift > 20 && !smoothPan && !isDragging && !isDraggingNav) {
			navAnchorDay = currentDay;
		}
	});

	// translateX for date strip — uses viewDayOffset (ref tz local days)
	let navStripTranslateX = $derived((() => {
		if (!refTzId) return 0;
		const refOffsetHours = getTimezoneOffset(refTzId, offsetBase) / 60;
		const localHourFrac = centerHour + refOffsetHours;
		const centerDayFrac = localHourFrac / 24;
		const pillIndexFromStart = centerDayFrac - navAnchorDay + NAV_DAYS_HALF;
		const centerPillPos = pillIndexFromStart * navPillWidth;
		return navContainerWidth / 2 - centerPillPos;
	})());

	const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	function isSameDay(a: Date, b: Date): boolean {
		return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	}

	// Smooth pan: shared by both carousels for < > and goToDate
	let smoothPan = $state(false);
	let smoothPanTimer: ReturnType<typeof setTimeout> | null = null;

	function smoothNavigate(targetCenter: number) {
		if (smoothPanTimer) clearTimeout(smoothPanTimer);
		smoothPan = true;
		requestAnimationFrame(() => {
			centerHour = targetCenter;
			smoothPanTimer = setTimeout(() => {
				smoothPan = false;
				smoothPanTimer = null;
			}, 350);
		});
	}

	function shiftView(hours: number) {
		smoothNavigate(centerHour + hours);
	}

	function goToDate(date: Date) {
		if (isSameDay(date, selectedDate)) { calendarOpen = false; return; }
		const target = new Date(date);
		target.setHours(0, 0, 0, 0);
		const todayDate = new Date();
		todayDate.setHours(0, 0, 0, 0);
		const targetDayOffset = Math.round((target.getTime() - todayDate.getTime()) / 86400000);
		// Keep the same time-of-day within the target day
		const hourInDay = ((centerHour % 24) + 24) % 24;
		calendarOpen = false;
		smoothNavigate(targetDayOffset * 24 + hourInDay);
	}

	function goToday() {
		smoothNavigate(currentHourFrac);
	}

	// Drag to pan (grid)
	function handleDragStart(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('button')) return;
		isDragging = true;
		dragStartX = e.clientX;
		dragStartCenter = centerHour;
	}

	// Drag to pan (date nav)
	function handleNavDragStart(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('button')) return;
		isDraggingNav = true;
		dragStartX = e.clientX;
		dragStartCenter = centerHour;
	}

	function handleDragMove(e: MouseEvent) {
		if (isDragging) {
			const dx = e.clientX - dragStartX;
			centerHour = dragStartCenter - dx / cellWidth;
		} else if (isDraggingNav) {
			const dx = e.clientX - dragStartX;
			// 1 pill = 24 hours, so scale by pillWidth/24 = cellWidth equivalent for nav
			centerHour = dragStartCenter - (dx / navPillWidth) * 24;
		}
	}

	function handleDragEnd() {
		isDragging = false;
		isDraggingNav = false;
	}

	onMount(async () => {
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

		// Center on current UTC time
		centerHour = now.getUTCHours() + now.getUTCMinutes() / 60;
		renderAnchor = Math.floor(centerHour);

		// Measure containers after DOM renders
		let ro: ResizeObserver | undefined;
		await tick();
		const measure = () => {
			const cellsEl = document.querySelector('.cells-area');
			if (cellsEl) containerWidth = cellsEl.clientWidth;
			const navEl = document.querySelector('.nav-carousel-area');
			if (navEl) navContainerWidth = navEl.clientWidth;
		};
		measure();
		ro = new ResizeObserver(measure);
		const cellsEl = document.querySelector('.cells-area');
		if (cellsEl) ro.observe(cellsEl);
		const navEl = document.querySelector('.nav-carousel-area');
		if (navEl) ro.observe(navEl);

		const interval = setInterval(() => {
			now = new Date();
		}, 1000);

		return () => { clearInterval(interval); ro?.disconnect(); };
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

			if (localResults.length < 3 && query.length >= 2) {
				isSearchingRemote = true;
				remoteSearchTimeout = setTimeout(async () => {
					const currentQuery = query;
					const remoteResults = await searchTimezonesRemote(currentQuery, allTimezones);
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
		if (e.key === '/') {
			e.preventDefault();
			inputEl?.focus();
			return;
		}
		if (e.key.length === 1) {
			e.preventDefault();
			inputEl?.focus();
			query += e.key;
			handleSearch();
		}
	}

	// Stable date for offset calculations — NOT reactive to `now`.
	// Only needs to reflect the day we're viewing (DST boundaries).
	// Updated rarely: on mount + when selectedDate changes.
	let offsetBase = new Date();
	$effect(() => {
		// Re-derive when the viewed day changes (for DST correctness)
		void selectedDate;
		offsetBase = new Date(selectedDate);
	});

	// The UTC cell that the now-line falls in, per timezone.
	// For :30 timezones, the strip shift means the visually-correct cell
	// is floor(currentHourFrac - fracOffset).
	let cachedNowCell = $derived(
		new Map(selectedTimezones.map(e => {
			const frac = cachedFractionalOffsets.get(e.id) ?? 0;
			return [e.id, Math.floor(currentHourFrac - frac)];
		}))
	);

	// Cell = UTC hour. All rows share the same grid (no per-row strip shift).
	// Label shows local time at that UTC hour.
	// Per-timezone fractional cell offset for :30/:45 timezones
	// Shifts the strip so cell boundaries align with local hour boundaries
	function getFractionalOffset(tz: string): number {
		const offsetMinutes = getTimezoneOffset(tz, offsetBase);
		return ((offsetMinutes % 60) + 60) % 60 / 60;
	}
	let cachedFractionalOffsets = $derived(
		new Map(selectedTimezones.map(e => [e.id, getFractionalOffset(e.id)]))
	);

	function getHourForTimezone(tz: string, utcHour: number): { displayHour: number; period: string; dayOffset: number } {
		const offsetMinutes = getTimezoneOffset(tz, offsetBase);
		const localTotalMinutes = utcHour * 60 + offsetMinutes;
		const localHour = (((Math.floor(localTotalMinutes / 60)) % 24) + 24) % 24;
		const minutes = ((localTotalMinutes % 60) + 60) % 60;
		const dayOffset = Math.floor(localTotalMinutes / (24 * 60));

		// For :30/:45 offsets, strip is shifted so cell centers align with local hours.
		// Round label to the hour at the cell center.
		const labelHour = minutes >= 30 ? (localHour + 1) % 24 : localHour;
		// If rounding pushed us past midnight (23→0), we've crossed into the next day
		const adjustedDayOffset = (minutes >= 30 && localHour === 23) ? dayOffset + 1 : dayOffset;
		const displayHour = labelHour % 12 || 12;
		const period = labelHour < 12 ? 'AM' : 'PM';

		return { displayHour, period, dayOffset: adjustedDayOffset };
	}

	function getTzHourValue(tz: string, utcHour: number): number {
		const offsetMinutes = getTimezoneOffset(tz, offsetBase);
		const localTotalMinutes = utcHour * 60 + offsetMinutes;
		const localHour = (((Math.floor(localTotalMinutes / 60)) % 24) + 24) % 24;
		const minutes = ((localTotalMinutes % 60) + 60) % 60;
		// Round to the hour at the cell center (matches label for :30/:45 timezones)
		return minutes >= 30 ? (localHour + 1) % 24 : localHour;
	}

	// Daylight arc SVG path spanning all rendered cells
	function getDaylightPath(tz: string): string {
		const points: { x: number; y: number }[] = [];
		const height = 40;
		const maxArc = height * 0.65;
		const steps = TOTAL_CELLS * 2;

		for (let i = 0; i <= steps; i++) {
			const hourIndex = i / 2;
			const hour = renderStart + hourIndex;
			// Get the actual tz hour (0-23) for this position
			const actualHour = getTzHourValue(tz, Math.floor(hour));
			const frac = hour - Math.floor(hour);
			const continuousHour = actualHour + frac;
			// Cosine peaks at 13 (1pm)
			const radians = ((continuousHour - 13) / 24) * Math.PI * 2;
			const val = (Math.cos(radians) + 1) / 2;
			const x = (hourIndex / TOTAL_CELLS) * 100;
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

	// Cache daylight paths — only recompute when renderAnchor or timezones change, not on drag
	let cachedDaylightPaths = $derived(
		new Map(selectedTimezones.map(e => [e.id, getDaylightPath(e.id)]))
	);

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

	function getHoveredTime(tz: string, screenPercent: number): { time: string; date: string } {
		// Convert screen percent to UTC hour, accounting for fractional strip offset
		const fracOffset = cachedFractionalOffsets.get(tz) ?? 0;
		const screenX = (screenPercent / 100) * containerWidth;
		const utcHour = (screenX - stripTranslateX - fracOffset * cellWidth) / cellWidth + renderStart;

		const offsetMinutes = getTimezoneOffset(tz, offsetBase);
		const localTotalMinutes = utcHour * 60 + offsetMinutes;
		const dayOffset = Math.floor(localTotalMinutes / (24 * 60));
		const minuteInDay = ((localTotalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
		const h = Math.floor(minuteInDay / 60);
		const m = Math.round(minuteInDay % 60);
		const displayHour = h % 12 || 12;
		const period = h < 12 ? 'AM' : 'PM';
		const time = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;

		const todayDate = new Date();
		todayDate.setHours(0, 0, 0, 0);
		const hoveredDate = new Date(todayDate.getTime() + dayOffset * 86400000);
		const date = new Intl.DateTimeFormat('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(hoveredDate);

		return { time, date };
	}

	function handleCellsMouseMove(e: MouseEvent) {
		if (isDragging) return;
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

	// Day colors — blue for today, cycling non-blue colors for other days.
	const TODAY_COLOR = { bg: 'rgba(59, 130, 246, 0.08)', border: 'rgba(59, 130, 246, 0.5)', text: 'rgb(59, 130, 246)' };
	const OTHER_DAY_COLORS = [
		{ bg: 'rgba(168, 85, 247, 0.08)', border: 'rgba(168, 85, 247, 0.5)', text: 'rgb(168, 85, 247)' },    // purple-500
		{ bg: 'rgba(20, 184, 166, 0.08)', border: 'rgba(20, 184, 166, 0.5)', text: 'rgb(20, 184, 166)' },    // teal-500
		{ bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.5)', text: 'rgb(245, 158, 11)' },    // amber-500
		{ bg: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.5)', text: 'rgb(239, 68, 68)' },       // red-500
		{ bg: 'rgba(34, 197, 94, 0.08)', border: 'rgba(34, 197, 94, 0.5)', text: 'rgb(34, 197, 94)' },       // green-500
		{ bg: 'rgba(236, 72, 153, 0.08)', border: 'rgba(236, 72, 153, 0.5)', text: 'rgb(236, 72, 153)' },    // pink-500
	];

	function getDayColor(dayOffset: number) {
		if (dayOffset === 0) return TODAY_COLOR;
		// Offset by -1 so dayOffset 1 and -1 get different colors
		const idx = dayOffset > 0 ? dayOffset - 1 : OTHER_DAY_COLORS.length + dayOffset;
		return OTHER_DAY_COLORS[((idx % OTHER_DAY_COLORS.length) + OTHER_DAY_COLORS.length) % OTHER_DAY_COLORS.length];
	}

	function getMidnightDateLabel(dayOffset: number): { weekday: string; month: string; day: number } {
		const todayDate = new Date();
		todayDate.setHours(0, 0, 0, 0);
		const d = new Date(todayDate.getTime() + dayOffset * 86400000);
		const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d).toUpperCase();
		const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d).toUpperCase();
		const day = d.getDate();
		return { weekday, month, day };
	}

	function formatNavDay(d: Date): { dayNum: string; weekday: string; isWeekend: boolean; isToday: boolean } {
		const dayNum = String(d.getDate());
		const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
		const dow = d.getDay();
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		return { dayNum, weekday, isWeekend: dow === 0 || dow === 6, isToday: isSameDay(d, today) };
	}
</script>

<svelte:window
	onkeydown={handleGlobalKeydown}
	onclick={handleClickOutside}
	onmousemove={handleDragMove}
	onmouseup={handleDragEnd}
/>

<svelte:head>
	<title>Timezone</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground flex flex-col select-none">
	<!-- Header -->
	<div class="flex flex-col items-center pt-8 pb-6 px-4">
		<div class="flex items-center gap-3 mb-6">
			<Globe class="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
			<h1 class="text-2xl font-light tracking-[0.3em] text-muted-foreground">TIMEZONE</h1>
		</div>

		<!-- Search + Date nav -->
		<div class="w-full max-w-4xl flex flex-col gap-3">
			<!-- Search box -->
			<div class="search-container relative">
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
						class="flex-1 min-w-[80px] bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none select-text"
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
			<div class="flex items-center gap-1 self-end">
				<button
					type="button"
					onclick={() => shiftView(-24)}
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

				<!-- Date carousel (minimap) -->
				<div
					class="nav-carousel-area relative overflow-hidden select-none w-64"
					style="cursor: {isDraggingNav ? 'grabbing' : 'grab'}"
					onmousedown={handleNavDragStart}
					role="presentation"
				>
					<div
						class="flex will-change-transform {smoothPan ? 'transition-transform duration-300 ease-in-out' : ''}"
						style="transform: translateX({navStripTranslateX}px)"
					>
						{#each navDays as navDay}
							{@const info = formatNavDay(navDay)}
							{@const isSelected = isSameDay(navDay, selectedDate)}
							<button
								type="button"
								onclick={() => goToDate(navDay)}
								class="flex flex-col items-center shrink-0 py-0.5 rounded-md text-xs transition-colors
									{isSelected
										? 'bg-primary text-primary-foreground'
										: info.isToday
											? 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25'
											: info.isWeekend
												? 'text-muted-foreground/60 hover:bg-accent'
												: 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
								style="width: {navPillWidth}px"
							>
								<span class="text-[9px] leading-tight font-medium">{info.weekday}</span>
								<span class="text-sm font-semibold leading-tight">{info.dayNum}</span>
							</button>
						{/each}
					</div>
				</div>

				<button
					type="button"
					onclick={() => shiftView(24)}
					class="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
				>
					<ChevronRight class="h-4 w-4" />
				</button>

				<button
					type="button"
					onclick={goToday}
					class="p-1 rounded-md transition-colors {Math.abs(centerHour - currentHourFrac) < 0.5
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
				<!-- Blue dot above the grid -->
				{#if nowLineVisible}
					<div class="flex">
						<div class="w-44 shrink-0"></div>
						<div class="flex-1 relative">
							<div
								class="absolute -top-3 w-[10px] h-[10px] rounded-full bg-blue-500 z-20 -translate-x-1/2"
								style="left: {nowLinePercent}%"
							></div>
						</div>
					</div>
				{/if}

				<!-- Grid -->
				<div
					class="relative overflow-hidden"
					onmousemove={handleCellsMouseMove}
					onmouseleave={handleCellsMouseLeave}
					onmousedown={handleDragStart}
					role="presentation"
					style="cursor: {isDragging ? 'grabbing' : 'grab'}"
				>
					<!-- Blue now-line -->
					{#if nowLineVisible}
						<div class="absolute top-0 bottom-0 flex pointer-events-none" style="left: 0; right: 0;">
							<div class="w-44 shrink-0"></div>
							<div class="flex-1 relative">
								<div
									class="absolute top-0 bottom-0 w-[2px] bg-blue-500 z-20 -translate-x-1/2"
									style="left: {nowLinePercent}%"
								></div>
							</div>
						</div>
					{/if}

					<!-- Gray hover-line -->
					{#if hoverPercent !== null && !isDragging}
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
									{#if hoverPercent !== null && !isDragging}
										{@const hovered = getHoveredTime(entry.id, hoverPercent)}
										<div class="text-[11px] text-foreground/80 leading-tight mt-0.5 font-medium">
											{hovered.date} &middot; {hovered.time}
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

								<!-- Hour cells - infinite carousel -->
								<!-- svelte-ignore binding_property_non_reactive -->
								<div
									class="flex-1 relative overflow-hidden cells-area select-none"
								>
									<div
										class="relative flex will-change-transform {smoothPan ? 'transition-transform duration-300 ease-in-out' : ''}"
										style="transform: translateX({stripTranslateX + (cachedFractionalOffsets.get(entry.id) ?? 0) * cellWidth}px)"
									>
										<!-- Daylight arc SVG -->
										<svg
											class="absolute top-0 left-0 pointer-events-none"
											style="width: {TOTAL_CELLS * cellWidth}px; height: 40px"
											viewBox="0 0 100 40"
											preserveAspectRatio="none"
										>
											<path
												d={cachedDaylightPaths.get(entry.id) ?? ''}
												fill="url(#daylight-{rowIndex})"
												stroke="rgba(255,255,255,0.15)"
												stroke-width="0.4"
												vector-effect="non-scaling-stroke"
											/>
											<defs>
												<linearGradient id="daylight-{rowIndex}" x1="0" y1="0" x2="0" y2="1">
													<stop offset="0%" stop-color="white" stop-opacity="0.12" />
													<stop offset="100%" stop-color="white" stop-opacity="0.02" />
												</linearGradient>
											</defs>
										</svg>
										{#each renderHours as hour (hour)}
											{@const tzHour = getHourForTimezone(entry.id, hour)}
											{@const actualHour = getTzHourValue(entry.id, hour)}
											{@const isNow = hour === (cachedNowCell.get(entry.id) ?? -1)}
											{@const isMidnight = actualHour === 0}
											{@const dayColor = getDayColor(tzHour.dayOffset)}
											<div
												class="h-10 flex items-center justify-center relative shrink-0 z-10
													{isMidnight ? 'border-l-2' : 'border-l border-l-border/20'}"
												style="width: {cellWidth}px; background: {dayColor.bg}; {isMidnight ? `border-left-color: ${dayColor.border}` : ''}"
											>
												{#if isMidnight}
													{@const dateLabel = getMidnightDateLabel(tzHour.dayOffset)}
													<div class="flex flex-col items-center gap-0">
														<span class="text-[8px] font-semibold uppercase tracking-wider leading-none" style="color: {dayColor.text}">{dateLabel.month}</span>
														<span class="text-[15px] font-bold leading-tight" style="color: {dayColor.text}">{dateLabel.day}</span>
													</div>
												{:else}
													<span class="text-xs font-medium
														{isNow
															? 'text-blue-400'
															: actualHour >= 9 && actualHour < 17
																? 'text-foreground'
																: actualHour >= 22 || actualHour < 6
																	? 'text-muted-foreground/60'
																	: 'text-foreground/70'}">
														{tzHour.displayHour}{tzHour.period[0].toLowerCase()}
													</span>
												{/if}
												{#if tzHour.dayOffset !== 0 && !isMidnight}
													<span class="absolute top-0.5 right-0.5 text-[9px] font-medium text-muted-foreground/60">
														{tzHour.dayOffset > 0 ? `+${tzHour.dayOffset}` : tzHour.dayOffset}
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
