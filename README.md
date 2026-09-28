# LX Search 5

A fast medicine search and a calculator that supports several pricing models, combined into one app. You search on the left and build the order on the right (on phones the order opens as a bottom sheet). Every search result can be added to the calculation directly.

## Architecture

```
index.html          markup + inline SVG icon sprite (no icon font)
css/app.css         design tokens, dark/light themes, responsive + print
data/drugs.json     THE single source of truth (items, sources, tiers, engines, aliases, examples)
js/theme-boot.js    sets the theme before first paint
js/engine.js        pure logic: command parser, catalog builder, ranking, facets, cost models
js/store.js         state: lines, orders, prefs, recent, snapshot-based undo, persistence, migration
js/ui.js            helpers: SVG icons, toasts, clipboard, focus trap, popover, web links
js/palette.js       ⌘K command palette (medicines + commands + saved orders)
js/app.js           rendering (finder, tray, detail sheet), events, keyboard, boot
js/selftest.js      77 tests; run by opening index.html?selftest=1
```

### Data model (`data/drugs.json`)
- `items[]`: `name`, `unit`, `price`, and optionally `source`, `tier`, `engine`, `packUnits`. Fields you leave out fall back to `defaults`.
- `engines`: the calculation models.
  - `pack`: fixed price per pack. Quantities round up to whole packs.
  - `insulin`: dosed in IU, with 300 IU per pen by default (Toujeo overrides this to 450 via `packUnits`).
  - `supply`: the cost is `ratio` × the supply price you enter.
- `sources`, `tiers`: labels in English and Arabic.
- `aliases`: maps generic names to brands (for example bisoprolol → concor).
- `examples`: the command pills shown on the start screen.

To add a medicine or a new calculation model, you only edit this file.

## Features
- **Search**: results are ranked by exact name, first-word prefix, word prefix, generic alias, substring, and then typo tolerance. It also matches Arabic tier text, English tier labels, Arabic-Indic digits, and slashes typed with or without spaces. When nothing matches, it shows a "Did you mean" suggestion.
- **Facets**: a type bar with live counts, plus Unit, Source and Tier menus (also with counts) and sorting by relevance, name, or price in either direction.
- **Command grammar**: `concor 5 x30`, `x2p` (packs), `x900u` (base units), `@450` (supply price). The line under the search bar shows the resulting packs, spare units and cost before you commit.
- **Keyboard**: `/` focuses search, ↑↓ PgUp/PgDn Home/End move through results, Tab completes a name, Enter adds, Shift+Enter adds and keeps the query so you can repeat it, Ctrl/⌘+Enter adds and opens the tray, Esc steps back, Ctrl/⌘ Z undoes, Ctrl/⌘ S saves, Ctrl/⌘ K opens the palette.
- **Row quick-add**: a quantity pill on each row (plus a supply-price field for supply items), with web-search, copy and details buttons.
- **Detail sheet**: price per pack and per unit, an add form with a unit/pack toggle and live preview, and lookup links.
- **Tray**: steppers for units needed, packs and supply price; spare or short units; cost per line; the total; an editable order name.
- **Orders**: up to 10 saved orders. You can save, update, load, rename, duplicate and delete them. Unsaved work is kept automatically when you switch orders.
- **Undo**: snapshot-based, 25 steps, covering adds, edits, removals, clearing and order changes. Destructive actions show an undo toast that lasts 30 seconds.
- **Export and import**: copy a text summary, download JSON or CSV (with a total row), and import JSON files, including v4.5 files.
- **Other**: system, light and dark themes; print styles; changes sync across browser tabs; the parent iframe bridge from v4.5 (`lx:ready`, `lx:title`, `lx:theme`) still works.

## Storage
Everything is saved in the browser's `localStorage`, under the same keys as v4.5 (`lx_current_calc`, `lx_calc_orders`, `lx_engine`, `lx_add_mode`, `lx_default_qty`, `lx_theme_mode`) plus the new `lx_recent`, `lx_draft_name` and `lx_current_order`. The schema version is now 3. Item IDs are generated the same way as in v4.5, so existing saved data and files load as before. Entries that can't be matched are dropped.

## Entry points
- `index.html`: the app
- `index.html?selftest=1`: runs the test suite and prints results to the console

## Not yet done / next steps
- The catalog has to be served over http, because `fetch` of `data/drugs.json` doesn't work from `file://`.
- Offline support with a service worker
- A `favicon.ico` file (it is referenced but missing, as it was in v4.5)
- Optional: a price-history field in the JSON, and printing a single order
