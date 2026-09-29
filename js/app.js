const App = {
  data: null,
  db: [],
  view: { facets: { type: 'all', unit: 'all', source: 'all', tier: 'all' }, sort: 'relevance' },
  results: [],
  tokens: [],
  sel: -1,
  armed: false,
  armedId: null,
  omniState: 'IDLE',
  lastFocus: null,
  detail: null,
  drag: null
};
const els = {};
const rowCache = new Map();
const coarse = () => window.matchMedia('(hover: none), (pointer: coarse)').matches;
const narrow = () => window.matchMedia('(max-width: 880px)').matches;
const VERSION = '5.5';

const SORTS = {
  relevance: { label: 'Relevance', icon: 'sparkle' },
  name: { label: 'Name A–Z', icon: 'list' },
  'price-asc': { label: 'Price: low to high', icon: 'sort' },
  'price-desc': { label: 'Price: high to low', icon: 'sort' }
};
const THEME = { system: { icon: 'auto', label: 'System' }, light: { icon: 'sun', label: 'Light' }, dark: { icon: 'moon', label: 'Dark' } };
const themeQuery = window.matchMedia('(prefers-color-scheme: light)');

const applyTheme = () => {
  const mode = document.documentElement.getAttribute('data-theme-mode') || 'system';
  const eff = mode === 'system' ? (themeQuery.matches ? 'light' : 'dark') : mode;
  document.documentElement.setAttribute('data-theme', eff);
  const u = $('themeIconUse');
  if (u) u.setAttribute('href', `#i-${THEME[mode].icon}`);
  const b = $('themeBtn');
  if (b) b.title = `Theme: ${THEME[mode].label}`;
};
const setTheme = (mode, silent) => {
  document.documentElement.setAttribute('data-theme-mode', mode);
  try { localStorage.setItem('lx_theme_mode', mode); } catch (e) {}
  applyTheme();
  if (settingsOpen()) renderSettings();
  if (!silent) Toast.show(`Theme: ${THEME[mode].label}`, 'ok', THEME[mode].icon);
};
const cycleTheme = () => {
  const order = ['system', 'light', 'dark'];
  const cur = document.documentElement.getAttribute('data-theme-mode') || 'system';
  setTheme(order[(order.indexOf(cur) + 1) % order.length]);
};
themeQuery.addEventListener('change', () => { if ((document.documentElement.getAttribute('data-theme-mode') || 'system') === 'system') applyTheme(); });

const addMode = () => Store.state.prefs.addMode;
const quickQty = () => Store.state.prefs.quickQty || 1;
const reqFrom = (qty, unit, item) => (unit === 'pack' || (unit !== 'unit' && addMode() === 'pack')) ? qty * item.bQty : qty;
const multi = () => Store.state.calcs.length > 1;
const hueCls = (c) => `hue-${c.hue}`;
const calcPos = (c) => Store.indexOf(c.id) + 1;
const numBadge = (c, extra = '') => `<span class="num ${hueCls(c)}${extra}">${calcPos(c)}</span>`;
const packNoun = (item) => item.bType === 'IU' ? item.u.toLowerCase() : 'pack';
const packWord = (item, n) => `${fmtNum(n)} ${packNoun(item)}${n === 1 ? '' : 's'}`;
const fullMsg = () => Toast.show(`Maximum ${MAX_CALCS} calculations — merge or delete one first`, 'warn');

const sortResults = (list) => {
  const s = App.view.sort;
  if (s === 'name') return list.slice().sort(naturalCmp);
  if (s === 'price-asc' || s === 'price-desc') {
    const dir = s === 'price-asc' ? 1 : -1;
    return list.slice().sort((a, b) => (a.isDynamic - b.isDynamic) || dir * (a.pP - b.pP) || naturalCmp(a, b));
  }
  return list;
};

const resolveTarget = (intent) => {
  if (!intent.query) return null;
  const r = searchCatalog(App.db, intent.query, App.view.facets);
  return r.length ? { item: r[0] } : null;
};
const getTarget = (intent) => {
  if (App.sel >= 0 && App.results[App.sel]) return { item: App.results[App.sel] };
  if (App.armed && App.armedId && Store.get(App.armedId)) return { item: Store.get(App.armedId) };
  return resolveTarget(intent);
};
const intentCalc = (intent) => intent.calc != null ? Store.byPosition(intent.calc) : Store.activeCalc();
const computeState = (intent, target) => {
  if (!intent.query) return 'IDLE';
  if (target && (intent.qty != null || App.armed)) {
    if (target.item.isDynamic && intent.price == null) return 'ARMED_NEEDS_PRICE';
    return intent.qty != null ? 'ARMED_WITH_QTY' : 'ARMED_PENDING_QTY';
  }
  return 'SEARCHING';
};

const preview = (intent, target) => {
  if (!intent.query) return { text: '', ok: false, idle: true };
  if (intent.qtyInvalid) return { text: 'Quantity must be greater than 0', ok: false };
  if (intent.calc != null && !Store.byPosition(intent.calc)) return { text: `There is no calculation #${intent.calc} — you have ${Store.state.calcs.length}`, ok: false };
  if (!target) return { text: `No match for "${intent.query}"`, ok: false };
  const item = target.item;
  if (item.isDynamic && intent.price == null && (intent.qty != null || App.armed)) return { text: `${item.n} needs a supply price — type @450 or press Tab`, ok: false };
  if (intent.qty == null && !App.armed) return { text: `${item.n} · ${item.u} · ${priceLabel(item)}`, ok: true, key: '⏎', tail: 'to pick · Tab completes' };
  const qty = intent.qty != null ? intent.qty : quickQty();
  const req = reqFrom(qty, intent.unit || 'default', item);
  const { packs, spare, short } = Store.packsFor(item, req);
  const costP = costOf(item, packs, intent.price || 0);
  const extra = spare > 0 ? ` · ${fmtNum(spare)} ${item.bType} spare` : short > 0 ? ` · ${fmtNum(short)} ${item.bType} short` : '';
  const c = intentCalc(intent);
  const dest = multi() || intent.calc != null ? ` → ${c.name}` : '';
  return { text: `Add ${item.n} — ${fmtNum(req)} ${item.bType} → ${packWord(item, packs)}${extra} · ${money(costP)} EGP${dest}`, ok: true, key: '⏎', add: true };
};

const renderTarget = (intent) => {
  const ov = intent && intent.calc != null;
  const c = ov ? Store.byPosition(intent.calc) : Store.activeCalc();
  els.target.hidden = !multi() && !ov;
  els.target.className = `omni-target${c ? ' ' + hueCls(c) : ' bad'}${ov ? ' override' : ''}`;
  els.target.innerHTML = c ? `<span class="num">${calcPos(c)}</span><span class="omni-target-name">${esc(c.name)}</span>${icon('chev-down', 'sm')}` : `<span class="num">#${esc(String(intent.calc))}</span><span class="omni-target-name">Not found</span>`;
  els.target.setAttribute('aria-label', c ? `Adding to ${c.name}. Change calculation` : 'Calculation not found');
};

const updateHint = () => {
  const intent = parseCommand(els.in.value);
  const target = getTarget(intent);
  App.omniState = computeState(intent, target);
  const pv = preview(intent, target);
  const st = App.omniState;
  renderTarget(intent);
  els.hint.className = `hint${pv.ok ? ' ok' : ''}${!pv.ok && st !== 'IDLE' ? ' err' : ''}`;
  if (pv.idle) els.hint.innerHTML = `<kbd>/</kbd> focus · <kbd>${esc(MOD)} K</kbd> commands · <b class="hint-cmd">concor 5 x30</b> adds 30 tablets${multi() ? ' · <b class="hint-cmd">#2</b> sends to calc 2' : ''}`;
  else if (pv.add) els.hint.innerHTML = `<kbd>⏎</kbd> <b>${esc(pv.text)}</b>`;
  else if (pv.key) els.hint.innerHTML = `<kbd>${pv.key}</kbd> ${esc(pv.text)} <span class="hint-tail">${esc(pv.tail || '')}</span>`;
  else els.hint.textContent = pv.text;
  els.omnibar.classList.toggle('armed', st === 'ARMED_WITH_QTY' || st === 'ARMED_PENDING_QTY');
  els.omnibar.classList.toggle('needs-price', st === 'ARMED_NEEDS_PRICE');
  const showPrice = st === 'ARMED_NEEDS_PRICE';
  if (!showPrice && !els.priceWrap.hidden) { els.priceWrap.hidden = true; els.price.value = ''; }
  if (showPrice) els.priceWrap.hidden = false;
  els.lead.innerHTML = `<use href="#i-${st === 'ARMED_WITH_QTY' || st === 'ARMED_PENDING_QTY' ? 'calc' : st === 'ARMED_NEEDS_PRICE' ? 'percent' : 'search'}"/>`;
};

const renderTypeSeg = (query) => {
  const counts = facetCounts(App.db, query, App.view.facets, 'type');
  const total = Array.from(counts.values()).reduce((a, b) => a + b.count, 0);
  const cur = App.view.facets.type;
  const btn = (id, label, ic, n) => `<button class="seg-btn${cur === id ? ' on' : ''}" role="radio" aria-checked="${cur === id}" data-action="set-facet" data-facet="type" data-value="${esc(id)}">${icon(ic)}<span>${esc(label)}</span><span class="cnt">${n}</span></button>`;
  els.typeSeg.innerHTML = btn('all', 'All', 'grid', total) + Object.entries(App.data.engines).map(([id, e]) => btn(id, e.label, ENGINE_ICON[id] || 'box', (counts.get(id) || { count: 0 }).count)).join('');
};

const renderChips = () => {
  const f = App.view.facets;
  const chip = (key) => {
    const def = FACETS.find(x => x.key === key);
    const on = f[key] !== 'all';
    let label = def.any;
    if (on) { const it = App.db.find(i => def.get(i) === f[key]); label = it ? def.name(it) : f[key]; }
    return `<span class="chip-wrap"><button class="chip${on ? ' on' : ''}" data-action="facet-menu" data-id="${key}" aria-haspopup="true" aria-expanded="false"><span dir="auto">${esc(label)}</span>${on ? '' : icon('chev-down')}</button>${on ? `<button class="chip-x" data-action="clear-facet" data-id="${key}" aria-label="Clear ${esc(def.title)} filter">${icon('x')}</button>` : ''}</span>`;
  };
  const sortOn = App.view.sort !== 'relevance';
  const anyOn = FACETS.some(x => f[x.key] !== 'all') || sortOn;
  els.chips.innerHTML = ['unit', 'source', 'tier'].map(chip).join('') +
    `<button class="chip${sortOn ? ' on' : ''}" data-action="sort-menu" aria-haspopup="true" aria-expanded="false">${icon('sort')}<span>${esc(SORTS[App.view.sort].label)}</span></button>` +
    (anyOn ? `<button class="chip clear-all" data-action="clear-facets">${icon('x')}<span>Reset</span></button>` : '');
};

const renderModeSeg = () => {
  const m = addMode();
  ['unit', 'pack'].forEach(k => { const b = $(k === 'unit' ? 'modeUnit' : 'modePack'); b.classList.toggle('on', m === k); b.setAttribute('aria-checked', String(m === k)); });
};

const memberHTML = (item) => {
  const m = Store.membership(item.id);
  if (!m.length) return '';
  const act = m.find(x => x.active);
  const others = m.filter(x => !x.active);
  let h = '';
  if (act) h += `<span class="tag ok mb-here" title="In ${esc(act.calc.name)} (current)">${multi() ? `<span class="num ${hueCls(act.calc)}">${act.pos}</span>` : icon('check', 'sm')}${packWord(item, act.line.packs)}</span>`;
  if (others.length) {
    const shown = others.slice(0, 4);
    h += `<span class="mb" aria-label="Also in ${esc(others.map(x => x.calc.name).join(', '))}">${shown.map(x => `<button class="num ${hueCls(x.calc)}" data-action="switch-calc" data-cid="${esc(x.calc.id)}" title="${esc(x.calc.name)} · ${esc(packWord(item, x.line.packs))} — open">${x.pos}</button>`).join('')}${others.length > 4 ? `<button class="mb-more" data-action="open-board" data-filter="${esc(item.n)}" title="In ${others.length} other calculations">+${others.length - 4}</button>` : ''}</span>`;
  }
  return h;
};
const memberSig = (item) => Store.membership(item.id).map(x => `${x.pos}${x.calc.hue}${x.line.packs}${x.active ? '*' : ''}`).join(',');

