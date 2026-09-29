# LX Search 5.5

A fast medicine search combined with a calculator that supports several pricing models. You search on the left and build calculations on the right (on phones the calculation opens as a bottom sheet). Version 5.5 changes how you handle **many calculations at once**, and adds **rounding rules** you can set yourself.

## What's new in 5.5

### Multiple calculations
v5 had "saved orders", with separate save, load and "unfinished" autosave steps. v5.5 drops that model. Every calculation is now a live workspace that saves itself automatically. There is no Save button and nothing to lose.

- **Calculation rail**: a row of numbered, color-coded tabs under the tray header. Click a tab to switch. Double-click a tab to rename it. When there are more than 3 calculations, the inactive tabs shrink to just their number badge, so 9 or more still fit. The **+** button adds a calculation and the board button opens the overview.
- **Target chip in the search bar**: shows the calculation that new items will go into (number, color and name). Click it to pick another. Typing `#2` anywhere in a command (for example `concor 5 x30 #2`) sends that item to calc 2 **without switching** away from the one you're on. The chip changes live to show the override, and an unknown `#9` is flagged before you commit.
- **Which calc holds an item**: each search result shows a badge for the current calc (for example `2 · 1 pack`) plus small colored number badges for every *other* calc that contains it. Click a badge to jump to that calc. With 5 or more, the extra calcs collapse into a `+n` badge that opens the overview filtered to that medicine.
- **All calculations board** (`Alt B`): every calculation side by side as columns, with totals and a grand total.
  - Drag a medicine to another column to move it. Hold `Alt`, `Ctrl` or `⌘` while dropping to copy it instead.
  - Drag a column header to change the order.
  - Rename a calculation inline.
  - Use the `⋯` menu on a column to duplicate it, merge it into another, export it, clear it or delete it.
  - Filter to "which calcs contain Toujeo?".
  - Copy all, or export all as JSON or CSV.
  - On touch devices, tap a medicine to move or copy it (no dragging needed).
- **Moving a line from the tray**: the move icon on each line opens *Move to…* (or copy with the side icon), including *New calculation*. You can also drag a line's icon onto a tab in the rail. When the same medicine already exists in the target, the two are combined.
- **Calculation menu** (`⋯` in the tray header): rename, pick a color (10 hues), duplicate, merge into another calc, copy, JSON, CSV, clear, delete. Every destructive action has an Undo toast.
- **Grand total row** in the tray footer whenever there is more than one calc.
- **Detail sheet**: target pills let you add straight into any calc.
- **Command palette**: lists your calculations, and for a medicine it offers "Add to 3 · Ward 3" for the other calcs.
- **Keyboard**: `Alt 1–9` switch calc · `Alt [` / `Alt ]` previous / next · `Alt N` new · `Alt B` board.
- Limit: 30 calculations (was 10 orders).

### Rounding rules (Settings → Rounding rules)
- Set for each calculation type (Pack price, Insulin, Supply share): **Nearest** (the default), **Up**, or **Down**.
  - Example: 1020 IU with 300 IU pens = 3.4 pens → Nearest gives 3, Up gives 4, Down gives 3.
- Each rule shows live example chips calculated from real catalog pack sizes.
- **Never less than 1 pack** (on by default): a need above 0 never rounds to 0 packs.
- Changing a rule updates every calculation right away. Lines where you typed the pack count by hand keep it. These lines are marked **AUTO**; click that to go back to automatic.
- Lines show the exact fraction next to the pack count (for example `≈ 3.4`), and **short** units in red when rounding down leaves you under the need.
- An engine in `drugs.json` can set its own default, for example `"rounding": "ceil"`.

### Catalog: built in, refreshable (Settings → Medicine catalog)
- The medicine list is built into `js/data.js`, so `index.html` opens straight from disk (file://) with no server and no fetch.
- `data/drugs.json` is still the **single source of truth**. After you edit it, go to **Settings → Refresh from drugs.json**:
  - Over http it re-reads `data/drugs.json`. When opened from disk, or if that read fails, it opens a file picker so you can choose `drugs.json`.
  - The file is checked first. An invalid file is rejected and the current list stays in use.
  - The loaded list is saved (`localStorage.lx_catalog`) and used on every later start.
  - A toast reports what changed: new items, price changes, removed items.
  - Your calculations are kept, and their prices update to the new list.
- **Use built-in list** clears the saved list and goes back to `js/data.js`.
- To update the built-in list permanently, paste the contents of drugs.json into `js/data.js` after `window.LX_DATA = `.

### UI polish
- Calculation tabs: the number badge now sits beside the name and total, and all text stays inside the tab. This fixes a class clash (`.empty`) that stacked the tab contents vertically.
- Evenly spaced rail with a divider before the + and board buttons. The tray header, footer, action buttons and grand-total row have more room.

## Architecture
```
index.html          markup + inline SVG icon sprite
css/app.css         design tokens, 10-hue calc palette, dark/light, responsive + print
data/drugs.json     single source of truth (items, sources, tiers, engines, aliases, examples)
js/data.js          built-in copy of drugs.json (window.LX_DATA) so file:// works
js/theme-boot.js    sets the theme before first paint
js/engine.js        pure logic: parser (#n targeting), ROUND_MODES + packInfo, catalog, ranking, facets, cost
js/store.js         workspace of calculations, rounding prefs, transfer/merge/reorder, undo, persistence, migration
js/ui.js            helpers: icons, toasts (undo variants), clipboard, focus trap, popover (swap)
js/palette.js       ⌘K palette (medicines, commands, calculations)
js/app.js           rendering (finder, tray + rail, board, settings, detail), events, drag & drop, keyboard, boot
js/selftest.js      131 tests; open index.html?selftest=1 and read the console
```

## Data model
- Workspace (`localStorage.lx_workspace`): `{ v: 4, active, seq, calcs: [{ id, name, hue, created, updated, items: [[itemId, { req, packs, supplyPrice, manual, item }]] }] }`
- Refreshed catalog: `lx_catalog` (`{ from, at, data }`), used before the built-in list
- Preferences: `lx_rounding` (`{ engineId: 'round'|'ceil'|'floor' }`), `lx_min_one`, `lx_add_mode`, `lx_default_qty`, `lx_engine`, `lx_theme_mode`, `lx_recent`.
- **Migration** from v5 / v4.5 runs automatically on first load:
  - each saved order becomes a calculation;
  - the order that was active keeps your latest edits;
  - unsaved work becomes its own calculation;
  - pack counts that matched the old always-round-up result become automatic;
  - pack counts you had edited by hand stay manual.
- **Import**: accepts v4.5 and v5 single-order files, and v5.5 multi-calculation files (`{ calcs: [...] }`).
- **Export**: one calc, or all calcs, as JSON or CSV. The CSV has a Rounding column and subtotals.

## Entry points
- `index.html`: the app
- `index.html?selftest=1`: runs the test suite

## Not yet done / next steps
- Drag and drop on touch devices (tap menus are used instead for now)
- Offline support with a service worker
- Per-medicine rounding overrides (the model is per engine today)
- Printing several calculations at once from the board
