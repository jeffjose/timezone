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
	import { X, ChevronUp, ChevronDown, Search, Globe, ChevronLeft, ChevronRight, CalendarDays, Plus, EllipsisVertical, Trash2, Copy, MoveHorizontal, LocateFixed, Briefcase, TrendingUp, Sunset } from '@lucide/svelte';
	import { DropdownMenu } from 'bits-ui';

	interface SelectedTz {
		id: string;
		label: string;
	}

	interface Marker {
		id: number;
		utcHour: number; // fractional UTC hour (start for intervals)
		utcHourEnd: number | null; // null = point marker, number = interval end
		label: string;
		color: string;
	}

	const MARKER_COLORS = ['#f97316', '#a855f7', '#22c55e', '#ec4899', '#06b6d4'];
	let nextMarkerId = 0;

	const localTzInit = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const nowInit = new Date();
	const initCenterHour = nowInit.getUTCHours() + nowInit.getUTCMinutes() / 60;

	// Parse timezones from URL on server+client (no onMount needed)
	function getInitialTimezones(): SelectedTz[] {
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
			if (entries.length > 0) {
				return entries.map((id) => ({ id, label: getCityName(id) }));
			}
		}
		// Fallback to local timezone for SSR (localStorage checked in onMount)
		return [{ id: localTzInit, label: getCityName(localTzInit) }];
	}

	function getInitialMarkers(): Marker[] {
		const mParam = $page.url.searchParams.get('m');
		if (!mParam) return [];
		return mParam.split(',').map((s, i) => {
			const parts = s.split('~');
			const utcHour = parseFloat(parts[0]);
			if (isNaN(utcHour)) return null;
			const utcHourEnd = parts[1] ? parseFloat(parts[1]) : null;
			if (utcHourEnd !== null && isNaN(utcHourEnd)) return null;
			const id = nextMarkerId++;
			return { id, utcHour, utcHourEnd, label: '', color: MARKER_COLORS[i % MARKER_COLORS.length] };
		}).filter((m): m is Marker => m !== null).slice(0, 5);
	}

	// State — initialized eagerly so SSR renders full UI
	let allTimezones: TimezoneInfo[] = $state(getAllTimezones());
	let selectedTimezones: SelectedTz[] = $state(getInitialTimezones());
	let query = $state('');
	let searchResults: SearchResult[] = $state([]);
	let remoteSearchTimeout: ReturnType<typeof setTimeout> | null = null;
	let isSearchingRemote = $state(false);
	let searchFocused = $state(false);
	let locatingCity = $state(false);
	let highlightedIndex = $state(-1);
	let inputEl: HTMLInputElement | undefined = $state();
	let now = $state(nowInit);
	let dropdownEl: HTMLDivElement | undefined = $state();
	let hoverPercent: number | null = $state(null);
	// Carousel state
	// centerHour = UTC fractional hours since UTC midnight today
	// All internal positioning uses UTC. Each timezone row shifts its strip
	// by its UTC offset so local hour boundaries align correctly.
	let centerHour = $state(initCenterHour);
	let isDragging = $state(false);
	let isDraggingNav = $state(false);
	let dragStartX = $state(0);
	let dragStartCenter = $state(0);
	let containerWidth = $state(1); // measured on mount
	let navContainerWidth = $state(1); // measured on mount
	let ready = $state(false);
	let isMobile = $state(false);
	let markers: Marker[] = $state(getInitialMarkers());
	let selectedMarkerId: number | null = $state(null);
	let dragDidMove = $state(false); // distinguish click from drag
	let isDraggingMarker = $state(false);
	let draggingMarkerId: number | null = $state(null);
	let markerDragStartX = $state(0);
	let markerDragStartUtcHour = $state(0);
	// Interval creation via create strip
	let isCreatingInterval = $state(false);
	let createIntervalStart: number | null = $state(null); // UTC hour
	let createIntervalCurrentPct = $state(0); // screen percent for preview
	let createStripHoverPct: number | null = $state(null); // hover position
	// Interval edge editing
	let editingMarkerId: number | null = $state(null); // marker in edge-edit mode
	let draggingEdge: 'start' | 'end' | null = $state(null); // which edge is being dragged
	let markerMenuId: number | null = $state(null); // marker with open menu
	// Marker dot tooltip state
	let dotTooltip: { markerId: number; rowIndex: number; x: number; y: number; position: 'above' | 'below' } | null = $state(null);
	// Working hours highlight
	let showWorkingHours = $state(false);
	// Day progress arc mode: 'arc' (sine/cosine) or 'progress' (linear sawtooth)
	let arcMode: 'arc' | 'progress' = $state('arc');

	function saveSettings() {
		try {
			localStorage.setItem('timezone-settings', JSON.stringify({ showWorkingHours, arcMode }));
		} catch {}
	}

	function loadSettings() {
		try {
			const raw = localStorage.getItem('timezone-settings');
			if (!raw) return;
			const s = JSON.parse(raw);
			if (typeof s.showWorkingHours === 'boolean') showWorkingHours = s.showWorkingHours;
			if (s.arcMode === 'arc' || s.arcMode === 'progress') arcMode = s.arcMode;
		} catch {}
	}

	// Derived
	let showDropdown = $derived(searchFocused && query.length > 0 && (searchResults.length > 0 || isSearchingRemote));
	let selectedIds = $derived(selectedTimezones.map((t) => t.id));
	let refTzId = $derived(selectedTimezones[0]?.id);
	let cellWidth = $derived(containerWidth / 24);

	// The range of UTC hours to render: 264 hours (11 days)
	const BUFFER = 120;
	const TOTAL_CELLS = 24 + 2 * BUFFER; // 264
	let renderAnchor = $state(Math.floor(initCenterHour));
	let renderStart = $derived(renderAnchor - BUFFER - 12);
	let renderHours = $derived(Array.from({ length: TOTAL_CELLS }, (_, i) => renderStart + i));

	// Visible hours: only cells on screen + small buffer for smooth scrolling
	const VISIBLE_BUFFER = 4; // extra cells on each side
	let visibleRange = $derived((() => {
		const halfVisible = Math.ceil(containerWidth / cellWidth / 2) + VISIBLE_BUFFER;
		const startHour = Math.floor(centerHour) - halfVisible;
		const endHour = Math.floor(centerHour) + halfVisible;
		return { start: startHour, end: endHour };
	})());
	let visibleRenderHours = $derived(
		renderHours.filter(h => h >= visibleRange.start && h <= visibleRange.end)
	);

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
	// Date carousel: 61 pills with reanchoring (like the grid)
	const NAV_DAYS_COUNT = 61;
	const NAV_DAYS_HALF = 30;
	let navAnchorDay = $state(0); // day offset from today that the nav is centered on
	let navPillWidth = $derived(navContainerWidth / (isMobile ? 5 : 7));
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

	const localTz = localTzInit;
	let localCityName = $state('');

	function isSameDay(a: Date, b: Date): boolean {
		return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	}

	// Smooth pan: shared by both carousels for < > and goToDate
	let smoothPan = $state(false);
	let smoothPanTimer: ReturnType<typeof setTimeout> | null = null;
	// Transition style for overlays (now-line, markers) during smooth pan
	let panTransition = $derived(smoothPan ? 'transition: left 300ms ease-in-out, width 300ms ease-in-out;' : '');

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
		if (isSameDay(date, selectedDate)) return;
		const target = new Date(date);
		target.setHours(0, 0, 0, 0);
		const todayDate = new Date();
		todayDate.setHours(0, 0, 0, 0);
		const targetDayOffset = Math.round((target.getTime() - todayDate.getTime()) / 86400000);
		// Keep the same time-of-day within the target day
		const hourInDay = ((centerHour % 24) + 24) % 24;
		smoothNavigate(targetDayOffset * 24 + hourInDay);
	}

	function goToday() {
		smoothNavigate(currentHourFrac);
	}

	// Drag to pan (grid)
	function handleDragStart(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('button')) return;
		if ((e.target as HTMLElement).closest('.marker-line')) return;
		if ((e.target as HTMLElement).closest('.marker-label')) return;
		isDragging = true;
		dragDidMove = false;
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
		if (isDraggingMarker) {
			handleMarkerDragMove(e);
			return;
		}
		if (isCreatingInterval) {
			// Update preview even when mouse moves outside the strip
			const strip = document.querySelector('.marker-create-strip');
			if (strip) {
				const rect = strip.getBoundingClientRect();
				let pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
				if (!e.shiftKey) {
					const snapped = snapToQuarter(screenPercentToUtcHour(pct));
					pct = markerScreenPercent(snapped);
				}
				createIntervalCurrentPct = pct;
			}
			return;
		}
		if (isDragging) {
			const dx = e.clientX - dragStartX;
			if (Math.abs(dx) > 3) dragDidMove = true;
			centerHour = dragStartCenter - dx / cellWidth;
		} else if (isDraggingNav) {
			const dx = e.clientX - dragStartX;
			if (Math.abs(dx) > 3) dragDidMove = true;
			centerHour = dragStartCenter - (dx / navPillWidth) * 24;
		}
	}

	function handleDragEnd(e: MouseEvent) {
		if (isDraggingMarker) {
			handleMarkerDragEnd();
			return;
		}
		if (isCreatingInterval) {
			handleCreateStripMouseUp(e);
			return;
		}
		isDragging = false;
		isDraggingNav = false;
	}

	// Touch handlers for mobile pan
	function handleTouchStart(e: TouchEvent) {
		if ((e.target as HTMLElement).closest('button')) return;
		isDragging = true;
		dragDidMove = false;
		dragStartX = e.touches[0].clientX;
		dragStartCenter = centerHour;
	}

	function handleNavTouchStart(e: TouchEvent) {
		if ((e.target as HTMLElement).closest('button')) return;
		isDraggingNav = true;
		dragStartX = e.touches[0].clientX;
		dragStartCenter = centerHour;
	}

	function handleTouchMove(e: TouchEvent) {
		if (isDragging) {
			e.preventDefault();
			const dx = e.touches[0].clientX - dragStartX;
			if (Math.abs(dx) > 3) dragDidMove = true;
			centerHour = dragStartCenter - dx / cellWidth;
		} else if (isDraggingNav) {
			e.preventDefault();
			const dx = e.touches[0].clientX - dragStartX;
			if (Math.abs(dx) > 3) dragDidMove = true;
			centerHour = dragStartCenter - (dx / navPillWidth) * 24;
		}
	}

	function handleTouchEnd(e: TouchEvent) {
		isDragging = false;
		isDraggingNav = false;
	}

	const STORAGE_KEY = 'timezone-selected';

	function saveToLocalStorage() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedTimezones));
		} catch {}
	}

	function loadFromLocalStorage(): SelectedTz[] | null {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed) || parsed.length === 0) return null;
			return parsed.filter((e: any) => e.id && e.label);
		} catch { return null; }
	}

	onMount(async () => {
		loadSettings();

		// If no URL params, check localStorage (client-only)
		if (!$page.url.searchParams.get('tz')) {
			const saved = loadFromLocalStorage();

			if (saved) {
				selectedTimezones = saved;
			}
		} else {

		}
		updateUrl();

		// Measure containers after DOM renders
		let ro: ResizeObserver | undefined;
		await tick();
		const measure = () => {
			const cellsEl = document.querySelector('.cells-area');
			const navEl = document.querySelector('.nav-carousel-area');

			if (cellsEl) containerWidth = cellsEl.clientWidth;
			if (navEl) navContainerWidth = navEl.clientWidth;
			isMobile = window.innerWidth < 640;
		};
		measure();

		// Try to get actual city name via geolocation
		if (navigator.geolocation) {
			navigator.geolocation.getCurrentPosition(async (pos) => {
				try {
					const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json&zoom=10`);
					const data = await res.json();
					const city = data.address?.city || data.address?.town || data.address?.village;
					if (city) {
						localCityName = city;
						// Update label for local timezone entry
						selectedTimezones = selectedTimezones.map(tz =>
							tz.id === localTz ? { ...tz, label: city } : tz
						);
					}
				} catch {}
			}, () => {}, { timeout: 5000 });
		}

		ready = true;
		ro = new ResizeObserver(measure);
		const cellsEl = document.querySelector('.cells-area');
		if (cellsEl) ro.observe(cellsEl);
		const navEl = document.querySelector('.nav-carousel-area');
		if (navEl) ro.observe(navEl);

		window.addEventListener('resize', measure);
		window.addEventListener('touchmove', handleTouchMove, { passive: false });

		const interval = setInterval(() => {
			now = new Date();
		}, 1000);

		return () => {
			clearInterval(interval);
			ro?.disconnect();
			window.removeEventListener('resize', measure);
			window.removeEventListener('touchmove', handleTouchMove);
		};
	});

	function updateUrl() {
		const url = new URL(window.location.href);
		url.searchParams.set('tz', selectedIds.join(','));
		if (markers.length > 0) {
			url.searchParams.set('m', markers.map(m =>
				m.utcHourEnd !== null
					? `${m.utcHour.toFixed(2)}~${m.utcHourEnd.toFixed(2)}`
					: m.utcHour.toFixed(2)
			).join(','));
		} else {
			url.searchParams.delete('m');
		}
		goto(url.toString(), { replaceState: true, keepFocus: true });
	}

	function addTimezone(tz: TimezoneInfo, displayName?: string) {
		selectedTimezones = [...selectedTimezones, { id: tz.id, label: displayName || tz.city }];
		saveToLocalStorage();
		updateUrl();
		query = '';
		searchResults = [];
		highlightedIndex = -1;
		inputEl?.focus();
	}

	async function handlePinpoint() {
		if (!navigator.geolocation) return;
		locatingCity = true;
		navigator.geolocation.getCurrentPosition(async (pos) => {
			try {
				const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json&zoom=10`);
				const data = await res.json();
				const city = data.address?.city || data.address?.town || data.address?.village;
				if (city) {
					localCityName = city;
					const homeIndex = selectedTimezones.findIndex(tz => tz.id === localTz);
					if (homeIndex >= 0) {
						selectedTimezones = selectedTimezones.map(tz =>
							tz.id === localTz ? { ...tz, label: city } : tz
						);
					} else {
						selectedTimezones = [{ id: localTz, label: city }, ...selectedTimezones];
					}
					saveToLocalStorage();
					updateUrl();
				}
			} catch {} finally {
				locatingCity = false;
			}
		}, () => { locatingCity = false; }, { timeout: 5000 });
	}

	function removeTimezoneAt(index: number) {
		selectedTimezones = selectedTimezones.filter((_, i) => i !== index);
		saveToLocalStorage();
		updateUrl();
	}

	function moveTimezone(index: number, direction: -1 | 1) {
		const newIndex = index + direction;
		if (newIndex < 0 || newIndex >= selectedTimezones.length) return;
		const copy = [...selectedTimezones];
		[copy[index], copy[newIndex]] = [copy[newIndex], copy[index]];
		selectedTimezones = copy;
		saveToLocalStorage();
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
		// Place marker at hover position
		if (e.key === 'm' && hoverPercent !== null) {
			e.preventDefault();
			let utcHour = screenPercentToUtcHour(hoverPercent);
			if (!e.shiftKey) utcHour = snapToQuarter(utcHour);
			addMarker(utcHour);
			return;
		}
		// Exit edit mode
		if (e.key === 'Escape' && editingMarkerId !== null) {
			e.preventDefault();
			editingMarkerId = null;
			return;
		}
		// Delete selected marker
		if ((e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') && selectedMarkerId !== null) {
			e.preventDefault();
			removeMarker(selectedMarkerId);
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

	function isWorkingHour(tz: string, utcHour: number): boolean {
		const h = getTzHourValue(tz, utcHour);
		return h >= 9 && h < 17;
	}

	function isOverlapWorkingHour(utcHour: number): boolean {
		return selectedTimezones.every(tz => isWorkingHour(tz.id, utcHour));
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
	function getDaylightPath(tz: string, workMode: boolean = false): string {
		const points: { x: number; y: number }[] = [];
		const height = 40;
		const maxArc = height * 0.65;
		const steps = TOTAL_CELLS * 2;
		const rangeStart = workMode ? 9 : 0;
		const rangeLen = workMode ? 8 : 24;
		const peakHour = rangeStart + rangeLen / 2; // center of range
		const offsetMinutes = getTimezoneOffset(tz, offsetBase);

		// Use higher sampling for smoother curves
		const sampleRate = 8; // points per cell
		const totalSamples = TOTAL_CELLS * sampleRate;

		for (let i = 0; i <= totalSamples; i++) {
			const hourIndex = i / sampleRate;
			const utcHour = renderStart + hourIndex;
			// Use raw continuous local hour (no modulo) so cosine stays smooth across midnight
			const continuousLocalHour = (utcHour * 60 + offsetMinutes) / 60;
			let val: number;
			if (workMode) {
				// Single hump per day within the working range
				// Find hour-of-day without discontinuity
				const hourOfDay = ((continuousLocalHour % 24) + 24) % 24;
				const hoursIntoRange = hourOfDay - rangeStart;
				if (hoursIntoRange >= 0 && hoursIntoRange <= rangeLen) {
					val = Math.sin((hoursIntoRange / rangeLen) * Math.PI);
				} else {
					val = 0;
				}
			} else {
				// Full day cosine peaking at 1pm — use raw hour, cosine is naturally periodic
				const radians = ((continuousLocalHour - peakHour) / rangeLen) * Math.PI * 2;
				val = (Math.cos(radians) + 1) / 2;
			}
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

	// Day progress path — sawtooth descending from top to bottom
	// Normal: 12a(top) → 12a(bottom), Working hours: 9a(top) → 5p(bottom)
	function getProgressPath(tz: string, workMode: boolean = false): string {
		const height = 40;
		const offsetMinutes = getTimezoneOffset(tz, offsetBase);
		const rangeStart = workMode ? 9 : 0;   // hour where line starts at top
		const rangeLen = workMode ? 8 : 24;     // hours in one cycle

		function localFracHour(utcHour: number): number {
			const localMinutes = utcHour * 60 + offsetMinutes;
			return (((localMinutes / 60) % 24) + 24) % 24;
		}

		let d = '';
		let prevProgress = -1;
		const steps = TOTAL_CELLS * 2;

		for (let i = 0; i <= steps; i++) {
			const hourIndex = i / 2;
			const utcHour = renderStart + hourIndex;
			const localH = localFracHour(utcHour);
			// How far through the range (0=top, 1=bottom)
			const hoursIntoRange = ((localH - rangeStart + 24) % 24);
			const progress = workMode
				? (hoursIntoRange >= rangeLen ? 1 : hoursIntoRange / rangeLen)  // clamp outside range to bottom
				: hoursIntoRange / rangeLen;
			const x = (hourIndex / TOTAL_CELLS) * 100;
			const y = progress * height;

			if (i === 0) {
				d = `M ${x} ${y}`;
			} else if (progress < prevProgress - 0.1) {
				// Range boundary crossing: drop to bottom, jump to top
				d += ` L ${x} ${height}`;
				d += ` L ${x} 0`;
				d += ` L ${x} ${y}`;
			} else {
				d += ` L ${x} ${y}`;
			}
			prevProgress = progress;
		}
		d += ` L 100 ${height} L 0 ${height} Z`;
		return d;
	}

	// Cache daylight paths — only recompute when renderAnchor or timezones change, not on drag
	let cachedDaylightPaths = $derived(
		new Map(selectedTimezones.map(e => [e.id, getDaylightPath(e.id, showWorkingHours)]))
	);

	let cachedProgressPaths = $derived(
		new Map(selectedTimezones.map(e => [e.id, getProgressPath(e.id, showWorkingHours)]))
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

	function formatTime(tz: string): string {
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
		// Exit marker edit mode when clicking outside marker elements
		if (editingMarkerId !== null && !target.closest('.marker-label') && !target.closest('.marker-line')) {
			editingMarkerId = null;
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

	// --- Markers ---

	// Convert a UTC fractional hour to screen percent (same math as now-line)
	function markerScreenPercent(utcHour: number): number {
		const posInStrip = (utcHour - renderStart) * cellWidth;
		const screenX = posInStrip + stripTranslateX;
		return (screenX / containerWidth) * 100;
	}

	// Derived: marker positions as screen percents + visibility
	let markerPositions = $derived(
		markers.map(m => {
			const pct = markerScreenPercent(m.utcHour);
			const pctEnd = m.utcHourEnd !== null ? markerScreenPercent(m.utcHourEnd) : null;
			const isInterval = pctEnd !== null;
			const leftPct = isInterval ? Math.min(pct, pctEnd!) : pct;
			const rightPct = isInterval ? Math.max(pct, pctEnd!) : pct;
			const visible = rightPct >= -1 && leftPct <= 101;
			return { ...m, percent: pct, percentEnd: pctEnd, leftPct, rightPct, isInterval, visible };
		})
	);

	// Convert screen percent (within cells-area) to UTC fractional hour
	function screenPercentToUtcHour(percent: number): number {
		const screenX = (percent / 100) * containerWidth;
		return (screenX - stripTranslateX) / cellWidth + renderStart;
	}

	// Format a marker's time in a given timezone
	function formatMarkerTime(utcHour: number, tz: string): string {
		const offsetMinutes = getTimezoneOffset(tz, offsetBase);
		const localTotalMinutes = utcHour * 60 + offsetMinutes;
		const minuteInDay = ((localTotalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
		const h = Math.floor(minuteInDay / 60);
		const m = Math.round(minuteInDay % 60);
		const displayHour = h % 12 || 12;
		const period = h < 12 ? 'AM' : 'PM';
		return `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
	}

	function formatMarkerTimeWithDate(utcHour: number, tz: string): { time: string; date: string; isDifferentDay: boolean } {
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
		const markerDate = new Date(todayDate.getTime() + dayOffset * 86400000);
		const date = new Intl.DateTimeFormat('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(markerDate);

		return { time, date, isDifferentDay: dayOffset !== 0 };
	}

	function handleDotMouseEnter(e: MouseEvent, markerId: number, rowIndex: number) {
		const dot = e.currentTarget as HTMLElement;
		const rect = dot.getBoundingClientRect();
		const viewportHeight = window.innerHeight;
		// Auto-position: prefer above, fall back to below if too close to top
		const spaceAbove = rect.top;
		const position = spaceAbove < 60 ? 'below' : 'above';
		dotTooltip = {
			markerId,
			rowIndex,
			x: rect.left + rect.width / 2,
			y: position === 'above' ? rect.top : rect.bottom,
			position,
		};
	}

	function handleDotMouseLeave() {
		dotTooltip = null;
	}

	function addMarker(utcHour: number) {
		const color = MARKER_COLORS[markers.length % MARKER_COLORS.length];
		const id = nextMarkerId++;
		markers = [...markers, { id, utcHour, utcHourEnd: null, label: '', color }];
		selectedMarkerId = id;
		updateUrl();
	}

	function removeMarker(id: number) {
		markers = markers.filter(m => m.id !== id);
		if (selectedMarkerId === id) selectedMarkerId = null;
		updateUrl();
	}

function handleMarkerLineClick(e: MouseEvent, markerId: number) {
		e.stopPropagation();
		selectedMarkerId = selectedMarkerId === markerId ? null : markerId;
	}

	// Snap UTC hour to nearest :00/:15/:30/:45 in reference timezone
	function snapToQuarter(utcHour: number): number {
		if (!refTzId) return utcHour;
		const offsetMinutes = getTimezoneOffset(refTzId, offsetBase);
		const localMinutes = utcHour * 60 + offsetMinutes;
		const snapped = Math.round(localMinutes / 15) * 15;
		return (snapped - offsetMinutes) / 60;
	}

	// --- Marker dragging ---
	function handleMarkerDragStart(e: MouseEvent, markerId: number) {
		e.stopPropagation();
		e.preventDefault();
		isDraggingMarker = true;
		draggingMarkerId = markerId;
		markerDragStartX = e.clientX;
		const marker = markers.find(m => m.id === markerId);
		markerDragStartUtcHour = marker?.utcHour ?? 0;
		selectedMarkerId = markerId;
	}

	function handleMarkerDragMove(e: MouseEvent) {
		if (!isDraggingMarker || draggingMarkerId === null) return;
		const dx = e.clientX - markerDragStartX;
		const dHours = dx / cellWidth;
		let newUtcHour = markerDragStartUtcHour + dHours;
		if (!e.shiftKey) newUtcHour = snapToQuarter(newUtcHour);

		if (draggingEdge) {
			// Edge drag: only move one end
			markers = markers.map(m => {
				if (m.id !== draggingMarkerId) return m;
				if (draggingEdge === 'start') {
					return { ...m, utcHour: newUtcHour };
				} else {
					return { ...m, utcHourEnd: newUtcHour };
				}
			});
		} else {
			// Whole-interval drag
			markers = markers.map(m => {
				if (m.id !== draggingMarkerId) return m;
				const delta = newUtcHour - m.utcHour;
				return {
					...m,
					utcHour: newUtcHour,
					utcHourEnd: m.utcHourEnd !== null ? m.utcHourEnd + delta : null,
				};
			});
		}
	}

	function handleMarkerDragEnd() {
		if (isDraggingMarker) {
			isDraggingMarker = false;
			draggingMarkerId = null;
			draggingEdge = null;
			updateUrl();
		}
	}

	function handleMarkerDblClick(e: MouseEvent, markerId: number) {
		e.stopPropagation();
		e.preventDefault();
		const marker = markers.find(m => m.id === markerId);
		if (!marker || marker.utcHourEnd === null) return;
		editingMarkerId = editingMarkerId === markerId ? null : markerId;
	}

	function handleEdgeDragStart(e: MouseEvent, markerId: number, edge: 'start' | 'end') {
		e.stopPropagation();
		e.preventDefault();
		isDraggingMarker = true;
		draggingMarkerId = markerId;
		draggingEdge = edge;
		markerDragStartX = e.clientX;
		const marker = markers.find(m => m.id === markerId);
		markerDragStartUtcHour = edge === 'start' ? (marker?.utcHour ?? 0) : (marker?.utcHourEnd ?? 0);
	}

	function duplicateMarker(markerId: number) {
		const marker = markers.find(m => m.id === markerId);
		if (!marker) return;
		const id = nextMarkerId++;
		const color = MARKER_COLORS[markers.length % MARKER_COLORS.length];
		// Offset by 1 hour so it's visible
		markers = [...markers, {
			id,
			utcHour: marker.utcHour + 1,
			utcHourEnd: marker.utcHourEnd !== null ? marker.utcHourEnd + 1 : null,
			label: '',
			color,
		}];
		markerMenuId = null;
		selectedMarkerId = id;
		updateUrl();
	}

	// --- Create strip (area above grid for creating markers/intervals) ---
	function getCreateStripPercent(e: MouseEvent): number {
		const strip = (e.currentTarget as HTMLElement).querySelector('.marker-create-strip')
			?? (e.currentTarget as HTMLElement).closest('.marker-create-strip');
		const el = strip ?? e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		return Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
	}

	function handleCreateStripMouseDown(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.marker-label')) return;
		const pct = getCreateStripPercent(e);
		let utcHour = screenPercentToUtcHour(pct);
		if (!e.shiftKey) utcHour = snapToQuarter(utcHour);
		isCreatingInterval = true;
		createIntervalStart = utcHour;
		createIntervalCurrentPct = !e.shiftKey ? markerScreenPercent(utcHour) : pct;
		e.preventDefault();
	}

	function handleCreateStripMouseMove(e: MouseEvent) {
		let pct = getCreateStripPercent(e);
		if (!e.shiftKey && isCreatingInterval) {
			const snapped = snapToQuarter(screenPercentToUtcHour(pct));
			pct = markerScreenPercent(snapped);
		}
		createStripHoverPct = pct;
		hoverPercent = pct; // show gray line through grid
		if (isCreatingInterval) {
			createIntervalCurrentPct = pct;
		}
	}

	function handleCreateStripMouseUp(e: MouseEvent) {
		if (!isCreatingInterval || createIntervalStart === null) return;
		// Use the current preview pct (works even if mouse is outside strip)
		let endUtcHour = screenPercentToUtcHour(createIntervalCurrentPct);
		if (!e.shiftKey) endUtcHour = snapToQuarter(endUtcHour);
		const startUtcHour = createIntervalStart;

		// If barely moved, create a point marker; otherwise an interval
		const hourDiff = Math.abs(endUtcHour - startUtcHour);
		if (hourDiff < 0.25) {
			addMarker(!e.shiftKey ? snapToQuarter(startUtcHour) : startUtcHour);
		} else {
			const color = MARKER_COLORS[markers.length % MARKER_COLORS.length];
			const id = nextMarkerId++;
			const start = Math.min(startUtcHour, endUtcHour);
			const end = Math.max(startUtcHour, endUtcHour);
			markers = [...markers, { id, utcHour: start, utcHourEnd: end, label: '', color }];
			selectedMarkerId = id;
			updateUrl();
		}

		isCreatingInterval = false;
		createIntervalStart = null;
		hoverPercent = null;
	}

	function handleCreateStripMouseLeave() {
		createStripHoverPct = null;
		if (!isCreatingInterval) {
			hoverPercent = null;
		}
	}

	function formatNavDay(d: Date): { dayNum: string; topLabel: string; isWeekend: boolean; isToday: boolean } {
		const dayNum = String(d.getDate());
		const dow = d.getDay();
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		// On the 1st, show month name instead of weekday
		const topLabel = d.getDate() === 1
			? new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d)
			: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
		return { dayNum, topLabel, isWeekend: dow === 0 || dow === 6, isToday: isSameDay(d, today) };
	}
</script>

<svelte:window
	onkeydown={handleGlobalKeydown}
	onclick={handleClickOutside}
	onmousemove={handleDragMove}
	onmouseup={handleDragEnd}
	ontouchend={handleTouchEnd}
/>

<svelte:head>
	<title>Timezone</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground flex flex-col select-none {ready ? '' : 'invisible'}">
	<!-- Header -->
	<div class="flex flex-col items-center pt-8 max-sm:pt-4 pb-6 max-sm:pb-3 px-4">
		<div class="flex items-center gap-3 mb-6 max-sm:mb-4">
			<Globe class="h-6 w-6 max-sm:h-5 max-sm:w-5 text-muted-foreground" strokeWidth={1.5} />
			<h1 class="text-2xl max-sm:text-xl font-light tracking-[0.3em] text-muted-foreground">TIMEZONE</h1>
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
			<div class="flex items-center gap-1 justify-center">
				<div class="relative group/today">
					<button
						type="button"
						onclick={goToday}
						class="p-1.5 rounded-md transition-colors {Math.abs(centerHour - currentHourFrac) < 0.5
							? 'text-muted-foreground/30 cursor-default'
							: 'text-blue-400 hover:bg-blue-500/15'}"
					>
						<CalendarDays class="h-4 w-4" />
					</button>
					<div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 rounded-md bg-popover border border-border shadow-lg text-xs text-popover-foreground whitespace-nowrap opacity-0 group-hover/today:opacity-100 pointer-events-none transition-opacity">
						Go to today
						<div class="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 bg-popover border-r border-b border-border rotate-45 -mt-1"></div>
					</div>
				</div>

				<button
					type="button"
					onclick={() => shiftView(-24)}
					class="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
				>
					<ChevronLeft class="h-4 w-4" />
				</button>

				<!-- Date carousel (minimap) -->
				<div
					class="nav-carousel-area relative overflow-hidden select-none w-64 max-sm:flex-1 max-sm:w-auto"
					style="cursor: {isDraggingNav ? 'grabbing' : 'grab'}"
					onmousedown={handleNavDragStart}
					ontouchstart={handleNavTouchStart}
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
								<span class="text-[9px] leading-tight font-medium">{info.topLabel}</span>
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

				<div class="relative group/work ml-1">
					<button
						type="button"
						onclick={() => { showWorkingHours = !showWorkingHours; saveSettings(); }}
						class="p-1.5 rounded-md transition-colors
							{showWorkingHours
								? 'bg-amber-500/15 text-amber-500'
								: 'text-muted-foreground hover:text-foreground hover:bg-accent'}"
					>
						<Briefcase class="h-4 w-4" />
					</button>
					<div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 rounded-md bg-popover border border-border shadow-lg text-xs text-popover-foreground whitespace-nowrap opacity-0 group-hover/work:opacity-100 pointer-events-none transition-opacity">
						{showWorkingHours ? 'Hide' : 'Show'} working hours (9–5)
						<div class="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 bg-popover border-r border-b border-border rotate-45 -mt-1"></div>
					</div>
				</div>

				<div class="flex items-center rounded-md border border-border overflow-hidden ml-1">
					<button
						type="button"
						onclick={() => { arcMode = 'arc'; saveSettings(); }}
						class="px-2 py-1 text-[11px] font-medium transition-colors flex items-center gap-1
							{arcMode === 'arc'
								? 'bg-accent text-foreground'
								: 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}"
					>
						<Sunset class="h-3 w-3" />
						Arc
					</button>
					<div class="w-px h-4 bg-border"></div>
					<button
						type="button"
						onclick={() => { arcMode = 'progress'; saveSettings(); }}
						class="px-2 py-1 text-[11px] font-medium transition-colors flex items-center gap-1
							{arcMode === 'progress'
								? 'bg-accent text-foreground'
								: 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}"
					>
						<TrendingUp class="h-3 w-3" />
						Progress
					</button>
				</div>
			</div>
		</div>
	</div>

	<!-- Timezone rows -->
	{#if selectedTimezones.length > 0}
		<div class="flex-1 px-4 max-sm:px-2 pb-8">
			<div class="max-w-6xl mx-auto">
				<!-- Marker creation strip + labels above the grid -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="flex relative z-30"
					onmousedown={handleCreateStripMouseDown}
					onmousemove={handleCreateStripMouseMove}
					onmouseup={handleCreateStripMouseUp}
					onmouseleave={handleCreateStripMouseLeave}
					style="cursor: crosshair"
				>
					<div class="w-44 shrink-0 max-sm:hidden"></div>
					<div class="flex-1 relative h-6 marker-create-strip" style="overflow-x: clip">
						<!-- Blue dot (now indicator) -->
						{#if nowLineVisible}
							<div class="absolute bottom-0 w-[10px] h-[10px] rounded-full bg-blue-500 z-20 -translate-x-1/2 translate-y-1/2 pointer-events-none max-sm:hidden"
								style="left: {nowLinePercent}%; {panTransition}"></div>
						{/if}

						<!-- Hover indicator: + at bottom edge (same level as blue dot) -->
						{#if createStripHoverPct !== null && !isCreatingInterval}
							<div class="absolute bottom-0 -translate-x-1/2 translate-y-1/2 pointer-events-none z-10 flex items-center justify-center w-5 h-5 rounded-full bg-muted-foreground/20 text-muted-foreground"
								style="left: {createStripHoverPct}%">
								<Plus class="h-3.5 w-3.5" strokeWidth={2.5} />
							</div>
						{/if}
						<!-- Existing marker labels (draggable) -->
						{#each markerPositions as marker}
							{#if marker.visible}
								{@const isEditing = editingMarkerId === marker.id && marker.isInterval}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="marker-label group/marker absolute top-0 -translate-x-1/2 text-[10px] font-medium whitespace-nowrap select-none px-1 py-0.5 rounded z-30
										{isEditing ? 'ring-1 ring-offset-1' : 'cursor-grab active:cursor-grabbing'}"
									style="left: {marker.isInterval ? (marker.leftPct + marker.rightPct) / 2 : marker.percent}%; color: {marker.color}; background: {marker.color}15; {isEditing ? `ring-color: ${marker.color};` : ''} {panTransition}"
									onmousedown={(e) => { if (!isEditing && !(e.target as HTMLElement).closest('.marker-menu-trigger')) { e.stopPropagation(); handleMarkerDragStart(e, marker.id); } }}
									ondblclick={(e) => handleMarkerDblClick(e, marker.id)}
								>
									{#if refTzId}
										{#if marker.isInterval}
											{formatMarkerTime(Math.min(marker.utcHour, marker.utcHourEnd ?? marker.utcHour), refTzId)} – {formatMarkerTime(Math.max(marker.utcHour, marker.utcHourEnd ?? marker.utcHour), refTzId)}
										{:else}
											{formatMarkerTime(marker.utcHour, refTzId)}
										{/if}
									{/if}

									<!-- Ellipsis menu (absolute so it doesn't affect centering) -->
									<DropdownMenu.Root bind:open={
										() => markerMenuId === marker.id,
										(v) => { markerMenuId = v ? marker.id : null; }
									}>
										<DropdownMenu.Trigger
											class="marker-menu-trigger absolute -right-4 top-1/2 -translate-y-1/2 p-0.5 rounded opacity-0 group-hover/marker:opacity-100 transition-opacity hover:bg-black/10
												{markerMenuId === marker.id ? '!opacity-100' : ''}"
											onclick={(e: MouseEvent) => e.stopPropagation()}
											onmousedown={(e: MouseEvent) => e.stopPropagation()}
										>
											<EllipsisVertical class="h-3 w-3" />
										</DropdownMenu.Trigger>
										<DropdownMenu.Portal>
											<DropdownMenu.Content
												class="z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground p-1 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
												sideOffset={4}
											>
												{#if marker.isInterval}
													<DropdownMenu.Item
														class="relative flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none cursor-default select-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
														onSelect={() => { editingMarkerId = editingMarkerId === marker.id ? null : marker.id; }}
													>
														<MoveHorizontal class="h-4 w-4 text-muted-foreground" />
														Resize
													</DropdownMenu.Item>
												{/if}
												<DropdownMenu.Item
													class="relative flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none cursor-default select-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
													onSelect={() => duplicateMarker(marker.id)}
												>
													<Copy class="h-4 w-4 text-muted-foreground" />
													Duplicate
												</DropdownMenu.Item>
												<DropdownMenu.Separator class="-mx-1 my-1 h-px bg-border" />
												<DropdownMenu.Item
													class="relative flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none cursor-default select-none transition-colors text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
													onSelect={() => removeMarker(marker.id)}
												>
													<Trash2 class="h-4 w-4" />
													Delete
												</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Portal>
									</DropdownMenu.Root>
								</div>

								<!-- Edge handles when in edit mode -->
								{#if isEditing}
									<!-- Left edge handle -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="absolute top-0 bottom-0 -translate-x-1/2 z-40 cursor-ew-resize flex items-center"
										style="left: {marker.leftPct}%"
										onmousedown={(e) => { e.stopPropagation(); handleEdgeDragStart(e, marker.id, marker.utcHour <= (marker.utcHourEnd ?? 0) ? 'start' : 'end'); }}
									>
										<div class="w-3 h-5 rounded-sm flex items-center justify-center" style="background: {marker.color}">
											<div class="w-[2px] h-3 bg-white/60 rounded-full"></div>
										</div>
									</div>
									<!-- Right edge handle -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="absolute top-0 bottom-0 -translate-x-1/2 z-40 cursor-ew-resize flex items-center"
										style="left: {marker.rightPct}%"
										onmousedown={(e) => { e.stopPropagation(); handleEdgeDragStart(e, marker.id, marker.utcHour <= (marker.utcHourEnd ?? 0) ? 'end' : 'start'); }}
									>
										<div class="w-3 h-5 rounded-sm flex items-center justify-center" style="background: {marker.color}">
											<div class="w-[2px] h-3 bg-white/60 rounded-full"></div>
										</div>
									</div>
								{/if}
							{/if}
						{/each}

						<!-- Preview line while creating interval -->
						{#if isCreatingInterval && createIntervalStart !== null}
							{@const startPct = markerScreenPercent(createIntervalStart)}
							{@const endPct = createIntervalCurrentPct}
							{@const left = Math.min(startPct, endPct)}
							{@const width = Math.abs(endPct - startPct)}
							<div class="absolute top-0 bottom-0 pointer-events-none z-20"
								style="left: {left}%; width: {width}%; background: {MARKER_COLORS[markers.length % MARKER_COLORS.length]}20;">
								<div class="absolute left-0 top-0 bottom-0 w-[2px]" style="background: {MARKER_COLORS[markers.length % MARKER_COLORS.length]}"></div>
								<div class="absolute right-0 top-0 bottom-0 w-[2px]" style="background: {MARKER_COLORS[markers.length % MARKER_COLORS.length]}"></div>
							</div>
						{/if}
					</div>
				</div>

				<!-- Grid -->
				<div
					class="relative overflow-hidden"
					onmousemove={handleCellsMouseMove}
					onmouseleave={handleCellsMouseLeave}
					onmousedown={handleDragStart}
					ontouchstart={handleTouchStart}
					role="presentation"
					style="cursor: {isDragging ? 'grabbing' : 'grab'}"
				>
					<!-- Blue now-line (desktop only — on mobile, rendered per-row) -->
					{#if nowLineVisible}
						<div class="absolute top-0 bottom-0 overflow-hidden pointer-events-none max-sm:hidden" style="left: 11rem; right: 0;">
							<div
								class="absolute top-0 bottom-0 w-[2px] bg-blue-500 z-20 -translate-x-1/2"
								style="left: {nowLinePercent}%; {panTransition}"
							></div>
						</div>
					{/if}

					<!-- Gray hover-line (desktop only) -->
					{#if hoverPercent !== null && !isDragging}
						<div class="absolute top-0 bottom-0 overflow-hidden pointer-events-none max-sm:hidden" style="left: 11rem; right: 0;">
							<div
								class="absolute top-0 bottom-0 w-[1px] bg-foreground/30 z-30 -translate-x-1/2"
								style="left: {hoverPercent}%"
							></div>
						</div>
					{/if}

					<!-- Marker lines + intervals (desktop — span all rows) -->
					{#each markerPositions as marker}
						{#if marker.visible}
							<div class="absolute top-0 bottom-0 overflow-hidden max-sm:hidden" style="left: 11rem; right: 0; z-index: 25;">
								<div class="relative h-full">
									{#if marker.isInterval}
										{@const isEditing = editingMarkerId === marker.id}
										<!-- Interval shading -->
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div
											class="marker-line absolute top-0 bottom-0 pointer-events-none"
											style="left: {marker.leftPct}%; width: {marker.rightPct - marker.leftPct}%; background: {marker.color}20; {panTransition}"
										>
											<!-- Left edge -->
											<div class="absolute left-0 top-0 bottom-0 w-[2px]" style="background: {marker.color}"></div>
											<!-- Right edge -->
											<div class="absolute right-0 top-0 bottom-0 w-[2px]" style="background: {marker.color}"></div>
										</div>
									{:else}
										<!-- Point marker line -->
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div
											class="absolute top-0 bottom-0 -translate-x-1/2 pointer-events-none"
											style="left: {marker.percent}%; width: 2px; background: {marker.color}; {panTransition}"
										></div>
									{/if}
								</div>
							</div>
						{/if}
					{/each}

					<!-- Interval creation preview (full grid height) -->
					{#if isCreatingInterval && createIntervalStart !== null}
						{@const previewStartPct = markerScreenPercent(createIntervalStart)}
						{@const previewEndPct = createIntervalCurrentPct}
						{@const previewLeft = Math.min(previewStartPct, previewEndPct)}
						{@const previewWidth = Math.abs(previewEndPct - previewStartPct)}
						{@const previewColor = MARKER_COLORS[markers.length % MARKER_COLORS.length]}
						<div class="absolute top-0 bottom-0 overflow-hidden pointer-events-none max-sm:hidden" style="left: 11rem; right: 0; z-index: 24;">
							<div class="relative h-full">
								{#if previewWidth > 1}
									<div class="absolute top-0 bottom-0"
										style="left: {previewLeft}%; width: {previewWidth}%; background: {previewColor}15;">
										<div class="absolute left-0 top-0 bottom-0 w-[2px]" style="background: {previewColor}"></div>
										<div class="absolute right-0 top-0 bottom-0 w-[2px]" style="background: {previewColor}"></div>
									</div>
								{:else}
									<div class="absolute top-0 bottom-0 w-[2px] -translate-x-1/2"
										style="left: {previewStartPct}%; background: {previewColor}"></div>
								{/if}
							</div>
						</div>
					{/if}

					<!-- Rows -->
					<div class="space-y-1 max-sm:space-y-3">
						{#each selectedTimezones as entry, rowIndex}
							<div class="group relative flex sm:items-center gap-0 max-sm:flex-col">
								<!-- Remove button (left column on desktop, top-right on mobile) -->
								<div class="w-6 shrink-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity
									max-sm:absolute max-sm:right-0 max-sm:top-0 max-sm:w-auto max-sm:z-30">
									<button
										type="button"
										onclick={() => removeTimezoneAt(rowIndex)}
										class="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
									>
										<X class="h-3.5 w-3.5" />
									</button>
								</div>

								<!-- Timezone label -->
								<div class="sm:w-38 sm:shrink-0 relative bg-background sm:pr-2 sm:h-12 flex flex-col sm:justify-center
									max-sm:flex-row max-sm:items-baseline max-sm:gap-2 max-sm:px-1 max-sm:py-1">
									<div class="flex items-center gap-1.5">
										<span class="font-medium text-sm leading-tight truncate">{entry.label}</span>
										{#if entry.id === localTz}
											<span class="text-[9px] font-medium text-blue-400 bg-blue-400/10 px-1 py-px rounded shrink-0">HOME</span>
										{/if}
									</div>
									{#if hoverPercent !== null && !isDragging}
										{@const hovered = getHoveredTime(entry.id, hoverPercent)}
										<div class="flex items-baseline gap-1 mt-0.5 max-sm:mt-0">
											<span class="text-xs font-semibold text-foreground">{hovered.time}</span>
											<span class="text-[10px] text-muted-foreground">{hovered.date}</span>
										</div>
									{:else}
										<div class="flex items-baseline gap-1.5 mt-0.5 max-sm:mt-0">
											<span class="text-xs font-semibold text-foreground/90 tabular-nums">{formatTime(entry.id)}</span>
											<span class="text-[10px] text-muted-foreground">{getTimezoneAbbr(entry.id)}</span>
											<span class="text-[10px] text-muted-foreground/60">{formatOffset(getTimezoneOffset(entry.id, offsetBase))}</span>
										</div>
									{/if}

									<!-- Reorder buttons (desktop only) -->
									<div class="absolute right-0 top-1/2 -translate-y-1/2 flex flex-col opacity-0 group-hover:opacity-100 transition-opacity max-sm:hidden">
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
									class="flex-1 max-sm:w-full relative overflow-hidden cells-area select-none"
								>
									<!-- Mobile now-line (per-row) -->
									{#if nowLineVisible}
										<div class="hidden max-sm:block absolute top-0 bottom-0 w-[2px] bg-blue-500 z-20 -translate-x-1/2 pointer-events-none"
											style="left: {nowLinePercent}%; {panTransition}"></div>
									{/if}
									<!-- Mobile marker lines (per-row) -->
									{#each markerPositions as marker}
										{#if marker.visible}
											{#if marker.isInterval}
												<div class="hidden max-sm:block absolute top-0 bottom-0 pointer-events-none"
													style="left: {marker.leftPct}%; width: {marker.rightPct - marker.leftPct}%; background: {marker.color}20; z-index: 25; {panTransition}">
													<div class="absolute left-0 top-0 bottom-0 w-[2px]" style="background: {marker.color}"></div>
													<div class="absolute right-0 top-0 bottom-0 w-[2px]" style="background: {marker.color}"></div>
												</div>
											{:else}
												<div class="hidden max-sm:block absolute top-0 bottom-0 w-[2px] -translate-x-1/2 pointer-events-none"
													style="left: {marker.percent}%; background: {marker.color}; z-index: 25; {panTransition}"></div>
											{/if}
										{/if}
									{/each}
									<!-- Marker dots (per-row) -->
									{#each markerPositions as marker}
										{#if marker.visible}
											{#if marker.isInterval}
												<!-- Dots at both edges of interval -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[8px] h-[8px] rounded-full z-30 cursor-pointer hover:scale-150 transition-transform"
													style="left: {marker.leftPct}%; background: {marker.color}; {panTransition}"
													onmouseenter={(e) => handleDotMouseEnter(e, marker.id, rowIndex)}
													onmouseleave={handleDotMouseLeave}
												></div>
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[8px] h-[8px] rounded-full z-30 cursor-pointer hover:scale-150 transition-transform"
													style="left: {marker.rightPct}%; background: {marker.color}; {panTransition}"
													onmouseenter={(e) => handleDotMouseEnter(e, marker.id, rowIndex)}
													onmouseleave={handleDotMouseLeave}
												></div>
											{:else}
												<!-- Single dot for point marker -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[8px] h-[8px] rounded-full z-30 cursor-pointer hover:scale-150 transition-transform"
													style="left: {marker.percent}%; background: {marker.color}; {panTransition}"
													onmouseenter={(e) => handleDotMouseEnter(e, marker.id, rowIndex)}
													onmouseleave={handleDotMouseLeave}
												></div>
											{/if}
										{/if}
									{/each}
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
											<defs>
												<linearGradient id="daylight-{rowIndex}" x1="0" y1="0" x2="0" y2="1">
													<stop offset="0%" stop-color="white" stop-opacity="0.12" />
													<stop offset="100%" stop-color="white" stop-opacity="0.02" />
												</linearGradient>
											</defs>
											{#if showWorkingHours}
												<!-- Dimmed version for non-working hours -->
												<path
													d={(arcMode === 'progress' ? cachedProgressPaths.get(entry.id) : cachedDaylightPaths.get(entry.id)) ?? ''}
													fill="url(#daylight-{rowIndex})"
													stroke="rgba(255,255,255,0.05)"
													stroke-width="0.4"
													vector-effect="non-scaling-stroke"
													opacity="0.3"
												/>
												<!-- Bright version clipped to working hours -->
												<clipPath id="work-clip-{rowIndex}">
													{#each visibleRenderHours as hour}
														{@const actualH = getTzHourValue(entry.id, hour)}
														{#if actualH >= 9 && actualH < 17}
															<rect x={((hour - renderStart) / TOTAL_CELLS) * 100} y="0" width={100 / TOTAL_CELLS} height="40" />
														{/if}
													{/each}
												</clipPath>
												<path
													d={(arcMode === 'progress' ? cachedProgressPaths.get(entry.id) : cachedDaylightPaths.get(entry.id)) ?? ''}
													fill="url(#daylight-{rowIndex})"
													stroke="rgba(255,255,255,0.15)"
													stroke-width="0.4"
													vector-effect="non-scaling-stroke"
													clip-path="url(#work-clip-{rowIndex})"
												/>
												<!-- Extended hours (7a-9a, 5p-11p) -->
												<clipPath id="ext-clip-{rowIndex}">
													{#each visibleRenderHours as hour}
														{@const actualH = getTzHourValue(entry.id, hour)}
														{#if (actualH >= 7 && actualH < 9) || (actualH >= 17 && actualH < 23)}
															<rect x={((hour - renderStart) / TOTAL_CELLS) * 100} y="0" width={100 / TOTAL_CELLS} height="40" />
														{/if}
													{/each}
												</clipPath>
												<path
													d={(arcMode === 'progress' ? cachedProgressPaths.get(entry.id) : cachedDaylightPaths.get(entry.id)) ?? ''}
													fill="rgba(255,255,255,0.15)"
													stroke="rgba(255,255,255,0.3)"
													stroke-width="0.5"
													vector-effect="non-scaling-stroke"
													clip-path="url(#ext-clip-{rowIndex})"
												/>
											{:else}
												<path
													d={(arcMode === 'progress' ? cachedProgressPaths.get(entry.id) : cachedDaylightPaths.get(entry.id)) ?? ''}
													fill="url(#daylight-{rowIndex})"
													stroke="rgba(255,255,255,0.15)"
													stroke-width="0.4"
													vector-effect="non-scaling-stroke"
												/>
											{/if}
										</svg>
										<!-- Spacer for virtualized cells before visible range -->
										<div class="shrink-0" style="width: {(visibleRange.start - renderStart) * cellWidth}px"></div>
										{#each visibleRenderHours as hour (hour)}
											{@const tzHour = getHourForTimezone(entry.id, hour)}
											{@const actualHour = getTzHourValue(entry.id, hour)}
											{@const isNow = hour === (cachedNowCell.get(entry.id) ?? -1)}
											{@const isMidnight = actualHour === 0}
											{@const dayColor = getDayColor(tzHour.dayOffset)}
											{@const workHour = actualHour >= 9 && actualHour < 17}
											{@const extHour = (actualHour >= 7 && actualHour < 9) || (actualHour >= 17 && actualHour < 23)}
											{@const isOverlap = showWorkingHours && isOverlapWorkingHour(hour)}
											{@const dimCell = showWorkingHours && !workHour && !extHour}
											{@const dimExt = showWorkingHours && extHour}
											<div
												class="h-10 flex items-center justify-center relative shrink-0 z-10
													{isMidnight ? 'border-l-2' : 'border-l border-l-border/20'}
													{dimCell ? 'grayscale brightness-[0.4]' : ''}
													{dimExt ? 'brightness-[0.7]' : ''}"
												style="width: {cellWidth}px; background: {isOverlap ? 'rgba(34, 197, 94, 0.12)' : dayColor.bg}; {isMidnight ? `border-left-color: ${dimCell ? 'rgba(128,128,128,0.3)' : dayColor.border}` : ''}"
											>
												{#if isMidnight}
													{@const dateLabel = getMidnightDateLabel(tzHour.dayOffset)}
													<div class="flex flex-col items-center gap-0" style="{dimCell ? 'opacity: 0.3;' : ''}">
														<span class="text-[8px] font-semibold uppercase tracking-wider leading-none" style="color: {dimCell ? 'rgb(128,128,128)' : dayColor.text}">{dateLabel.month}</span>
														<span class="text-[15px] font-bold leading-tight" style="color: {dimCell ? 'rgb(128,128,128)' : dayColor.text}">{dateLabel.day}</span>
													</div>
												{:else}
													<span class="text-xs font-medium
														{isNow
															? ''
															: actualHour >= 9 && actualHour < 17
																? 'text-foreground'
																: actualHour >= 22 || actualHour < 6
																	? 'text-muted-foreground/60'
																	: 'text-foreground/70'}"
														style="{isNow ? `color: ${dayColor.text}` : ''}">
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

<!-- Marker dot tooltip (fixed position, portaled outside grid) -->
{#if dotTooltip}
	{@const marker = markers.find(m => m.id === dotTooltip!.markerId)}
	{@const tz = selectedTimezones[dotTooltip!.rowIndex]}
	{#if marker && tz}
		{@const info = formatMarkerTimeWithDate(marker.utcHour, tz.id)}
		{@const endInfo = marker.utcHourEnd !== null ? formatMarkerTimeWithDate(marker.utcHourEnd, tz.id) : null}
		<div
			class="fixed z-50 pointer-events-none px-2.5 py-1.5 rounded-md shadow-lg border border-border/50 bg-popover text-popover-foreground text-xs whitespace-nowrap"
			style="left: {dotTooltip.x}px; {dotTooltip.position === 'above' ? `bottom: ${window.innerHeight - dotTooltip.y + 8}px` : `top: ${dotTooltip.y + 8}px`}; transform: translateX(-50%);"
		>
			<div class="flex items-center gap-1.5">
				<div class="w-[6px] h-[6px] rounded-full shrink-0" style="background: {marker.color}"></div>
				{#if endInfo}
					<span class="font-semibold">{formatMarkerTime(Math.min(marker.utcHour, marker.utcHourEnd ?? marker.utcHour), tz.id)} – {formatMarkerTime(Math.max(marker.utcHour, marker.utcHourEnd ?? marker.utcHour), tz.id)}</span>
				{:else}
					<span class="font-semibold">{info.time}</span>
				{/if}
			</div>
			{#if info.isDifferentDay || (endInfo && endInfo.isDifferentDay)}
				<div class="text-[10px] text-muted-foreground mt-0.5">{info.date}</div>
			{/if}
		</div>
	{/if}
{/if}