const rowSig = (item) => `${App.tokens.join(' ')}|${addMode()}|${quickQty()}|${Store.state.calcs.length}|${memberSig(item)}`;
const rowHTML = (item) => {
  const pm = addMode() === 'pack';
  const id = esc(item.id);
  const sub = item.isDynamic ? esc(item.s) : esc(unitPriceLabel(item));
  return `${itemIcon(item)}
<div class="row-main">
<div class="row-title"><span class="nm" dir="auto">${highlight(item.n, App.tokens)}</span>${tierTag(item)}${memberHTML(item)}</div>
<div class="row-sub" dir="auto"><span>${highlight(item.u, App.tokens)}</span><span class="dot"></span><span class="price ${esc(item.engineId)}">${esc(priceLabel(item))}</span><span class="dot"></span><span>${sub}</span></div>
</div>
<div class="row-side" data-action="noop">
<div class="row-tools">
<button class="icon-btn" data-action="web-menu" data-id="${id}" title="Search the web" aria-label="Search the web for ${esc(item.n)}" aria-haspopup="true" aria-expanded="false">${icon('globe')}</button>
<button class="icon-btn" data-action="copy-item" data-id="${id}" title="Copy info" aria-label="Copy info for ${esc(item.n)}">${icon('copy')}</button>
<button class="icon-btn" data-action="details" data-id="${id}" title="Details" aria-label="Details for ${esc(item.n)}">${icon('info')}</button>
</div>
<div class="quick">
${item.isDynamic ? `<input type="number" inputmode="decimal" class="quick-in sp" id="qsp-${id}" data-id="${id}" data-field="sp" placeholder="Price" min="0" aria-label="Supply price for ${esc(item.n)}"><span class="sep"></span>` : ''}
<input type="number" inputmode="decimal" class="quick-in" id="qin-${id}" data-id="${id}" data-field="qty" placeholder="${esc(String(quickQty()))}" min="0" max="${MAX_QTY}" aria-label="Quantity for ${esc(item.n)}">
<span class="unit">${pm ? 'Packs' : esc(item.bType)}</span>
<button class="add-btn" data-action="quick-add" data-id="${id}" aria-label="Add ${esc(item.n)} to ${esc(Store.title())}">${icon('plus')}</button>
</div>
</div>`;
};
const buildRow = (item) => {
  const el = document.createElement('div');
  el.className = 'row';
  el.id = `row-${item.id}`;
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', 'false');
  el.dataset.action = 'arm';
  el.dataset.id = item.id;
  return el;
};
const paintRow = (el, item) => {
  const sig = rowSig(item);
  if (el._sig === sig) return;
  const keep = {};
  el.querySelectorAll('input').forEach(i => { if (i.value) keep[i.id] = i.value; });
  const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
  el.innerHTML = rowHTML(item);
  Object.entries(keep).forEach(([k, v]) => { const i = $(k); if (i) i.value = v; });
  if (focused && $(focused)) $(focused).focus({ preventScroll: true });
  const l = Store.state.lines.get(item.id);
  const act = Store.activeCalc();
  el.classList.toggle('in-tray', !!l);
  el.classList.remove(...Array.from(el.classList).filter(c => c.startsWith('hue-')));
  if (l && multi()) el.classList.add(hueCls(act));
  const others = Store.membership(item.id).filter(x => !x.active).map(x => x.calc.name);
  el.setAttribute('aria-label', `${item.n}${item.tLabel ? ', ' + item.tLabel : ''}, ${item.u}, ${priceLabel(item)}${l ? ', in current calculation' : ''}${others.length ? ', also in ' + others.join(', ') : ''}`);
  el._sig = sig;
};

const idleHTML = () => {
  const recent = Store.state.recent.map(id => Store.get(id)).filter(Boolean).slice(0, 6);
  const counts = facetCounts(App.db, '', App.view.facets, 'type');
  const desc = { pack: 'Priced per package. Needs are converted to whole packs.', insulin: 'Dose in IU. Converted to pens and cartridges.', supply: 'Cost is a share of the supply price you enter.' };
  const rnd = (id) => { const m = Store.state.prefs.rounding[id] || DEFAULT_ROUND; return `<span class="n">${ROUND_MODES[m].glyph} ${esc(ROUND_MODES[m].verb)}</span>`; };
  return `<div class="idle" data-idle>
${recent.length ? `<section class="idle-sec"><div class="idle-label">${icon('clock')}Recent<button class="link" data-action="clear-recent">Clear</button></div><div class="pills">${recent.map(i => `<button class="pill" data-action="arm" data-id="${esc(i.id)}">${icon(KIND_ICON[i.kind] || 'box')}<span dir="auto">${esc(i.n)}</span>${tierTag(i)}</button>`).join('')}</div></section>` : ''}
<section class="idle-sec"><div class="idle-label">${icon('bolt')}Try a command</div><div class="pills">${(App.data.examples || []).map(x => `<button class="pill" data-action="try" data-value="${esc(x)}"><code>${esc(x)}</code></button>`).join('')}${multi() ? `<button class="pill" data-action="try" data-value="concor 5 x30 #2"><code>concor 5 x30 #2</code></button>` : ''}</div></section>
<section class="idle-sec"><div class="idle-label">${icon('calc')}Browse by calculation type<button class="link" data-action="open-settings">Rounding rules</button></div><div class="engine-grid">${Object.entries(App.data.engines).map(([id, e]) => `<button class="engine-card" data-action="set-facet" data-facet="type" data-value="${esc(id)}"><span class="row-icon" data-engine="${esc(id)}">${icon(ENGINE_ICON[id] || 'box')}</span><b>${esc(e.label)}</b><span>${esc(desc[id] || '')}</span><span class="n">${(counts.get(id) || { count: 0 }).count} items</span>${rnd(id)}</button>`).join('')}</div></section>
<section class="idle-sec"><div class="idle-label">${icon('command')}Keyboard</div><div class="keys"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> move</span><span><kbd class="kbd">Tab</kbd> complete</span><span><kbd class="kbd">⏎</kbd> add</span><span><kbd class="kbd">⇧⏎</kbd> add &amp; repeat</span><span><kbd class="kbd">${esc(MOD)}Z</kbd> undo</span><span><kbd class="kbd">Alt N</kbd> new calc</span><span><kbd class="kbd">Alt 1–9</kbd> switch calc</span><span><kbd class="kbd">Alt B</kbd> all calcs</span></div></section>
</div>`;
};
const emptyHTML = (query) => {
  const sug = query ? suggestFor(App.db, query) : null;
  return `<div class="empty" data-empty><span class="empty-art">${icon('search')}</span><h3>${query ? `No matches for “${esc(query)}”` : 'Nothing matches these filters'}</h3><p>${sug ? `Did you mean <button class="suggest" data-action="try" data-value="${esc(sug)}">${esc(sug)}</button>?` : query ? 'Try a brand, a generic name like <b>bisoprolol</b>, or fewer words.' : 'Loosen a filter to see more items.'}</p>${FACETS.some(x => App.view.facets[x.key] !== 'all') ? `<button class="chip" data-action="clear-facets">${icon('x')}<span>Reset filters</span></button>` : ''}</div>`;
};

const paintResults = (query, isIdle) => {
  const list = els.res;
  if (isIdle) { rowCache.clear(); list.innerHTML = idleHTML(); return; }
  if (!App.results.length) { rowCache.clear(); list.innerHTML = emptyHTML(query); return; }
  list.querySelectorAll('[data-idle],[data-empty]').forEach(n => n.remove());
  const keep = new Set(App.results.map(i => i.id));
  rowCache.forEach((el, id) => { if (!keep.has(id)) { el.remove(); rowCache.delete(id); } });
  let ref = list.firstElementChild;
  App.results.forEach((item, idx) => {
    let el = rowCache.get(item.id);
    if (!el) {
      el = buildRow(item);
      rowCache.set(item.id, el);
      el.classList.add('enter');
      el.style.animationDelay = `${Math.min(idx, 16) * 12}ms`;
      el.addEventListener('animationend', () => { el.classList.remove('enter'); el.style.animationDelay = ''; }, { once: true });
    }
    paintRow(el, item);
    if (el === ref) ref = ref.nextElementSibling;
    else list.insertBefore(el, ref);
  });
};

const updateMeta = (query, isIdle) => {
  if (isIdle) { els.meta.innerHTML = `<span>${App.db.length} medicines</span><span>Updated catalog · v${esc(App.data.version)}</span>`; return; }
  const n = App.results.length;
  els.meta.innerHTML = `<span>${plural(n, 'result')}${App.view.sort !== 'relevance' ? ` · ${esc(SORTS[App.view.sort].label)}` : ''}</span>${n && !coarse() ? '<span>↑↓ to move · ⏎ to pick</span>' : ''}`;
};

const search = () => {
  Popover.close();
  const intent = parseCommand(els.in.value);
  const query = intent.query;
  const f = App.view.facets;
  const isIdle = !query && FACETS.every(x => f[x.key] === 'all');
  App.tokens = queryTokens(query);
  App.results = isIdle ? [] : sortResults(query ? searchCatalog(App.db, query, f) : searchCatalog(App.db, '', f).sort(naturalCmp));
  els.clear.hidden = !els.in.value;
  renderTypeSeg(query);
  renderChips();
  paintResults(query, isIdle);
  updateMeta(query, isIdle);
  App.sel = -1;
  if (App.armed && App.armedId) {
    const i = App.results.findIndex(r => r.id === App.armedId);
    if (i >= 0) App.sel = i;
  }
  applySelection(false);
};

const refreshRows = () => {
  if (!App.results.length) {
    if (els.res.querySelector('[data-idle]')) els.res.innerHTML = idleHTML();
    updateHint();
    return;
  }
  App.results.forEach(item => { const el = rowCache.get(item.id); if (el) paintRow(el, item); });
  applySelection(false);
};

const applySelection = (scroll = true) => {
  rowCache.forEach((el, id) => {
    const on = App.sel >= 0 && App.results[App.sel] && App.results[App.sel].id === id;
    el.classList.toggle('sel', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const cur = App.sel >= 0 && App.results[App.sel] ? rowCache.get(App.results[App.sel].id) : null;
  if (cur) { els.in.setAttribute('aria-activedescendant', cur.id); if (scroll) cur.scrollIntoView({ block: 'nearest' }); }
  else els.in.removeAttribute('aria-activedescendant');
  updateHint();
};
const moveSel = (d) => {
  const n = App.results.length;
  if (!n) return;
  if (App.sel === -1) App.sel = d > 0 ? 0 : n - 1;
  else if (Math.abs(d) > 1) App.sel = Math.max(0, Math.min(n - 1, App.sel + d));
  else App.sel = ((App.sel + d) % n + n) % n;
  if (App.armed && App.results[App.sel] && App.results[App.sel].id !== App.armedId) { App.armed = false; App.armedId = null; }
  applySelection();
};
const selectFirst = () => { if (App.results.length) { App.sel = 0; applySelection(); } };
const selectLast = () => { if (App.results.length) { App.sel = App.results.length - 1; applySelection(); } };

const armItem = (item) => {
  const intent = parseCommand(els.in.value);
  els.in.value = intent.calc != null ? `${item.n} #${intent.calc}` : item.n;
  App.armed = true;
  App.armedId = item.id;
  search();
  els.in.focus({ preventScroll: true });
  const end = intent.calc != null ? item.n.length : els.in.value.length;
  els.in.setSelectionRange(end, end);
};
const armById = (id) => {
  const item = Store.get(id);
  if (!item) return;
  if (coarse()) { openDetails(id); return; }
  armItem(item);
};

