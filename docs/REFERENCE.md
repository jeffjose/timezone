# Timezone Grid — Technical Reference

## Architecture: Two Synced Carousels

The UI has two synchronized infinite carousels driven by a single state variable:

```
centerHour (UTC fractional hours since UTC midnight today)
    |
    +---> Grid strip:  translateX = f(centerHour, cellWidth)
    |                   1 UTC hour = 1 cell
    |
    +---> Date strip:  translateX = f(centerHour, pillWidth)
                        24 UTC hours = 1 pill (1 day)
```

Both carousels derive their `translateX` from `centerHour`. Dragging either one updates `centerHour`, and both move. `<`/`>` buttons, date pill clicks, and calendar picker all animate `centerHour` via `smoothNavigate()`.

## Coordinate System

All internal positioning uses **UTC hours**. `centerHour = 0` means UTC midnight today. `centerHour = 13.5` means 1:30pm UTC today. `centerHour = -24` means UTC midnight yesterday.

This avoids PST/PDT ambiguity — timezone offsets are always computed from UTC via `getTimezoneOffset(tz, date)` which uses `Intl` APIs and handles DST correctly.

## Grid Cell Math

Each cell in the grid represents one UTC hour. The cell grid is shared across all timezone rows (same `translateX` base), so a vertical line at any position represents the same instant in time across all rows.

For each cell at UTC hour `H` in timezone `tz`:

```
offsetMinutes    = getTimezoneOffset(tz, date)     // e.g., -420 for PDT, +330 for IST
localTotalMinutes = H * 60 + offsetMinutes
localHour        = floor(localTotalMinutes / 60) % 24
minutes          = localTotalMinutes % 60
dayOffset        = floor(localTotalMinutes / (24 * 60))
```

For whole-hour-offset timezones (e.g., PDT = UTC-7), `minutes = 0` and the label is just the local hour.

## Fractional Offsets (:30 and :45 Timezones)

Timezones like India (UTC+5:30) and Nepal (UTC+5:45) have non-zero `minutes`. Without adjustment, cells would show labels like "6:30a", "7:30a" — technically correct but visually noisy.

### The Strip Shift

For fractional-offset timezones, the entire strip is shifted right by `fractionalOffset * cellWidth` pixels, where:

```
fractionalOffset = (offsetMinutes % 60) / 60     // 0.5 for :30, 0.75 for :45
```

This shifts cell boundaries so they align with the timezone's local hour boundaries. The cell that spans UTC 0:00–1:00 (which is local 5:30–6:30 for Kolkata) is shifted so its visual center sits at the local 6:00 mark.

### Label Rounding

With the strip shifted, the label rounds to the hour at the cell center:

```
labelHour = minutes >= 30 ? (localHour + 1) % 24 : localHour
```

So the cell spanning Kolkata's 5:30–6:30 is labeled "6a" (not "5:30a").

### Midnight Detection

`getTzHourValue()` applies the same rounding, so `actualHour === 0` correctly identifies the cell whose visual center is at local midnight.

### Now-Line and Blue Cell

The now-line is at UTC position `currentHourFrac` — a single vertical bar for all rows. For fractional-offset timezones, the strip shift means the visually-correct "current hour" cell is:

```
nowCell = floor(currentHourFrac - fractionalOffset)
```

This ensures the blue highlight appears on the cell the now-line visually passes through.

### Visual Example

```
UTC hours:    ...| 23  |  0  |  1  |  2  |  3  |  4  |  5  |...
                  |     |     |     |     |     |     |     |
LA (UTC-7):   ...| 4p  | 5p  | 6p  | 7p  | 8p  | 9p  | 10p |...
                  |     |     |     |     |     |     |     |
Oslo (UTC+2): ...| 1a  | 2a  | 3a  | 4a  | 5a  | 6a  | 7a  |...
                  |     |     |     |     |     |     |     |
Kolkata       ...|  5a  |  6a  |  7a  |  8a  |  9a  | 10a  | 11a |...
(UTC+5:30)       ↑ shifted 0.5 cells right
```

## Strip Positioning (translateX)

```
stripTranslateX = containerWidth / 2 - (centerHour - renderStart) * cellWidth
```

This places the cell at `centerHour` at the horizontal center of the viewport. Each row adds its fractional offset:

```
rowTranslateX = stripTranslateX + fractionalOffset * cellWidth
```

## Reanchoring (Infinite Scroll)

The grid renders 264 cells (11 days) centered on `renderAnchor`. When `centerHour` drifts >96 hours from `renderAnchor` (and no drag/transition is active), the anchor is updated:

```
renderAnchor = floor(centerHour)
```

This rebuilds the cell array but `stripTranslateX` compensates, so there's no visual jump. The `{#each}` uses keyed blocks `(hour)` so Svelte diffs efficiently — only edge cells are created/destroyed.

The date carousel uses the same approach: 61 pills, reanchors when drift > 20 days.

## Animation

One system: `smoothPan`. When `true`, CSS `transition-transform duration-300 ease-in-out` is added to both strips. All navigation (`<`/`>`, pill click, calendar, "today" button) uses:

```
smoothNavigate(targetCenter):
    cancel any pending timer
    smoothPan = true
    requestAnimationFrame -> centerHour = target
    setTimeout(350ms) -> smoothPan = false
```

Drag bypasses this — it updates `centerHour` directly with no transition.

## Performance: Avoiding Reactive Cascades

The `now` state updates every 1 second (for the live clock). To prevent this from re-rendering all 264 × N cells:

- **`offsetBase`** (non-reactive `let`): Used for timezone offset calculations instead of `now`. Updated only when `selectedDate` changes (day boundary).
- **`currentHourFrac`** (derived from `now`): Only used for now-line position and `cachedNowCell`. Not read inside cell rendering functions.
- **`cachedNowCell`** (derived Map): Computes the "now" UTC cell per timezone. Value only changes once per hour, so cells re-render hourly, not per-second.
- **`cachedDaylightPaths`** / **`cachedFractionalOffsets`** (derived Maps): Recompute only when timezones or `renderAnchor` change.

Functions called per-cell (`getHourForTimezone`, `getTzHourValue`) read only `offsetBase` (non-reactive) and no `$derived` values that change frequently.

## Date Carousel (Minimap)

The date nav strip works identically to the grid but at day scale:

```
navPillWidth         = navContainerWidth / 7        // 7 pills visible
navStripTranslateX   = navContainerWidth/2 - pillPos

where pillPos = (localDayFrac - navAnchorDay + NAV_DAYS_HALF) * navPillWidth
and   localDayFrac = (centerHour + refOffsetHours) / 24
```

Dragging the date strip scales mouse movement by `24 / navPillWidth` to convert pixel delta to `centerHour` delta (1 pill = 24 hours).
