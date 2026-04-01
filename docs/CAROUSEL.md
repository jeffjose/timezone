# Carousel Behavior Design

This document captures the desired behavior and current implementation state of the two carousel-like components in the timezone app.

---

## 1. Timezone Grid (Hour Cells)

### Desired Behavior
- **Infinite horizontal scrolling** of hour cells across all timezones
- **Current time centered** on initial load
- **Click and drag** to pan freely in either direction
- **`<` and `>` buttons** smoothly slide the grid by 24 hours (one day) with a CSS transition
- **Date nav clicks** jump to that day with a crossfade animation (old cells fade out + slide, new cells fade in + slide — overlapping)
- **Now-line** (blue vertical bar) stays at the correct position regardless of scroll
- **:30/:45 timezone offsets** handled by shifting each row's strip by a fractional cell amount
- Dragging should feel smooth — no jank, no text selection

### Current Implementation
- `centerHour` (state) = the ref timezone hour at the center of the viewport. Fractional (e.g., 19.5 = 7:30pm today, 43.5 = 7:30pm tomorrow)
- `renderAnchor` (state) = stable anchor for which hours are rendered. Only updates when `centerHour` drifts >96 hours away. Prevents DOM rebuilds during drag/transitions
- `renderHours` (derived) = array of 264 integers (11 days), centered on `renderAnchor`. Each cell is an `<div>` with fixed pixel width (`cellWidth = containerWidth / 24`)
- `stripTranslateX` (derived) = pixel offset to position the strip so `centerHour` is at viewport center
- Each row's strip has `transform: translateX(stripTranslateX + offsetCells * cellWidth)` where `offsetCells` handles :30/:45 shifts
- `smoothPan` flag enables `transition-transform duration-300` on strips for `<`/`>` animated sliding
- Grid reanchor only happens when `smoothPan === false` to avoid mid-transition DOM rebuilds
- Drag: `svelte:window` `onmousemove` updates `centerHour` directly (no transition)
- `will-change-transform` on strips for GPU compositing

### Known Issues / Tradeoffs
- Grid reanchor (DOM rebuild of 264 cells × N timezones) can cause a brief visual artifact if it happens during or immediately after a transition
- The reanchor threshold (96 hours) allows ~4 day-clicks before rebuild. Could increase buffer but costs more DOM nodes

---

## 2. Date Navigation Bar (Day Pills)

### Desired Behavior (Aspirational — Not Yet Implemented)
- Should behave like a synced carousel: as the grid scrolls, the date pills slide in the same direction
- When `<`/`>` shifts the grid by one day, the date pills should smoothly slide by one pill width in sync
- When dragging the grid, the pills should move proportionally (1 pill per 24 hours of grid movement)
- The "active" pill (currently centered day) should always be visually highlighted
- Clicking a pill should jump the grid to that day

### Current Implementation (Simple/Static with Sync)
- 7 static pills rendered centered on `selectedDate` (derived from `viewDayOffset = Math.floor(centerHour / 24)`)
- **Synced with grid**: `selectedDate` is derived from `centerHour`, so dragging the grid or pressing `<`/`>` automatically updates which day is highlighted when the view crosses a day boundary
- Active pill highlighted with `bg-primary text-primary-foreground`
- Today pill has blue tint
- No sliding animation on pills — they snap to new values when the day changes
- The sync behavior works correctly, but the visual transition is instant (not a smooth slide)

### What Was Tried and Why It Didn't Work

**Attempt 1: Carousel with translateX + anchor**
- Rendered 21 pills, used `navAnchorOffset` (like grid's `renderAnchor`) to keep DOM stable
- `navTranslateX` positioned the strip so the current day was centered, driven by `centerHour`
- `smoothPan` transition applied to the pill strip for `<`/`>` animation
- **Problem**: When the anchor re-synced (DOM rebuild), pills would flash/go blank for a frame. The reanchor timing was hard to get right — too early and it interrupts transitions, too late and pills run out of buffer
- **Problem**: `selectedDate` (highlight) updated instantly via `viewDayOffset`, but pills slid via CSS transition — causing two pills to appear "selected" simultaneously during the slide

**Attempt 2: Fixed highlight overlay**
- Placed a fixed `bg-primary` div at the center slot position
- Pills slid underneath it, no per-pill highlight logic
- **Problem**: Text colors still needed to change per-pill to contrast with the highlight, and the timing was still off. The overlay approach felt hacky and the text was sometimes invisible

**Root Cause**
The fundamental difficulty: Svelte re-renders DOM when the data array changes (pills entering/leaving the rendered range). CSS transitions only work on elements that persist in the DOM. A carousel needs both: stable DOM elements (for transitions) AND dynamic data (for infinite scrolling). The grid solves this with a large buffer (264 cells) and rare reanchoring. For the date nav (only 7-21 pills visible), the buffer is too small relative to the step size (1 day), so reanchors happen frequently.

### Possible Solutions (Not Yet Tried)
1. **Render a large fixed set of pills** (e.g., 60 days) and never reanchor — just let `translateX` position them. Simple, no reanchor artifacts, at the cost of ~60 DOM nodes (trivial)
2. **Use Svelte transitions** (`in:fly`, `out:fly`) on individual pills as they enter/leave — handles DOM churn gracefully
3. **Virtual scroll with recycling** — reuse DOM nodes and update their content, keeping the same elements in the DOM. More complex but truly infinite
4. **Accept static pills** — the current simple approach works. The grid carousel provides the smooth scrolling experience; the date nav is just a quick-jump tool. The visual snap when crossing a day boundary is acceptable

---

## Shared Infrastructure

### Animation for Date Nav Clicks (crossfade)
- Uses CSS `@keyframes` (`nav-slide-left`, `nav-slide-right`) defined in `app.css`
- Two chained animations: fade-out (100ms) + fade-in (100ms, starting at 80ms for overlap)
- Applied as a class (`navCellsAnimation`) on each row's cells-area div
- Data updates at 80ms (midpoint) via `setTimeout` in `animateNav()`

### Animation for `<`/`>` (smooth pan)
- `smoothPan` flag adds `transition-transform duration-300 ease-in-out` to grid strips
- `centerHour` update deferred to `requestAnimationFrame` so the transition class is rendered first
- `smoothPan` cleared after 350ms

### Drag to Pan
- `mousedown` on grid starts drag, `mousemove` on `svelte:window` updates `centerHour`, `mouseup` ends
- No transition during drag (`smoothPan = false`)
- `select-none` on root prevents text selection
- Hover line hidden during drag