const pulse = (el, cls) => { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
const addFeedback = (r, item, opts = {}) => {
  const extra = r.spare > 0 ? ` · ${fmtNum(r.spare)} ${item.bType} spare` : r.short > 0 ? ` · ${fmtNum(r.short)} ${item.bType} short` : '';
  const dest = multi() ? ` → ${r.calc.name}` : '';
  Toast.show(`Added ${packWord(item, r.packs)} of ${item.n}${extra}${dest}`, 'ok', 'check');
  requestAnimationFrame(() => {
    if (r.calc.id === Store.state.active) {
      const line = $(`line-${item.id}`);
      if (line) { pulse(line, 'flash'); if (!narrow()) line.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
    pulse($(`tab-${r.calc.id}`), 'bump');
    pulse(els.trayBar, 'bump');
  });
  if (opts.openTray) openTray();
};
const failFeedback = (r, focusEl) => {
  if (r.reason === 'needs-price') { Toast.show('Enter a supply price first', 'warn'); if (focusEl) focusEl.focus({ preventScroll: true }); }
  else if (r.reason === 'invalid-qty') Toast.show('Enter a quantity above 0', 'warn');
  else if (r.reason === 'no-calc') Toast.show('That calculation does not exist', 'warn');
};

const commitIntent = (intent, target, opts = {}) => {
  if (!target) return false;
  const item = target.item;
  const qty = intent.qty != null ? intent.qty : (opts.useDefault ? quickQty() : null);
  if (qty == null || qty <= 0) return false;
  let calcId;
  if (intent.calc != null) {
    const c = Store.byPosition(intent.calc);
    if (!c) { Toast.show(`There is no calculation #${intent.calc}`, 'warn'); return false; }
    calcId = c.id;
  }
  const req = Math.min(MAX_QTY, reqFrom(qty, intent.unit || 'default', item));
  const sp = opts.price != null ? opts.price : (intent.price != null ? intent.price : NaN);
  const r = Store.add(item.id, req, item.isDynamic ? sp : 0, true, calcId);
  if (!r.ok) { failFeedback(r); return false; }
  App.armed = false;
  App.armedId = null;
  els.priceWrap.hidden = true;
  els.price.value = '';
  els.in.value = opts.keep || '';
  if (opts.keep) { App.armed = true; App.armedId = item.id; }
  search();
  els.in.focus({ preventScroll: true });
  if (opts.keep) els.in.select();
  addFeedback(r, item, { openTray: opts.openTray });
  return true;
};

const quickAdd = (id, btn) => {
  const item = Store.get(id);
  if (!item) return;
  const qIn = $(`qin-${id}`);
  const spIn = $(`qsp-${id}`);
  const raw = qIn && qIn.value.trim() !== '' ? parseFloat(qIn.value) : quickQty();
  const req = addMode() === 'pack' ? raw * item.bQty : raw;
  const sp = item.isDynamic ? (spIn && spIn.value.trim() !== '' ? parseFloat(spIn.value) : NaN) : 0;
  const r = Store.add(id, req, sp, true);
  if (!r.ok) { failFeedback(r, spIn); return; }
  const b = btn || document.querySelector(`#row-${CSS.escape(id)} .add-btn`);
  if (b) { b.classList.add('done'); b.innerHTML = icon('check'); setTimeout(() => { if (b.isConnected) { b.classList.remove('done'); b.innerHTML = icon('plus'); } }, 800); }
  const nq = $(`qin-${id}`), ns = $(`qsp-${id}`);
  if (nq) { nq.value = ''; nq.blur(); }
  if (ns) ns.value = '';
  addFeedback(r, item);
};

const copyItem = (id) => {
  const item = Store.get(id);
  if (!item) return;
  const text = `${item.n}${item.t ? ' ' + item.t : ''} | ${item.u} | ${priceLabel(item)}`;
  copyText(text).then(ok => Toast.show(ok ? `Copied ${item.n}` : 'Copy failed — select text manually', ok ? 'ok' : 'warn', ok ? 'copy' : 'warning'));
};

const webMenu = (id, anchor) => {
  const item = Store.get(id);
  if (!item) return;
  Popover.open(`web:${id}`, anchor, `<div class="menu-label">Search for ${esc(item.n)}</div>` + webLinks(item).map(l => `<a class="menu-item" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer" data-action="close-pop">${icon(l.icon)}<span class="grow">${esc(l.label)}</span>${icon('external', 'sm')}</a>`).join(''));
};

const facetMenu = (key, anchor) => {
  const def = FACETS.find(x => x.key === key);
  const counts = facetCounts(App.db, parseCommand(els.in.value).query, App.view.facets, key);
  const cur = App.view.facets[key];
  const all = Array.from(new Map(App.db.map(i => [def.get(i), def.name(i)])).entries()).sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
  const total = Array.from(counts.values()).reduce((a, b) => a + b.count, 0);
  const html = `<div class="menu-label">${esc(def.title)}</div><button class="menu-item${cur === 'all' ? ' on' : ''}" data-action="pick-facet" data-facet="${key}" data-value="all" role="menuitemradio" aria-checked="${cur === 'all'}"><span class="grow">${esc(def.any)}</span><span class="cnt">${total}</span></button>` +
    all.map(([v, name]) => { const c = (counts.get(v) || { count: 0 }).count; return `<button class="menu-item${cur === v ? ' on' : ''}${c ? '' : ' dim'}" data-action="pick-facet" data-facet="${key}" data-value="${esc(v)}" role="menuitemradio" aria-checked="${cur === v}"><span class="grow" dir="auto">${esc(name)}</span><span class="cnt">${c}</span></button>`; }).join('');
  Popover.open(`facet:${key}`, anchor, html);
};
const sortMenu = (anchor) => {
  Popover.open('sort', anchor, `<div class="menu-label">Sort by</div>` + Object.entries(SORTS).map(([k, s]) => `<button class="menu-item${App.view.sort === k ? ' on' : ''}" data-action="pick-sort" data-value="${k}" role="menuitemradio" aria-checked="${App.view.sort === k}">${icon(s.icon)}<span class="grow">${esc(s.label)}</span>${App.view.sort === k ? icon('check', 'sm') : ''}</button>`).join(''));
};
const setFacet = (key, value) => {
  App.view.facets[key] = App.view.facets[key] === value && key === 'type' && value !== 'all' ? 'all' : value;
  Popover.close();
  search();
};
const clearFacets = () => { FACETS.forEach(f => App.view.facets[f.key] = 'all'); App.view.sort = 'relevance'; Popover.close(); search(); };

const setAddMode = (m, silent) => {
  Store.setPref('addMode', m);
  renderModeSeg();
  refreshRows();
  updateHint();
  if (!silent) Toast.show(`Quantities now in ${m === 'pack' ? 'packs' : 'base units'}`, 'ok', m === 'pack' ? 'box' : 'ruler');
};
const setWeb = (k) => {
  Store.setPref('web', k);
  renderEngineMenu();
  $('engineMenu').classList.remove('open');
  $('engineBtn').setAttribute('aria-expanded', 'false');
  Toast.show(`Web search: ${WEB_ENGINES[k].label}`, 'ok', WEB_ENGINES[k].icon);
};
const setQuickQty = (n) => { Store.setPref('quickQty', n); refreshRows(); updateHint(); Toast.show(`Default quick-add quantity: ${n}`, 'ok', 'bolt'); };
const renderEngineMenu = () => {
  $('engineMenu').innerHTML = `<div class="menu-label">Web search engine</div>` + Object.entries(WEB_ENGINES).map(([k, e]) => `<button class="menu-item${Store.state.prefs.web === k ? ' on' : ''}" data-action="set-web" data-id="${k}" role="menuitemradio" aria-checked="${Store.state.prefs.web === k}">${icon(e.icon)}<span class="grow">${esc(e.label)}</span>${Store.state.prefs.web === k ? icon('check', 'sm') : ''}</button>`).join('');
};

const packLabel = (l) => {
  const it = l.item, id = esc(it.id);
  const mode = ROUND_MODES[Store.roundingFor(it)];
  const exact = +(l.req / (it.bQty || 1)).toFixed(2);
  if (l.manual) return `Packs <button class="lbl-link" data-action="reset-packs" data-id="${id}" title="Set by hand. Click to go back to automatic (${esc(mode.verb.toLowerCase())})">${icon('reset', 'xs')}auto</button>`;
  return `Packs${l.req > 0 && !Number.isInteger(exact) ? ` <span class="rnd" title="${esc(mode.verb)} · exact ${exact}">${mode.glyph} ${exact}</span>` : ''}`;
};
const needExtra = (l) => {
  const spare = Store.lineSpare(l), short = Store.lineShort(l);
  return spare > 0 ? `· ${fmtNum(spare)} spare` : short > 0 ? `<span class="short">· ${fmtNum(short)} short</span>` : '';
};

const lineHTML = (l) => {
  const it = l.item, id = esc(it.id);
  const stepper = (field, val, label) => `<div class="field${field === 'sp' ? ' sp' : ''}"><label for="ln-${field}-${id}" id="lbl-${field}-${id}">${label}</label><div class="stepper${field === 'sp' ? ' sp' : ''}${field === 'pack' && l.manual ? ' manual' : ''}" id="stp-${field}-${id}"><button class="step" data-action="step" data-id="${id}" data-field="${field}" data-d="-1" aria-label="Decrease">${icon('minus')}</button><input type="number" inputmode="decimal" class="line-in" id="ln-${field}-${id}" data-id="${id}" data-field="${field}" value="${esc(String(fmtNum(val)))}" min="0" max="${MAX_QTY}"><button class="step" data-action="step" data-id="${id}" data-field="${field}" data-d="1" aria-label="Increase">${icon('plus')}</button></div></div>`;
  return `<article class="line" id="line-${id}">
<div class="line-top"><span class="drag-handle" draggable="${coarse() ? 'false' : 'true'}" data-drag="line" data-id="${id}" data-from="${esc(Store.state.active)}" title="Drag onto another calculation">${itemIcon(it)}</span>
<div class="line-info"><div class="line-name"><span class="nm" dir="auto">${esc(it.n)}</span>${tierTag(it)}</div><div class="line-meta">${esc(String(it.bQty))} ${esc(it.bType)} / ${esc(packNoun(it))} · ${esc(it.isDynamic ? priceLabel(it) : it.p.toFixed(2) + ' EGP')}</div></div>
<div class="line-cost" id="lc-${id}">${money(Store.lineCostP(l))} <small>EGP</small></div>
<div class="line-tools">
<button class="icon-btn sm" data-action="line-move-menu" data-id="${id}" aria-haspopup="true" aria-expanded="false" title="Move or copy to another calculation" aria-label="Move ${esc(it.n)}">${icon('move')}</button>
<button class="icon-btn sm danger" data-action="remove-line" data-id="${id}" title="Remove" aria-label="Remove ${esc(it.n)}">${icon('trash')}</button>
</div>
</div>
<div class="line-ctrls">
${stepper('req', l.req, `Need · ${esc(it.bType)} <span class="spare" id="lsp-${id}">${needExtra(l)}</span>`)}
${stepper('pack', l.packs, packLabel(l))}
${it.isDynamic ? stepper('sp', l.sp, 'Supply price') : ''}
</div>
</article>`;
};

const patchLine = (id, skipField) => {
  const l = Store.state.lines.get(id);
  if (!l) return;
  const it = l.item;
  const set = (f, v) => { const i = $(`ln-${f}-${id}`); if (i && f !== skipField) i.value = fmtNum(v); };
  set('req', l.req); set('pack', l.packs); if (it.isDynamic) set('sp', l.sp);
  const c = $(`lc-${id}`); if (c) c.innerHTML = `${money(Store.lineCostP(l))} <small>EGP</small>`;
  const s = $(`lsp-${id}`); if (s) s.innerHTML = needExtra(l);
  const pl = $(`lbl-pack-${id}`); if (pl) pl.innerHTML = packLabel(l);
  const ps = $(`stp-pack-${id}`); if (ps) ps.classList.toggle('manual', !!l.manual);
};

const tabHTML = (c, i) => {
  const on = c.id === Store.state.active;
  const n = c.lines.size;
  return `<button class="tab ${hueCls(c)}${on ? ' on' : ''}${n ? '' : ' empty'}" id="tab-${esc(c.id)}" role="tab" aria-selected="${on}" data-action="switch-calc" data-cid="${esc(c.id)}" data-drop-cid="${esc(c.id)}" data-drag="calc" draggable="${coarse() ? 'false' : 'true'}" title="${esc(c.name)} · ${plural(n, 'item')} · ${money(Store.totalP(c.lines))} EGP${i < 9 ? ` · Alt ${i + 1}` : ''}"><span class="num">${i + 1}</span><span class="tab-text"><span class="tab-name">${esc(c.name)}</span><span class="tab-meta">${n ? `${money(Store.totalP(c.lines))}` : 'empty'}</span></span></button>`;
};

const renderRail = () => {
  const st = Store.state;
  const scroll = els.railTrack.scrollLeft;
  els.railTrack.innerHTML = st.calcs.map(tabHTML).join('');
  els.railTrack.scrollLeft = scroll;
  const on = $(`tab-${st.active}`);
  if (on) {
    const tr = els.railTrack.getBoundingClientRect(), r = on.getBoundingClientRect();
    if (r.left < tr.left) els.railTrack.scrollLeft -= tr.left - r.left + 8;
    else if (r.right > tr.right) els.railTrack.scrollLeft += r.right - tr.right + 8;
  }
  els.rail.classList.toggle('solo', st.calcs.length < 2);
  els.rail.classList.toggle('dense', st.calcs.length > 3);
};

const renderTotals = () => {
  const st = Store.state;
  const c = Store.activeCalc();
  const n = c.lines.size;
  const tot = money(Store.totalP(c));
  const packs = Store.packsTotal(c);
  els.trayTotal.innerHTML = `${tot} <small>EGP</small>`;
  els.traySub.textContent = n ? `${plural(n, 'item')} · ${plural(packs, 'pack')}` : 'No items yet';
  els.trayBarCount.textContent = n;
  els.trayBarLabel.textContent = c.name;
  els.trayBarTotal.textContent = `${tot} EGP`;
  const others = st.calcs.filter(x => x.id !== st.active);
  els.trayBarCalcs.innerHTML = multi() ? `<span class="num on">${calcPos(c)}</span>` + (others.length ? `<span class="num more">+${others.length}</span>` : '') : '';
  els.trayBar.classList.toggle('empty', !n && !multi());
  const g = Store.grandTotalP();
  els.grand.hidden = !multi();
  els.grand.innerHTML = `${icon('board', 'sm')}<span class="grow">All ${st.calcs.length} calculations</span><b>${money(g)} <small>EGP</small></b>${icon('chev-right', 'sm')}`;
  els.dockCount.textContent = st.calcs.length;
  els.dockCount.hidden = !multi();
  document.querySelectorAll('#tray [data-action="clear-tray"],#tray [data-action="copy-tray"],#tray [data-action="download-json"],#tray [data-action="download-csv"]').forEach(b => b.disabled = !n);
  document.title = multi() ? `${c.name} · LX Search ${VERSION}` : `LX Search ${VERSION}`;
};

const renderTray = () => {
  const st = Store.state;
  const c = Store.activeCalc();
  if (document.activeElement !== els.trayTitle) els.trayTitle.value = c.name;
  els.dot.className = `calc-dot ${hueCls(c)}`;
  els.dot.innerHTML = `<span class="num">${calcPos(c)}</span>`;
  els.trayStatus.textContent = `${calcPos(c)} of ${st.calcs.length}`;
  els.trayStatus.hidden = !multi();
  $('tray').style.setProperty('--calc', `var(--c${c.hue})`);
  renderRail();
  const lines = Array.from(c.lines.values()).reverse();
  els.lines.innerHTML = lines.length ? lines.map(lineHTML).join('') :
    `<div class="tray-empty"><span class="empty-art">${icon('tray')}</span><div><b class="tray-empty-title">${esc(c.name)} is empty</b><br>Search on the left and press ⏎,<br>or type <b class="hint-cmd">concor 5 x30</b>.${multi() ? `<br><span class="tray-empty-tip">Drag medicines here from another calculation's tab.</span>` : ''}</div></div>`;
  renderTotals();
};

const openTray = () => { if (!narrow()) return; document.body.classList.add('tray-open'); FocusTrap.set($('tray')); setTimeout(() => { const f = $('tray').querySelector('.tray-close'); if (f) f.focus({ preventScroll: true }); }, 60); };
const closeTray = () => { if (!document.body.classList.contains('tray-open')) return; document.body.classList.remove('tray-open'); FocusTrap.release(); };

const calcText = (c) => {
  let t = `${c.name}:\n\n`;
  c.lines.forEach(l => {
    const dp = l.item.isDynamic ? ` [Supply Price: ${l.sp}]` : '';
    t += `- ${l.item.n}${l.item.t ? ' ' + l.item.t : ''}: Req ${fmtNum(l.req)} ${l.item.bType} -> ${l.packs} Packs${dp} = ${money(Store.lineCostP(l))} EGP\n`;
  });
  return t + `\nTotal: ${money(Store.totalP(c))} EGP`;
};
const copyOut = (text, label) => copyText(text).then(ok => Toast.show(ok ? label : 'Copy failed — select text manually', ok ? 'ok' : 'warn', ok ? 'copy' : 'warning'));
const exportText = (cid) => { const c = cid ? Store.calc(cid) : Store.activeCalc(); if (c && c.lines.size) copyOut(calcText(c), `${c.name} copied`); };
const copyAll = () => {
  const cs = Store.state.calcs.filter(c => c.lines.size);
  if (!cs.length) { Toast.show('Nothing to copy yet', 'warn'); return; }
  copyOut(cs.map(calcText).join('\n\n———\n\n') + `\n\nGrand total (${plural(cs.length, 'calculation')}): ${money(Store.grandTotalP())} EGP`, `Copied ${plural(cs.length, 'calculation')}`);
};
const safeName = (s) => String(s).replace(/[^\w\u0600-\u06FF-]+/g, '_').slice(0, 40) || 'calc';
const downloadJSON = (cid) => {
  const c = cid ? Store.calc(cid) : Store.activeCalc();
  if (!c || !c.lines.size) return;
  download(new Blob([JSON.stringify({ app: 'LX Search', version: VERSION, title: c.name, total: `${money(Store.totalP(c))} EGP`, items: Store.serializeLines(c) }, null, 2)], { type: 'application/json' }), `LX_${safeName(c.name)}_${Date.now()}.json`);
  Toast.show('JSON download started', 'ok', 'download');
};
const downloadAllJSON = () => {
  const ws = Store.serializeWorkspace();
  download(new Blob([JSON.stringify({ app: 'LX Search', version: VERSION, grandTotal: `${money(Store.grandTotalP())} EGP`, calcs: ws.calcs }, null, 2)], { type: 'application/json' }), `LX_All_${Date.now()}.json`);
  Toast.show(`Downloading ${plural(ws.calcs.length, 'calculation')}`, 'ok', 'download');
};
const csvEsc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const CSV_HEAD = ['Name', 'Tag', 'Source', 'Type', 'Unit', 'Requested', 'Base Unit', 'Packs', 'Rounding', 'Price per Pack (EGP)', 'Supply Price (EGP)', 'Cost (EGP)'];
const csvRow = (l) => [l.item.n, l.item.t, l.item.s, l.item.engineLabel, l.item.u, fmtNum(l.req), l.item.bType, l.packs, l.manual ? 'Manual' : ROUND_MODES[Store.roundingFor(l.item)].label, l.item.isDynamic ? '' : l.item.p.toFixed(2), l.item.isDynamic ? Number(l.sp).toFixed(2) : '', money(Store.lineCostP(l))];
const saveCSV = (rows, name) => download(new Blob(['\uFEFF' + rows.map(r => r.map(csvEsc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }), name);
const downloadCSV = (cid) => {
  const c = cid ? Store.calc(cid) : Store.activeCalc();
  if (!c || !c.lines.size) return;
  const rows = Array.from(c.lines.values()).map(csvRow);
  rows.push(['Total', '', '', '', '', '', '', '', '', '', '', money(Store.totalP(c))]);
  saveCSV([CSV_HEAD, ...rows], `LX_${safeName(c.name)}_${Date.now()}.csv`);
  Toast.show('CSV download started', 'ok', 'table');
};
const downloadAllCSV = () => {
  const cs = Store.state.calcs.filter(c => c.lines.size);
  if (!cs.length) { Toast.show('Nothing to export yet', 'warn'); return; }
  const rows = [['Calculation', ...CSV_HEAD]];
  cs.forEach(c => { c.lines.forEach(l => rows.push([c.name, ...csvRow(l)])); rows.push([c.name, 'Subtotal', '', '', '', '', '', '', '', '', '', '', money(Store.totalP(c))]); });
  rows.push(['All', 'Grand total', '', '', '', '', '', '', '', '', '', '', money(Store.grandTotalP())]);
  saveCSV(rows, `LX_All_${Date.now()}.csv`);
  Toast.show('CSV download started', 'ok', 'table');
};

const switchCalc = (cid, opts = {}) => {
  const r = Store.switchTo(cid);
  if (!r.ok) return false;
  if (!r.same && !opts.silent && narrow() && !document.body.classList.contains('tray-open')) Toast.show(`Now on ${r.calc.name}`, 'ok', 'calc');
  return true;
};
const newCalc = (opts = {}) => {
  const r = Store.newCalc(null, { after: opts.after });
  if (!r.ok) { fullMsg(); return null; }
  if (opts.focusTitle && !coarse() && !narrow()) setTimeout(() => { els.trayTitle.focus(); els.trayTitle.select(); }, 30);
  else Toast.show(`Started ${r.calc.name}`, 'ok', 'plus');
  return r.calc;
};
const deleteCalc = (cid) => {
  const c = Store.calc(cid);
  if (!c) return;
  if (Store.state.calcs.length === 1 && !c.lines.size) { Toast.show('This is already empty', 'warn'); return; }
  const name = Store.deleteCalc(cid);
  if (name) Toast.undo(`Deleted ${name}`);
};
const duplicateCalc = (cid) => { const r = Store.duplicateCalc(cid); if (!r.ok) fullMsg(); else Toast.show(`Duplicated as ${r.calc.name}`, 'ok', 'copy'); };
const clearCalc = (cid) => { const c = Store.calc(cid) || Store.activeCalc(); const n = c.lines.size; if (Store.clear(c.id) && n) Toast.undo(`Cleared ${c.name}`); };
const mergeCalc = (from, to) => { const r = Store.mergeCalc(from, to); if (r.ok) Toast.undo(`Merged ${r.from.name} into ${r.to.name}${r.merged ? ` · ${r.merged} combined` : ''}`, 'merge', ''); };
const transfer = (itemId, from, to, mode) => {
  const r = Store.transferLine(itemId, from, to, mode);
  if (!r.ok) { if (r.reason === 'full') fullMsg(); return; }
  Toast.undo(`${mode === 'copy' ? 'Copied' : 'Moved'} ${r.item.n} → ${r.to.name}${r.merged ? ' (combined)' : ''}`, mode === 'copy' ? 'copy' : 'move', '', 8000);
  pulse($(`tab-${r.to.id}`), 'bump');
};
const removeLine = (id) => { const l = Store.state.lines.get(id); if (l && Store.remove(id)) Toast.undo(`Removed ${l.item.n}`); };
const clearTray = () => clearCalc(Store.state.active);
const doUndo = () => {
  Toast.clearUndo();
  const label = Store.undo();
  if (label) Toast.show(`Undid: ${label}`, 'ok', 'undo');
  else Toast.show('Nothing to undo', 'warn', 'undo');
};
const stepLine = (id, field, d) => {
  const l = Store.state.lines.get(id);
  if (!l) return;
  const step = field === 'req' ? (l.item.bType === 'IU' ? 10 : 1) : field === 'sp' ? 10 : 1;
  const cur = field === 'req' ? l.req : field === 'pack' ? l.packs : l.sp;
  const r = Store.edit(id, field, Math.max(0, cur + d * step));
  if (r.ok) patchLine(id);
};

const calcRowItem = (c, action, extra = '') => `<button class="menu-item calc-item" data-action="${action}" data-cid="${esc(c.id)}" ${extra}>${numBadge(c)}<span class="grow">${esc(c.name)}</span><span class="cnt">${c.lines.size ? money(Store.totalP(c.lines)) : 'empty'}</span></button>`;

const targetMenu = (anchor) => {
  const st = Store.state;
  Popover.open('target', anchor, `<div class="menu-label">Add medicines to</div>${st.calcs.map(c => `<button class="menu-item calc-item${c.id === st.active ? ' on' : ''}" data-action="switch-calc" data-cid="${esc(c.id)}">${numBadge(c)}<span class="grow">${esc(c.name)}</span><span class="cnt">${c.lines.size ? money(Store.totalP(c.lines)) : 'empty'}</span></button>`).join('')}<div class="menu-sep"></div><button class="menu-item" data-action="new-calc">${icon('plus')}<span class="grow">New calculation</span><kbd class="kbd">Alt N</kbd></button><div class="menu-foot">Tip: end a command with <b>#2</b> to add to calc 2 without switching.</div>`, 260);
};

const moveMenuHTML = (itemId, from) => {
  const item = Store.get(itemId);
  const others = Store.state.calcs.filter(c => c.id !== from);
  const row = (c) => {
    const has = c.lines.has(itemId);
    return `<div class="menu-split">${`<button class="menu-item calc-item" data-action="transfer" data-id="${esc(itemId)}" data-from="${esc(from)}" data-to="${esc(c.id)}" data-mode="move">${numBadge(c)}<span class="grow">${esc(c.name)}</span>${has ? '<span class="cnt">combine</span>' : ''}</button>`}<button class="menu-mini" data-action="transfer" data-id="${esc(itemId)}" data-from="${esc(from)}" data-to="${esc(c.id)}" data-mode="copy" title="Copy to ${esc(c.name)} (keep here too)" aria-label="Copy to ${esc(c.name)}">${icon('copy', 'sm')}</button></div>`;
  };
  return `<div class="menu-label">Move ${esc(item ? item.n : '')} to</div>${others.map(row).join('')}<div class="menu-split"><button class="menu-item" data-action="transfer" data-id="${esc(itemId)}" data-from="${esc(from)}" data-to="__new" data-mode="move">${icon('plus')}<span class="grow">New calculation</span></button><button class="menu-mini" data-action="transfer" data-id="${esc(itemId)}" data-from="${esc(from)}" data-to="__new" data-mode="copy" title="Copy to a new calculation" aria-label="Copy to a new calculation">${icon('copy', 'sm')}</button></div><div class="menu-foot">${icon('copy', 'xs')} copies and keeps it here too</div>`;
};

const swatchesHTML = (c) => `<div class="swatches" role="radiogroup" aria-label="Color">${Array.from({ length: HUES }, (_, h) => `<button class="swatch hue-${h}${c.hue === h ? ' on' : ''}" data-action="recolor" data-cid="${esc(c.id)}" data-hue="${h}" role="radio" aria-checked="${c.hue === h}" aria-label="Color ${h + 1}"></button>`).join('')}</div>`;

const calcMenuHTML = (cid, where) => {
  const c = Store.calc(cid);
  if (!c) return '';
  const n = c.lines.size;
  const others = Store.state.calcs.length > 1;
  const d = n ? '' : ' disabled';
  return `<div class="menu-label">${esc(c.name)}</div>
${where === 'board' && c.id !== Store.state.active ? `<button class="menu-item" data-action="open-calc" data-cid="${esc(cid)}">${icon('target')}<span class="grow">Open</span></button>` : ''}
<button class="menu-item" data-action="rename-calc" data-cid="${esc(cid)}" data-where="${where}">${icon('edit')}<span class="grow">Rename</span></button>
${swatchesHTML(c)}
<div class="menu-sep"></div>
<button class="menu-item" data-action="dup-calc" data-cid="${esc(cid)}">${icon('copy')}<span class="grow">Duplicate</span></button>
${others ? `<button class="menu-item" data-action="merge-menu" data-cid="${esc(cid)}"${d}>${icon('merge')}<span class="grow">Merge into…</span>${icon('chev-right', 'sm')}</button>` : ''}
<button class="menu-item" data-action="copy-calc" data-cid="${esc(cid)}"${d}>${icon('copy')}<span class="grow">Copy summary</span></button>
<button class="menu-item" data-action="json-calc" data-cid="${esc(cid)}"${d}>${icon('download')}<span class="grow">Download JSON</span></button>
<button class="menu-item" data-action="csv-calc" data-cid="${esc(cid)}"${d}>${icon('table')}<span class="grow">Download CSV</span></button>
<div class="menu-sep"></div>
<button class="menu-item" data-action="clear-calc" data-cid="${esc(cid)}"${d}>${icon('reset')}<span class="grow">Clear items</span></button>
<button class="menu-item danger" data-action="delete-calc" data-cid="${esc(cid)}">${icon('trash')}<span class="grow">Delete calculation</span></button>`;
};
const mergeMenuHTML = (cid) => {
  const c = Store.calc(cid);
  return `<button class="menu-item" data-action="calc-menu-back" data-cid="${esc(cid)}">${icon('chev-left')}<span class="grow">Back</span></button><div class="menu-label">Merge ${esc(c.name)} into</div>${Store.state.calcs.filter(x => x.id !== cid).map(x => `<button class="menu-item calc-item" data-action="merge-calc" data-from="${esc(cid)}" data-to="${esc(x.id)}">${numBadge(x)}<span class="grow">${esc(x.name)}</span><span class="cnt">${plural(x.lines.size, 'item')}</span></button>`).join('')}<div class="menu-foot">Same medicines are combined. ${esc(c.name)} is removed afterwards.</div>`;
};

const renameCalcUI = (cid, where) => {
  if (where === 'board') { const i = document.querySelector(`.col-name[data-cid="${CSS.escape(cid)}"]`); if (i) { i.focus(); i.select(); } return; }
  if (cid !== Store.state.active) Store.switchTo(cid);
  if (narrow()) openTray();
  setTimeout(() => { els.trayTitle.focus(); els.trayTitle.select(); }, narrow() ? 120 : 0);
};

const boardOpen = () => els.board.classList.contains('open');
const boardHTML = () => {
  const st = Store.state;
  const q = normalizeText(els.boardFilter.value);
  const drag = !coarse();
  const cols = st.calcs.map((c, i) => {
    const lines = Array.from(c.lines.values()).reverse();
    const nameHit = !q || normalizeText(c.name).includes(q);
    const hitOf = (l) => !!q && (l.item.nameN.includes(q) || l.item.words.some(w => w.startsWith(q)) || l.item.generics.some(g => g.startsWith(q)));
    const hits = lines.filter(hitOf).length;
    if (q && !nameHit && !hits) return '';
    const on = c.id === st.active;
    return `<section class="col ${hueCls(c)}${on ? ' on' : ''}" data-drop-cid="${esc(c.id)}" aria-label="${esc(c.name)}">
<header class="col-head" data-drag="calc" data-cid="${esc(c.id)}" draggable="${drag}">
${drag ? `<span class="col-grip" aria-hidden="true">${icon('drag', 'sm')}</span>` : ''}<span class="num">${i + 1}</span>
<input class="col-name" data-cid="${esc(c.id)}" value="${esc(c.name)}" maxlength="60" aria-label="Name of calculation ${i + 1}" spellcheck="false">
<button class="icon-btn sm" data-action="col-menu" data-cid="${esc(c.id)}" aria-haspopup="true" aria-expanded="false" aria-label="Actions for ${esc(c.name)}">${icon('more')}</button>
</header>
<div class="col-total"><b>${money(Store.totalP(c.lines))}</b> <small>EGP</small><span>${plural(lines.length, 'item')} · ${plural(Store.packsTotal(c.lines), 'pack')}</span></div>
<div class="col-items">${lines.length ? lines.map(l => `<button class="col-item${hitOf(l) ? ' hit' : ''}" data-drag="line" draggable="${drag}" data-id="${esc(l.item.id)}" data-from="${esc(c.id)}" data-action="board-item-menu" aria-haspopup="true" aria-expanded="false" title="${drag ? 'Drag to another calculation, or click for options' : 'Tap to move or copy'}">${itemIcon(l.item)}<span class="ci-main"><span class="ci-name" dir="auto">${esc(l.item.n)} ${tierTag(l.item)}</span><span class="ci-sub">${fmtNum(l.req)} ${esc(l.item.bType)} → ${esc(packWord(l.item, l.packs))}${l.manual ? ' · manual' : ''}</span></span><span class="ci-cost">${money(Store.lineCostP(l))}</span></button>`).join('') : `<div class="col-empty">${drag ? 'Drop medicines here' : 'No medicines yet'}</div>`}</div>
<footer class="col-foot">${on ? `<span class="col-current">${icon('check', 'sm')}Current</span>` : `<button class="pill-btn ghost" data-action="open-calc" data-cid="${esc(c.id)}">${icon('target')}<span>Open</span></button>`}</footer>
</section>`;
  }).join('');
  const any = cols.trim().length > 0;
  return (any ? cols : `<div class="board-none">No calculation contains “${esc(els.boardFilter.value)}”</div>`) + (q ? '' : `<button class="col col-new" data-action="new-calc-board" data-drop-cid="__new">${icon('plus', 'lg')}<b>New calculation</b><span>${drag ? 'or drop a medicine here' : ''}</span></button>`);
};
const renderBoard = () => {
  const st = Store.state;
  const items = st.calcs.reduce((a, c) => a + c.lines.size, 0);
  els.boardSub.innerHTML = `${plural(st.calcs.length, 'calculation')} · ${plural(items, 'line')} · <b>${money(Store.grandTotalP())} EGP</b>`;
  els.boardHint.innerHTML = coarse() ? `${icon('info', 'sm')}Tap a medicine to move or copy it · tap Open to work on a calculation` : `${icon('info', 'sm')}Drag medicines between calculations · hold <kbd class="kbd">Alt</kbd> while dropping to copy · drag a header to reorder · <kbd class="kbd">Alt 1–9</kbd> jumps straight to a calc`;
  const sl = els.boardCols.scrollLeft;
  els.boardCols.innerHTML = boardHTML();
  els.boardCols.scrollLeft = sl;
};
const openBoard = (filter) => {
  Popover.close();
  closeTray();
  App.lastFocus = document.activeElement;
  if (typeof filter === 'string') els.boardFilter.value = filter;
  renderBoard();
  els.board.classList.add('open');
  els.board.setAttribute('aria-hidden', 'false');
  FocusTrap.set(els.boardPanel);
  setTimeout(() => {
    if (!coarse()) (typeof filter === 'string' ? els.boardFilter : els.boardPanel).focus({ preventScroll: true });
    const on = els.boardCols.querySelector('.col.on');
    if (on) on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, 60);
};
const closeBoard = () => {
  if (!boardOpen()) return false;
  els.board.classList.remove('open');
  els.board.setAttribute('aria-hidden', 'true');
  FocusTrap.release();
  Popover.close();
  if (App.lastFocus && document.contains(App.lastFocus)) App.lastFocus.focus({ preventScroll: true });
  return true;
};

const settingsOpen = () => $('settingsModal').classList.contains('open');
const engineExample = (engineId) => {
  const items = App.db.filter(i => i.engineId === engineId && i.bQty > 1);
  if (!items.length) return null;
  const freq = new Map();
  items.forEach(i => freq.set(i.bQty, (freq.get(i.bQty) || 0) + 1));
  const q = Array.from(freq.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return items.find(i => i.bQty === q);
};
const exampleHTML = (it, mode) => {
  if (!it) return '<span>Sold one per pack — rounding never changes these.</span>';
  const q = it.bQty;
  return [0.4, 3.4, 3.6].map(f => {
    const r = Math.round(q * f);
    const p = packInfo(r, q, mode, Store.state.prefs.minOne).packs;
    return `<span class="ex">${fmtNum(r)} ${esc(it.bType)} <i>= ${fmtNum(r / q)}</i> → <b>${esc(packWord(it, p))}</b></span>`;
  }).join('');
};
const segBtn = (on, action, attrs, label, fkey) => `<button class="seg-btn${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-action="${action}" ${attrs} data-fkey="${esc(fkey)}">${label}</button>`;
const renderSettings = () => {
  const p = Store.state.prefs;
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fkey : null;
  const theme = document.documentElement.getAttribute('data-theme-mode') || 'system';
  const rows = Object.entries(App.data.engines).map(([id, e]) => {
    const mode = p.rounding[id] || DEFAULT_ROUND;
    const ex = engineExample(id);
    return `<div class="set-row rnd-row"><div class="set-label"><span class="row-icon" data-engine="${esc(id)}">${icon(ENGINE_ICON[id] || 'box')}</span><div><b>${esc(e.label)}</b><span>${ex ? `e.g. ${esc(ex.n)} · ${ex.bQty} ${esc(ex.bType)} per ${esc(packNoun(ex))}` : 'Single-unit packs'}</span></div></div>
<div class="seg" role="radiogroup" aria-label="${esc(e.label)} rounding">${Object.entries(ROUND_MODES).map(([k, m]) => segBtn(mode === k, 'set-rounding', `data-engine="${esc(id)}" data-mode="${k}"`, `<span class="glyph">${m.glyph}</span><span>${esc(m.label)}${k === DEFAULT_ROUND ? ' <small>default</small>' : ''}</span>`, `rnd:${id}:${k}`)).join('')}</div>
<div class="set-example">${exampleHTML(ex, mode)}</div></div>`;
  }).join('');
  $('settingsSheet').innerHTML = `<div class="sheet-head"><span class="row-icon">${icon('gear')}</span><div style="min-width:0"><h2 class="sheet-title" id="settingsTitle">Settings</h2><div class="sheet-desc">Saved on this device.</div></div><button class="icon-btn" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
<section class="set-sec"><div class="sheet-sec-label">Rounding rules</div><p class="set-help">When a need doesn't fill whole packs (like 1020 IU with 300 IU pens = 3.4 pens), choose what happens. <b>Nearest</b> gives 3, <b>Up</b> gives 4, <b>Down</b> gives 3. Every calculation updates right away. Packs you typed by hand stay as they are.</p>
${rows}
<label class="set-toggle"><span><b>Never less than 1 pack</b><span>If the need is above 0 but rounds to 0 packs, use 1 pack.</span></span><button class="switch${p.minOne ? ' on' : ''}" role="switch" aria-checked="${p.minOne}" data-action="toggle-min-one" data-fkey="minone" aria-label="Never less than 1 pack"></button></label>
<button class="link-btn" data-action="reset-rounding" data-fkey="rreset">${icon('reset')}Reset to nearest</button></section>
<section class="set-sec"><div class="sheet-sec-label">Adding medicines</div>
<div class="set-line"><span>Quantities typed as</span><div class="seg" role="radiogroup">${segBtn(p.addMode === 'unit', 'set-add-mode', 'data-id="unit"', `${icon('ruler')}<span>Units</span>`, 'am:unit')}${segBtn(p.addMode === 'pack', 'set-add-mode', 'data-id="pack"', `${icon('box')}<span>Packs</span>`, 'am:pack')}</div></div>
<div class="set-line"><span>Default quick-add quantity</span><div class="seg" role="radiogroup">${QUICK_SIZES.map(n => segBtn(quickQty() === n, 'set-quick-qty', `data-value="${n}"`, String(n), `qq:${n}`)).join('')}</div></div></section>
<section class="set-sec"><div class="sheet-sec-label">Appearance &amp; lookups</div>
<div class="set-line"><span>Theme</span><div class="seg" role="radiogroup">${['system', 'light', 'dark'].map(m => segBtn(theme === m, 'set-theme', `data-value="${m}"`, `${icon(THEME[m].icon)}<span>${THEME[m].label}</span>`, `th:${m}`)).join('')}</div></div>
<div class="set-line"><span>Web search</span><div class="seg wrap" role="radiogroup">${Object.entries(WEB_ENGINES).map(([k, w]) => segBtn(p.web === k, 'set-web-pref', `data-id="${k}"`, `<span>${esc(w.label.replace(' Search', ''))}</span>`, `web:${k}`)).join('')}</div></div></section>
<section class="set-sec"><div class="sheet-sec-label">Your data</div><div class="links">
<button class="link-btn" data-action="download-all-json">${icon('download')}Back up all calculations</button>
<button class="link-btn" data-action="open-file-upload">${icon('upload')}Import a file</button></div></section>`;
  if (focusKey) { const f = $('settingsSheet').querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`); if (f) f.focus({ preventScroll: true }); }
};
const openSettings = () => {
  Popover.close();
  closeBoard();
  App.lastFocus = document.activeElement;
  renderSettings();
  const m = $('settingsModal');
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  FocusTrap.set($('settingsSheet'));
  setTimeout(() => $('settingsSheet').focus({ preventScroll: true }), 60);
};
const setRounding = (engineId, mode) => {
  if ((Store.state.prefs.rounding[engineId] || DEFAULT_ROUND) === mode) return;
  const n = Store.setRounding(engineId, mode);
  Toast.show(`${App.data.engines[engineId].label}: ${ROUND_MODES[mode].verb.toLowerCase()}${n ? ` · ${plural(n, 'line')} updated` : ''}`, 'ok', 'calc');
};

const detailPreview = () => {
  const d = App.detail;
  if (!d) return;
  const item = Store.get(d.id);
  const qIn = $('dQty'), spIn = $('dSp');
  const raw = qIn.value.trim() === '' ? quickQty() : parseFloat(qIn.value);
  const sp = spIn ? parseFloat(spIn.value) : 0;
  const out = $('dPreview');
  if (!(raw > 0)) { out.textContent = 'Enter a quantity above 0'; return; }
  if (item.isDynamic && isNaN(sp)) { out.textContent = 'Enter the supply price to see the cost'; return; }
  const req = d.mode === 'pack' ? raw * item.bQty : raw;
  const { packs, spare, short } = Store.packsFor(item, req);
  const c = Store.calc(d.target) || Store.activeCalc();
  out.innerHTML = `<b>${fmtNum(req)} ${esc(item.bType)} → ${esc(packWord(item, packs))} · ${money(costOf(item, packs, sp))} EGP</b>${spare > 0 ? ` · ${fmtNum(spare)} spare` : short > 0 ? ` · <span class="short">${fmtNum(short)} short</span>` : ''}${multi() ? ` · into ${esc(c.name)}` : ''}`;
};
const detailTargets = () => {
  const d = App.detail;
  const box = $('dTargets');
  if (!box) return;
  box.innerHTML = Store.state.calcs.map(c => { const l = c.lines.get(d.id); return `<button class="tpill ${hueCls(c)}${c.id === d.target ? ' on' : ''}" role="radio" aria-checked="${c.id === d.target}" data-action="detail-target" data-cid="${esc(c.id)}"><span class="num">${calcPos(c)}</span><span>${esc(c.name)}</span>${l ? `<small>${esc(packWord(l.item, l.packs))}</small>` : ''}</button>`; }).join('');
};
const openDetails = (id) => {
  const item = Store.get(id);
  if (!item) return;
  Popover.close();
  App.lastFocus = document.activeElement;
  App.detail = { id, mode: addMode(), target: Store.state.active };
  const m = Store.membership(id);
  const sheet = $('detailSheet');
  const mode = ROUND_MODES[Store.roundingFor(item)];
  sheet.innerHTML = `<div class="sheet-head">${itemIcon(item)}<div style="min-width:0"><h2 class="sheet-title" id="detailTitle" dir="auto">${esc(item.n)}</h2><div class="sheet-tags">${tierTag(item)}<span class="tag src">${esc(item.u)}</span><span class="tag src">${esc(item.s)}</span><span class="tag">${esc(item.engineLabel)}</span>${m.map(x => `<span class="tag ok">${multi() ? `<span class="num ${hueCls(x.calc)}">${x.pos}</span>` : ''}${esc(multi() ? x.calc.name : 'In calculation')} · ${esc(packWord(item, x.line.packs))}</span>`).join('')}</div></div><button class="icon-btn" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
<div class="price-grid">${item.isDynamic ? `<div class="price-cell wide"><span>Price</span><b class="price supply">${Math.round(item.ratio * 100)}% of supply price</b></div>` : `<div class="price-cell"><span>1 ${esc(packNoun(item))} · ${esc(String(item.bQty))} ${esc(item.bType)}</span><b class="price ${esc(item.engineId)}">${item.p.toFixed(2)} EGP</b></div><div class="price-cell"><span>1 ${esc(item.bType)}</span><b class="price ${esc(item.engineId)}">${money(Math.round(item.pP / item.bQty))} EGP</b></div>`}</div>
<div class="sheet-sec-label">Add to ${multi() ? 'calculation' : esc(Store.title())}</div>
${multi() ? `<div class="target-pills" id="dTargets" role="radiogroup" aria-label="Target calculation"></div>` : ''}
<div class="sheet-add">
<div class="quick">${item.isDynamic ? `<input type="number" inputmode="decimal" class="sp" id="dSp" placeholder="Supply price" min="0" aria-label="Supply price"><span class="sep"></span>` : ''}<input type="number" inputmode="decimal" id="dQty" placeholder="${esc(String(quickQty()))}" min="0" max="${MAX_QTY}" aria-label="Quantity"><button class="add-btn" data-action="detail-add" aria-label="Add">${icon('plus')}</button></div>
<div class="seg" role="radiogroup" aria-label="Quantity unit"><button class="seg-btn" data-action="detail-mode" data-id="unit" id="dmUnit" role="radio">${esc(item.bType)}</button><button class="seg-btn" data-action="detail-mode" data-id="pack" id="dmPack" role="radio">${esc(packNoun(item)[0].toUpperCase() + packNoun(item).slice(1))}s</button></div>
</div>
<div class="sheet-preview" id="dPreview"></div>
${item.bQty > 1 ? `<div class="sheet-note">${icon('calc', 'sm')}<span>Rounding: <b>${esc(mode.verb.toLowerCase())}</b></span><button class="lbl-link" data-action="open-settings">change</button></div>` : ''}
<div class="sheet-sec-label">Look it up</div>
<div class="links">${webLinks(item).map(x => `<a class="link-btn" href="${esc(x.href)}" target="_blank" rel="noopener noreferrer">${icon(x.icon)}${esc(x.label)}</a>`).join('')}<button class="link-btn" data-action="copy-item" data-id="${esc(id)}">${icon('copy')}Copy info</button></div>`;
  detailTargets();
  syncDetailMode();
  detailPreview();
  $('detailModal').classList.add('open');
  $('detailModal').setAttribute('aria-hidden', 'false');
  FocusTrap.set(sheet);
  setTimeout(() => { const f = item.isDynamic ? $('dSp') : $('dQty'); if (f && !coarse()) f.focus({ preventScroll: true }); else sheet.focus({ preventScroll: true }); }, 80);
};
const syncDetailMode = () => { const m = App.detail.mode; $('dmUnit').classList.toggle('on', m === 'unit'); $('dmPack').classList.toggle('on', m === 'pack'); $('dmUnit').setAttribute('aria-checked', String(m === 'unit')); $('dmPack').setAttribute('aria-checked', String(m === 'pack')); };
const detailAdd = () => {
  const d = App.detail;
  const item = Store.get(d.id);
  const qIn = $('dQty'), spIn = $('dSp');
  const raw = qIn.value.trim() === '' ? quickQty() : parseFloat(qIn.value);
  const req = d.mode === 'pack' ? raw * item.bQty : raw;
  const sp = item.isDynamic ? (spIn.value.trim() === '' ? NaN : parseFloat(spIn.value)) : 0;
  const r = Store.add(item.id, req, sp, true, d.target);
  if (!r.ok) { failFeedback(r, spIn); return; }
  closeModal();
  addFeedback(r, item);
};
const closeModal = () => {
  const open = ['settingsModal', 'detailModal'].map($).find(m => m.classList.contains('open'));
  if (!open) return false;
  open.classList.remove('open');
  open.setAttribute('aria-hidden', 'true');
  FocusTrap.release();
  if (open.id === 'detailModal') App.detail = null;
  if (boardOpen()) FocusTrap.set(els.boardPanel);
  if (App.lastFocus && document.contains(App.lastFocus)) App.lastFocus.focus({ preventScroll: true });
  return true;
};

const tryExample = (v) => { els.in.value = v; App.armed = false; App.armedId = null; search(); els.in.focus({ preventScroll: true }); els.in.setSelectionRange(v.length, v.length); };

const ACTIONS = {
  noop: () => {},
  'cycle-theme': cycleTheme,
  'open-file-upload': () => $('fileUpload').click(),
  'toggle-engine-menu': () => { const m = $('engineMenu'); const o = m.classList.toggle('open'); $('engineBtn').setAttribute('aria-expanded', String(o)); },
  'set-web': (t) => setWeb(t.dataset.id),
  'set-web-pref': (t) => { Store.setPref('web', t.dataset.id); renderEngineMenu(); },
  'open-cmdk': () => Palette.open(),
  'clear-input': () => { els.in.value = ''; App.armed = false; App.armedId = null; search(); els.in.focus(); },
  'set-facet': (t) => setFacet(t.dataset.facet, t.dataset.value),
  'pick-facet': (t) => { setFacet(t.dataset.facet, t.dataset.value); },
  'clear-facet': (t) => setFacet(t.dataset.id, 'all'),
  'clear-facets': clearFacets,
  'facet-menu': (t) => facetMenu(t.dataset.id, t),
  'sort-menu': (t) => sortMenu(t),
  'pick-sort': (t) => { App.view.sort = t.dataset.value; Popover.close(); search(); },
  'set-add-mode': (t) => setAddMode(t.dataset.id, settingsOpen()),
  arm: (t) => armById(t.dataset.id),
  try: (t) => tryExample(t.dataset.value),
  'clear-recent': () => { Store.state.recent = []; Store.persist(); search(); },
  'quick-add': (t) => quickAdd(t.dataset.id, t),
  'web-menu': (t) => webMenu(t.dataset.id, t),
  'copy-item': (t) => copyItem(t.dataset.id),
  details: (t) => openDetails(t.dataset.id),
  'close-pop': () => setTimeout(() => Popover.close(), 0),
  'close-modal': closeModal,
  'detail-add': detailAdd,
  'detail-mode': (t) => { App.detail.mode = t.dataset.id; syncDetailMode(); detailPreview(); },
  'detail-target': (t) => { App.detail.target = t.dataset.cid; detailTargets(); detailPreview(); },
  'remove-line': (t) => removeLine(t.dataset.id),
  'reset-packs': (t) => { if (Store.resetPacks(t.dataset.id)) patchLine(t.dataset.id); },
  step: (t) => stepLine(t.dataset.id, t.dataset.field, parseInt(t.dataset.d, 10)),
  'clear-tray': clearTray,
  'copy-tray': () => exportText(),
  'download-json': () => downloadJSON(),
  'download-csv': () => downloadCSV(),
  'copy-calc': (t) => exportText(t.dataset.cid),
  'json-calc': (t) => downloadJSON(t.dataset.cid),
  'csv-calc': (t) => downloadCSV(t.dataset.cid),
  'copy-all': copyAll,
  'download-all-json': downloadAllJSON,
  'download-all-csv': downloadAllCSV,
  'save-order': () => Toast.show('Everything saves automatically', 'ok', 'save'),
  'new-calc': (t, e) => newCalc({ focusTitle: !!(e && e.detail) }),
  'new-calc-board': () => { if (newCalc()) setTimeout(() => { const cols = els.boardCols.querySelectorAll('.col-name'); const last = cols[cols.length - 1]; if (last && !coarse()) { last.focus(); last.select(); last.closest('.col').scrollIntoView({ inline: 'nearest', block: 'nearest' }); } }, 30); },
  'switch-calc': (t) => switchCalc(t.dataset.cid),
  'open-calc': (t) => { switchCalc(t.dataset.cid, { silent: true }); closeBoard(); if (narrow()) openTray(); },
  'target-menu': (t) => targetMenu(t),
  'calc-menu': (t) => Popover.open(`calc:${Store.state.active}`, t, calcMenuHTML(Store.state.active, 'tray'), 230),
  'col-menu': (t) => Popover.open(`col:${t.dataset.cid}`, t, calcMenuHTML(t.dataset.cid, 'board'), 230),
  'calc-menu-back': (t) => Popover.swap(`calc:${t.dataset.cid}`, calcMenuHTML(t.dataset.cid, boardOpen() ? 'board' : 'tray')),
  'color-menu': (t) => { const c = Store.activeCalc(); Popover.open(`color:${c.id}`, t, `<div class="menu-label">Color for ${esc(c.name)}</div>${swatchesHTML(c)}`, 200); },
  recolor: (t) => { const h = parseInt(t.dataset.hue, 10); Store.recolor(t.dataset.cid, h); document.querySelectorAll('#popover .swatch').forEach(s => { const on = parseInt(s.dataset.hue, 10) === h; s.classList.toggle('on', on); s.setAttribute('aria-checked', String(on)); }); },
  'merge-menu': (t) => Popover.swap(`merge:${t.dataset.cid}`, mergeMenuHTML(t.dataset.cid)),
  'merge-calc': (t) => mergeCalc(t.dataset.from, t.dataset.to),
  'dup-calc': (t) => duplicateCalc(t.dataset.cid),
  'clear-calc': (t) => clearCalc(t.dataset.cid),
  'delete-calc': (t) => deleteCalc(t.dataset.cid),
  'rename-calc': (t) => renameCalcUI(t.dataset.cid, t.dataset.where),
  'line-move-menu': (t) => Popover.open(`move:${t.dataset.id}`, t, moveMenuHTML(t.dataset.id, Store.state.active), 250),
  'board-item-menu': (t) => Popover.open(`bmove:${t.dataset.from}:${t.dataset.id}`, t, moveMenuHTML(t.dataset.id, t.dataset.from), 250),
  transfer: (t) => transfer(t.dataset.id, t.dataset.from, t.dataset.to, t.dataset.mode),
  'open-board': (t) => openBoard(t && t.dataset.filter),
  'close-board': closeBoard,
  'open-settings': openSettings,
  'set-rounding': (t) => setRounding(t.dataset.engine, t.dataset.mode),
  'toggle-min-one': () => { const n = Store.setMinOne(!Store.state.prefs.minOne); Toast.show(`${Store.state.prefs.minOne ? 'At least 1 pack' : 'Zero packs allowed'}${n ? ` · ${plural(n, 'line')} updated` : ''}`, 'ok', 'calc'); },
  'reset-rounding': () => { let n = 0; Object.keys(App.data.engines).forEach(k => { n += Store.setRounding(k, DEFAULT_ROUND); }); Toast.show(`Rounding reset to nearest${n ? ` · ${plural(n, 'line')} updated` : ''}`, 'ok', 'reset'); },
  'set-quick-qty': (t) => setQuickQty(parseFloat(t.dataset.value)),
  'set-theme': (t) => setTheme(t.dataset.value),
  undo: doUndo,
  'open-tray': openTray,
  'close-tray': closeTray
};
const MENU_OPENERS = new Set(['facet-menu', 'sort-menu', 'web-menu', 'target-menu', 'calc-menu', 'col-menu', 'color-menu', 'line-move-menu', 'board-item-menu']);
const POP_KEEP = new Set(['merge-menu', 'calc-menu-back', 'recolor']);

const clearDrop = () => document.querySelectorAll('.drop-over,.drop-self').forEach(n => n.classList.remove('drop-over', 'drop-self'));
const bindDrag = () => {
  document.addEventListener('dragstart', (e) => {
    const s = e.target.closest && e.target.closest('[data-drag]');
    if (!s) return;
    if (s.dataset.drag === 'line') {
      App.drag = { type: 'line', id: s.dataset.id, from: s.dataset.from };
      const art = s.closest('.line');
      if (art && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(art, 24, 24);
    } else {
      const cid = s.dataset.cid;
      App.drag = { type: 'calc', cid };
      const col = s.closest('.col');
      if (col && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(col, 30, 20);
    }
    e.dataTransfer.effectAllowed = 'copyMove';
    try { e.dataTransfer.setData('text/plain', App.drag.id || App.drag.cid); } catch (err) {}
    document.body.classList.add(`dragging-${App.drag.type}`);
    Popover.close();
  });
  document.addEventListener('dragover', (e) => {
    if (!App.drag) return;
    const z = e.target.closest && e.target.closest('[data-drop-cid]');
    if (!z) { clearDrop(); return; }
    const to = z.dataset.dropCid;
    const d = App.drag;
    const valid = d.type === 'line' ? to !== d.from : (to !== d.cid && to !== '__new');
    if (!valid) { clearDrop(); z.classList.add('drop-self'); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = d.type === 'line' && (e.altKey || e.ctrlKey || e.metaKey) ? 'copy' : 'move';
    if (!z.classList.contains('drop-over')) { clearDrop(); z.classList.add('drop-over'); }
  });
  document.addEventListener('drop', (e) => {
    const d = App.drag;
    const z = e.target.closest && e.target.closest('[data-drop-cid]');
    clearDrop();
    if (!d || !z) return;
    e.preventDefault();
    const to = z.dataset.dropCid;
    if (d.type === 'line' && to !== d.from) transfer(d.id, d.from, to, e.altKey || e.ctrlKey || e.metaKey ? 'copy' : 'move');
    else if (d.type === 'calc' && to !== d.cid && to !== '__new') Store.moveCalc(d.cid, Store.indexOf(to));
  });
  document.addEventListener('dragend', () => { App.drag = null; clearDrop(); document.body.classList.remove('dragging-line', 'dragging-calc'); });
};

const bind = () => {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    const inPop = e.target.closest('#popover');
    if (Popover.owner && !inPop && !(t && MENU_OPENERS.has(t.dataset.action))) Popover.close();
    if (!e.target.closest('.menu-anchor')) { $('engineMenu').classList.remove('open'); $('engineBtn').setAttribute('aria-expanded', 'false'); }
    if (e.target === $('detailModal') || e.target === $('settingsModal')) { closeModal(); return; }
    if (e.target === els.board) { closeBoard(); return; }
    if (!t || t.disabled) return;
    const fn = ACTIONS[t.dataset.action];
    if (fn) fn(t, e);
    if (inPop && !POP_KEEP.has(t.dataset.action)) Popover.close();
  });
  document.addEventListener('dblclick', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) renameCalcUI(tab.dataset.cid, 'tray');
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('quick-in') || t.id === 'dQty' || t.id === 'dSp') {
      if (t.value.length > 7) t.value = t.value.slice(0, 7);
      if (parseFloat(t.value) > MAX_QTY) { t.value = MAX_QTY; Toast.show('Maximum amount is 999,999', 'warn'); }
      if (t.id === 'dQty' || t.id === 'dSp') detailPreview();
      return;
    }
    if (t.classList.contains('line-in')) {
      if (t.value === '') return;
      const r = Store.edit(t.dataset.id, t.dataset.field, t.value);
      if (r.ok) { if (r.clamped) { t.value = MAX_QTY; Toast.show('Maximum amount is 999,999', 'warn'); } patchLine(t.dataset.id, t.dataset.field); }
    }
  });
  document.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('line-in') && t.value === '') { Store.edit(t.dataset.id, t.dataset.field, 0); patchLine(t.dataset.id); }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('col-name')) {
      const v = t.value.trim();
      const c = Store.calc(t.dataset.cid);
      if (!v && c) { t.value = c.name; return; }
      Store.renameCalc(t.dataset.cid, v);
    }
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('quick-in') && e.key === 'Enter') {
      e.preventDefault();
      if (t.dataset.field === 'sp') { const q = $(`qin-${t.dataset.id}`); if (q) { q.focus({ preventScroll: true }); q.select(); } return; }
      quickAdd(t.dataset.id);
      return;
    }
    if ((t.id === 'dQty' || t.id === 'dSp') && e.key === 'Enter') { e.preventDefault(); if (t.id === 'dSp') $('dQty').focus(); else detailAdd(); return; }
    if (t.classList && t.classList.contains('line-in') && e.key === 'Enter') { e.preventDefault(); t.blur(); }
    if (t.classList && t.classList.contains('col-name')) {
      if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const c = Store.calc(t.dataset.cid); if (c) t.value = c.name; t.blur(); }
    }
  });

  els.in.addEventListener('input', () => { App.armed = false; App.armedId = null; search(); });
  els.in.addEventListener('keydown', omniKeydown);
  els.price.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const p = parseFloat(els.price.value);
      if (isNaN(p) || p < 0) { Toast.show('Enter a valid supply price', 'warn'); return; }
      const intent = parseCommand(els.in.value);
      commitIntent(intent, getTarget(intent), { price: p, useDefault: true, keep: e.shiftKey ? els.in.value : null, openTray: e.ctrlKey || e.metaKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      els.price.value = '';
      App.armed = false; App.armedId = null;
      els.in.value = parseCommand(els.in.value).query;
      search();
      els.in.focus({ preventScroll: true });
    }
  });

  els.trayTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); els.trayTitle.blur(); if (!narrow()) els.in.focus({ preventScroll: true }); }
    if (e.key === 'Escape') { e.stopPropagation(); els.trayTitle.value = Store.title(); els.trayTitle.blur(); }
  });
  els.trayTitle.addEventListener('change', () => {
    const v = els.trayTitle.value.trim();
    if (!v) { els.trayTitle.value = Store.title(); return; }
    Store.renameCalc(Store.state.active, v);
  });
  els.boardFilter.addEventListener('input', renderBoard);
  els.boardFilter.addEventListener('keydown', (e) => { if (e.key === 'Escape' && els.boardFilter.value) { e.preventDefault(); e.stopPropagation(); els.boardFilter.value = ''; renderBoard(); } });

  $('fileUpload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const rd = new FileReader();
    rd.onload = (ev) => {
      try {
        const r = Store.importEntries(JSON.parse(ev.target.result));
        if (!r.ok) Toast.show(r.reason === 'full' ? `That would exceed ${MAX_CALCS} calculations` : 'Invalid file format', 'warn');
        else Toast.show(`Imported ${r.calcs > 1 ? plural(r.calcs, 'calculation') + ' · ' : ''}${plural(r.count, 'item')}${r.dropped ? ` · ${r.dropped} not in catalog` : ''}`, 'ok', 'upload');
      } catch (err) { Toast.show('Invalid file format', 'warn'); }
    };
    rd.readAsText(file);
    e.target.value = '';
  });

  els.res.addEventListener('scroll', () => Popover.close(), { passive: true });
  els.lines.addEventListener('scroll', () => Popover.close(), { passive: true });
  els.boardCols.addEventListener('scroll', () => Popover.close(), { passive: true, capture: true });
  els.railTrack.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { els.railTrack.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  window.addEventListener('resize', () => { Popover.close(); if (!narrow()) closeTray(); });
  document.addEventListener('wheel', () => { const a = document.activeElement; if (a && a.tagName === 'INPUT' && a.type === 'number') a.blur(); }, { passive: true });

  document.addEventListener('keydown', globalKeydown);
  bindDrag();

  Store.on((evt) => {
    if (evt.type === 'storage-error') { Toast.show('Could not save — storage full', 'warn'); return; }
    if (evt.type === 'pref') { if (settingsOpen()) renderSettings(); renderModeSeg(); return; }
    if (evt.type === 'edit') { renderTotals(); renderRail(); refreshRows(); if (boardOpen()) renderBoard(); return; }
    renderTray();
    refreshRows();
    if (evt.type === 'rounding' && settingsOpen()) renderSettings();
    if (boardOpen() && !(document.activeElement && document.activeElement.classList.contains('col-name'))) renderBoard();
    if (Palette.isOpen()) Palette.refresh();
  });
};

const omniKeydown = (e) => {
  const st = App.omniState;
  if (e.altKey) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); return; }
  if (e.key === 'PageDown') { e.preventDefault(); moveSel(10); return; }
  if (e.key === 'PageUp') { e.preventDefault(); moveSel(-10); return; }
  if (e.key === 'Home' && App.sel >= 0) { e.preventDefault(); selectFirst(); return; }
  if (e.key === 'End' && App.sel >= 0) { e.preventDefault(); selectLast(); return; }
  if (e.key === 'Tab' && !e.shiftKey && els.in.value.length) {
    const intent = parseCommand(els.in.value);
    const target = getTarget(intent);
    if (st === 'ARMED_NEEDS_PRICE') { e.preventDefault(); els.priceWrap.hidden = false; els.price.focus({ preventScroll: true }); }
    else if (st === 'SEARCHING' && target) { e.preventDefault(); armItem(target.item); }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const intent = parseCommand(els.in.value);
    const target = getTarget(intent);
    if (st === 'SEARCHING' && target) armItem(target.item);
    else if (st === 'ARMED_PENDING_QTY' || st === 'ARMED_WITH_QTY') commitIntent(intent, target, { useDefault: st === 'ARMED_PENDING_QTY', keep: e.shiftKey ? els.in.value : null, openTray: e.ctrlKey || e.metaKey });
    else if (st === 'ARMED_NEEDS_PRICE') { els.priceWrap.hidden = false; els.price.focus({ preventScroll: true }); }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (st === 'IDLE') { els.in.blur(); return; }
    if (st === 'SEARCHING') { els.in.value = ''; App.armed = false; App.armedId = null; search(); return; }
    els.in.value = parseCommand(els.in.value).query;
    App.armed = false; App.armedId = null;
    search();
    els.in.setSelectionRange(els.in.value.length, els.in.value.length);
  }
};

const globalKeydown = (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const a = document.activeElement;
  const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  if (e.altKey && !mod && !e.shiftKey) {
    const dm = /^Digit([1-9])$/.exec(e.code);
    if (dm) { e.preventDefault(); const c = Store.byPosition(parseInt(dm[1], 10)); if (c) { switchCalc(c.id, { silent: true }); if (boardOpen()) renderBoard(); } else Toast.show(`There is no calculation #${dm[1]}`, 'warn'); return; }
    if (e.code === 'KeyN') { e.preventDefault(); newCalc(); return; }
    if (e.code === 'KeyB') { e.preventDefault(); boardOpen() ? closeBoard() : openBoard(); return; }
    if (e.code === 'BracketRight' || e.code === 'PageDown') { e.preventDefault(); Store.switchBy(1); return; }
    if (e.code === 'BracketLeft' || e.code === 'PageUp') { e.preventDefault(); Store.switchBy(-1); return; }
  }
  if (mod && !e.shiftKey && e.code === 'KeyZ') {
    if (typing && a.type === 'text' && a.value) return;
    e.preventDefault(); doUndo(); return;
  }
  if (mod && e.code === 'KeyK') { e.preventDefault(); Palette.toggle(); return; }
  if (mod && e.code === 'KeyS') { e.preventDefault(); Store.persistNow(); Toast.show('Everything saves automatically', 'ok', 'save'); return; }
  if (Palette.isOpen()) return;
  if (e.key === 'Escape') {
    if (Popover.owner) { Popover.close(); return; }
    if ($('engineMenu').classList.contains('open')) { $('engineMenu').classList.remove('open'); return; }
    if (closeModal()) return;
    if (closeBoard()) return;
    if (document.body.classList.contains('tray-open')) { closeTray(); return; }
    return;
  }
  if (e.code === 'Slash' && !typing && !mod && !boardOpen()) { e.preventDefault(); closeTray(); els.in.focus({ preventScroll: true }); els.in.select(); }
};

const reveal = () => {
  const done = () => { document.documentElement.classList.remove('booting'); const p = $('lxPreloader'); if (p) { p.classList.add('hide'); setTimeout(() => p.remove(), 500); } };
  if (document.fonts && document.fonts.load) Promise.race([Promise.all(['400', '500', '600', '700'].map(w => document.fonts.load(`${w} 1rem Outfit`))), new Promise(r => setTimeout(r, 1200))]).then(done, done);
  else setTimeout(done, 200);
};

const bootError = (err) => {
  document.documentElement.classList.remove('booting');
  const p = $('lxPreloader'); if (p) p.remove();
  $('resultsList').innerHTML = `<div class="empty"><span class="empty-art">${icon('warning')}</span><h3>Catalog failed to load</h3><p>data/drugs.json could not be read (${esc(err && err.message ? err.message : 'unknown error')}). Serve the folder over http and reload.</p></div>`;
};

const boot = async () => {
  Object.assign(els, {
    in: $('omniInput'), omnibar: $('omnibar'), lead: $('omniLead'), clear: $('omniClear'), hint: $('omniHint'), target: $('omniTarget'),
    price: $('omniPriceInput'), priceWrap: $('omniPriceWrap'), typeSeg: $('typeSeg'), chips: $('facetChips'),
    res: $('resultsList'), meta: $('resultsMeta'), trayTitle: $('trayTitle'), trayStatus: $('trayStatus'), dot: $('calcDot'),
    rail: $('calcRail'), railTrack: $('railTrack'), lines: $('trayLines'), trayTotal: $('trayTotal'), traySub: $('traySub'), grand: $('grandRow'),
    trayBar: $('trayBar'), trayBarCount: $('trayBarCount'), trayBarTotal: $('trayBarTotal'), trayBarLabel: $('trayBarLabel'), trayBarCalcs: $('trayBarCalcs'),
    dockCount: $('dockCalcCount'), board: $('board'), boardPanel: $('boardPanel'), boardCols: $('boardCols'), boardSub: $('boardSub'), boardHint: $('boardHint'), boardFilter: $('boardFilter')
  });
  $('cmdkHint').textContent = `${isMac ? '⌘' : 'Ctrl '}K`;
  applyTheme();
  try {
    const res = await fetch('data/drugs.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    App.data = await res.json();
  } catch (err) { bootError(err); return; }
  App.db = buildCatalog(App.data);
  const boot = Store.init(App.db);
  bind();
  Palette.init();
  renderEngineMenu();
  renderModeSeg();
  search();
  renderTray();
  reveal();
  if (boot && boot.migrated && Store.state.calcs.length > 1) setTimeout(() => Toast.show(`Welcome to ${VERSION} — your orders are now ${Store.state.calcs.length} calculations`, 'ok', 'sparkle'), 900);
  if (!coarse()) els.in.focus({ preventScroll: true });
  if ((new URLSearchParams(location.search).get('selftest') === '1' || document.documentElement.dataset.selftest === '1') && window.runSelfTest) window.runSelfTest();
};

(function bridge() {
  if (window.parent === window) return;
  const ready = () => {
    window.parent.postMessage({ t: 'lx:ready', title: document.title }, '*');
    let last = document.title;
    const tEl = document.querySelector('title');
    if (tEl) new MutationObserver(() => { if (document.title !== last) { last = document.title; window.parent.postMessage({ t: 'lx:title', title: last }, '*'); } }).observe(tEl, { childList: true });
  };
  if (document.readyState === 'complete') ready(); else window.addEventListener('load', ready);
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.t !== 'lx:theme' || !['light', 'dark', 'system'].includes(d.mode)) return;
    setTheme(d.mode, true);
  });
})();

boot();
