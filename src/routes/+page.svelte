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
	// centerHour = the ref timezone hour at the center of the viewport
	// It's relative to "today midnight" in the ref tz: e.g., 19.5 = 7:30pm today, 43 = 7pm tomorrow
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

	// The range of hours to render: 264 hours (11 days)
	// renderAnchor only updates when centerHour drifts far from it (avoids re-rendering cells on every drag frame)
	const BUFFER = 120;
	const TOTAL_CELLS = 24 + 2 * BUFFER; // 264
	let renderAnchor = $state(0);
	let renderStart = $derived(renderAnchor - BUFFER - 12);
	let renderHours = $derived(Array.from({ length: TOTAL_CELLS }, (_, i) => renderStart + i));

	// Re-anchor when centerHour drifts far enough — only when no transition is in flight
	$effect(() => {
		const drift = Math.abs(centerHour - renderAnchor);
		if (drift > 96 && !smoothPan) {
			renderAnchor = Math.floor(centerHour);
		}
	});

	// translateX to position the strip so centerHour is at viewport center
	let stripTranslateX = $derived((() => {
		const centerPosInStrip = (centerHour - renderStart) * cellWidth;
		return containerWidth / 2 - centerPosInStrip;
	})());

	// Current fractional hour in ref tz (for now-line)
	let currentHourFrac = $derived((() => {
		if (!refTzId) return 0;
		const refNow = new Date(now.toLocaleString('en-US', { timeZone: refTzId }));
		return refNow.getHours() + refNow.getMinutes() / 60 + refNow.getSeconds() / 3600;
	})());

	// Now-line position as pixels from left of cells-area
	let nowLineScreenX = $derived((() => {
		const nowPosInStrip = (currentHourFrac - renderStart) * cellWidth;
		return nowPosInStrip + stripTranslateX;
	})());
	let nowLinePercent = $derived((nowLineScreenX / containerWidth) * 100);
	let nowLineVisible = $derived(nowLinePercent >= 0 && nowLinePercent <= 100);

	// selectedDate follows the center of the viewport
	let viewDayOffset = $derived(Math.floor(centerHour / 24));
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

	// Date carousel: render 61 day pills centered on today, driven by centerHour
	const NAV_DAYS_COUNT = 61;
	const NAV_DAYS_HALF = 30;
	let navPillWidth = $derived(navContainerWidth / 7); // 7 pills visible
	let navDays = $derived(Array.from({ length: NAV_DAYS_COUNT }, (_, i) => {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		d.setDate(d.getDate() + (i - NAV_DAYS_HALF));
		return d;
	}));
	// translateX for date strip: centerHour/24 maps to pill offset from day 0 (today)
	let navStripTranslateX = $derived((() => {
		const centerDayFrac = centerHour / 24; // fractional day offset from today
		const centerPillPos = (centerDayFrac + NAV_DAYS_HALF) * navPillWidth;
		return navContainerWidth / 2 - centerPillPos;
	})());

	const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	function isSameDay(a: Date, b: Date): boolean {
		return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	}

	// Smooth pan: shared by both carousels for < > and goToDate
	let smoothPan = $state(false);

	function smoothNavigate(targetCenter: number) {
		smoothPan = true;
		requestAnimationFrame(() => {
			centerHour = targetCenter;
			setTimeout(() => { smoothPan = false; }, 350);
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

		// Center on current time
		if (refTzId) {
			const refNow = new Date(now.toLocaleString('en-US', { timeZone: refTzId }));
			centerHour = refNow.getHours() + refNow.getMinutes() / 60;
			renderAnchor = Math.floor(centerHour);
		}

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

	function getBaseDate(): Date {
		return now;
	}

	function getHourForTimezone(tz: string, hour: number): { displayHour: number; minutes: number; period: string; isCurrentHour: boolean; dayOffset: number } {
		const base = getBaseDate();
		const offsetMinutes = getTimezoneOffset(tz, base);
		const refOffset = getTimezoneOffset(refTzId, base);
		const refDiffMinutes = offsetMinutes - refOffset;

		const totalMinutes = hour * 60 + refDiffMinutes;
		const tzHour = (((Math.floor(totalMinutes / 60)) % 24) + 24) % 24;
		const minutes = ((totalMinutes % 60) + 60) % 60;
		const dayOffset = Math.floor(totalMinutes / (24 * 60));

		// All cells at the same ref hour represent the same moment in time
		const isCurrentHour = hour === Math.floor(currentHourFrac);

		// For :30/:45 offsets, the cell is shifted right so its visual center
		// is at (tzHour + minutes/60). Round to nearest hour for the label.
		const labelHour = minutes >= 30 ? (tzHour + 1) % 24 : tzHour;
		const displayHour = labelHour % 12 || 12;
		const period = labelHour < 12 ? 'AM' : 'PM';

		return { displayHour, minutes, period, isCurrentHour, dayOffset };
	}

	function getTzHourValue(tz: string, hour: number): number {
		const base = getBaseDate();
		const offsetMinutes = getTimezoneOffset(tz, base);
		const refOffset = getTimezoneOffset(refTzId, base);
		const refDiffMinutes = offsetMinutes - refOffset;
		const totalMinutes = hour * 60 + refDiffMinutes;
		return (((Math.floor(totalMinutes / 60)) % 24) + 24) % 24;
	}

	function getMinuteOffset(tz: string): number {
		const base = getBaseDate();
		const offsetMinutes = getTimezoneOffset(tz, base);
		const refOffset = getTimezoneOffset(refTzId, base);
		const diffMinutes = offsetMinutes - refOffset;
		return ((diffMinutes % 60) + 60) % 60;
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

	function getOffsetCells(tz: string): number {
		return getMinuteOffset(tz) / 60;
	}

	// Cache offset cells per timezone (only changes when timezones change, not on drag)
	let cachedOffsetCells = $derived(
		new Map(selectedTimezones.map(e => [e.id, getOffsetCells(e.id)]))
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
		// Convert screen percent to ref timezone hour
		const screenX = (screenPercent / 100) * containerWidth;
		const refHour = (screenX - stripTranslateX) / cellWidth + renderStart;

		const base = getBaseDate();
		const offsetMinutes = getTimezoneOffset(tz, base);
		const refOffset = getTimezoneOffset(refTzId, base);
		const refDiffMinutes = offsetMinutes - refOffset;
		const totalMinutes = refHour * 60 + refDiffMinutes;
		const dayOffset = Math.floor(totalMinutes / (24 * 60));
		const minuteInDay = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
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

	function getMidnightDateLabel(tz: string, dayOffset: number): { weekday: string; month: string; day: number } {
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
			<div class="flex items-center gap-1">
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
										style="transform: translateX({stripTranslateX + (cachedOffsetCells.get(entry.id) ?? 0) * cellWidth}px)"
									>
										<!-- Daylight arc SVG -->
										<svg
											class="absolute top-0 left-0 pointer-events-none"
											style="width: {TOTAL_CELLS * cellWidth}px; height: 40px"
											viewBox="0 0 100 40"
											preserveAspectRatio="none"
										>
											<path
												d={getDaylightPath(entry.id)}
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
										{#each renderHours as hour}
											{@const tzHour = getHourForTimezone(entry.id, hour)}
											{@const actualHour = getTzHourValue(entry.id, hour)}
											{@const isNow = tzHour.isCurrentHour}
											{@const isMidnight = actualHour === 0}
											<div
												class="h-10 flex items-center justify-center relative shrink-0 z-10
													{isMidnight ? 'border-l-2 border-l-amber-400/70' : 'border-l border-l-border/20'}
													{actualHour >= 22 || actualHour < 6 ? 'bg-black/15' : ''}"
												style="width: {cellWidth}px"
											>
												{#if isMidnight}
													{@const dateLabel = getMidnightDateLabel(entry.id, tzHour.dayOffset)}
													<div class="absolute -top-6 left-1/2 -translate-x-1/2 flex items-center gap-1 text-amber-400 whitespace-nowrap">
														<span class="text-[9px] font-bold leading-none">{dateLabel.weekday}</span>
														<span class="text-[8px] font-medium leading-none text-amber-400/70">{dateLabel.month} {dateLabel.day}</span>
													</div>
												{/if}
												<span class="text-xs font-medium
													{isNow
														? 'text-blue-400'
														: isMidnight
															? 'text-amber-400/90'
															: actualHour >= 9 && actualHour < 17
																? 'text-foreground'
																: actualHour >= 22 || actualHour < 6
																	? 'text-muted-foreground/60'
																	: 'text-foreground/70'}">
													{tzHour.displayHour}{tzHour.period[0].toLowerCase()}
												</span>
												{#if tzHour.dayOffset !== 0}
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
