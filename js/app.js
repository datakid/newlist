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
  detail: null
};
const els = {};
const rowCache = new Map();
const coarse = () => window.matchMedia('(hover: none), (pointer: coarse)').matches;
const narrow = () => window.matchMedia('(max-width: 880px)').matches;

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
const computeState = (intent, target) => {
  if (!intent.query) return 'IDLE';
  if (target && (intent.qty != null || App.armed)) {
    if (target.item.isDynamic && intent.price == null) return 'ARMED_NEEDS_PRICE';
    return intent.qty != null ? 'ARMED_WITH_QTY' : 'ARMED_PENDING_QTY';
  }
  return 'SEARCHING';
};

const preview = (intent, target) => {
  if (!intent.query) return { text: 'Type a medicine · x30 sets quantity · x2p packs · @450 supply price', ok: false, idle: true };
  if (intent.qtyInvalid) return { text: 'Quantity must be greater than 0', ok: false };
  if (!target) return { text: `No match for "${intent.query}"`, ok: false };
  const item = target.item;
  if (item.isDynamic && intent.price == null && (intent.qty != null || App.armed)) return { text: `${item.n} needs a supply price — type @450 or press Tab`, ok: false };
  if (intent.qty == null && !App.armed) return { text: `${item.n} · ${item.u} · ${priceLabel(item)}`, ok: true, key: '⏎', tail: 'to pick · Tab completes' };
  const qty = intent.qty != null ? intent.qty : quickQty();
  const req = reqFrom(qty, intent.unit || 'default', item);
  const { packs, spare } = packInfo(req, item.bQty);
  const costP = costOf(item, packs, intent.price || 0);
  const spareStr = spare > 0 ? ` · ${fmtNum(spare)} ${item.bType} spare` : '';
  return { text: `Add ${item.n} — ${fmtNum(req)} ${item.bType} → ${plural(packs, 'pack')}${spareStr} · ${money(costP)} EGP`, ok: true, key: '⏎', add: true };
};

const updateHint = () => {
  const intent = parseCommand(els.in.value);
  const target = getTarget(intent);
  App.omniState = computeState(intent, target);
  const pv = preview(intent, target);
  const st = App.omniState;
  els.hint.className = `hint${pv.ok ? ' ok' : ''}${!pv.ok && st !== 'IDLE' ? ' err' : ''}`;
  if (pv.idle) els.hint.innerHTML = `<kbd>/</kbd> focus · <kbd>${esc(MOD)} K</kbd> commands · <b style="font-weight:500;color:var(--fg-2)">concor 5 x30</b> adds 30 tablets`;
  else if (pv.add) els.hint.innerHTML = `<kbd>⏎</kbd> <b>${esc(pv.text)}</b>`;
  else if (pv.key) els.hint.innerHTML = `<kbd>${pv.key}</kbd> ${esc(pv.text)} <span style="color:var(--fg-3)">${esc(pv.tail || '')}</span>`;
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

const rowSig = (item) => {
  const l = Store.state.lines.get(item.id);
  return `${App.tokens.join(' ')}|${addMode()}|${quickQty()}|${l ? l.packs : ''}`;
};
const rowHTML = (item) => {
  const l = Store.state.lines.get(item.id);
  const pm = addMode() === 'pack';
  const id = esc(item.id);
  const sub = item.isDynamic ? esc(item.s) : esc(unitPriceLabel(item));
  return `${itemIcon(item)}
<div class="row-main">
<div class="row-title"><span class="nm" dir="auto">${highlight(item.n, App.tokens)}</span>${tierTag(item)}${l ? `<span class="tag ok">${icon('check', 'sm')}&nbsp;${plural(l.packs, 'pack')}</span>` : ''}</div>
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
<button class="add-btn" data-action="quick-add" data-id="${id}" aria-label="Add ${esc(item.n)}">${icon('plus')}</button>
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
  el.classList.toggle('in-tray', !!l);
  el.setAttribute('aria-label', `${item.n}${item.tLabel ? ', ' + item.tLabel : ''}, ${item.u}, ${priceLabel(item)}${l ? ', in calculation' : ''}`);
  el._sig = sig;
};

const idleHTML = () => {
  const recent = Store.state.recent.map(id => Store.get(id)).filter(Boolean).slice(0, 6);
  const counts = facetCounts(App.db, '', App.view.facets, 'type');
  const desc = { pack: 'Priced per package. Quantities round up to whole packs.', insulin: 'Dose in IU. Converted to pens and cartridges.', supply: 'Cost is a share of the supply price you enter.' };
  return `<div class="idle" data-idle>
${recent.length ? `<section class="idle-sec"><div class="idle-label">${icon('clock')}Recent<button class="link" data-action="clear-recent">Clear</button></div><div class="pills">${recent.map(i => `<button class="pill" data-action="arm" data-id="${esc(i.id)}">${icon(KIND_ICON[i.kind] || 'box')}<span dir="auto">${esc(i.n)}</span>${tierTag(i)}</button>`).join('')}</div></section>` : ''}
<section class="idle-sec"><div class="idle-label">${icon('bolt')}Try a command</div><div class="pills">${(App.data.examples || []).map(x => `<button class="pill" data-action="try" data-value="${esc(x)}"><code>${esc(x)}</code></button>`).join('')}</div></section>
<section class="idle-sec"><div class="idle-label">${icon('calc')}Browse by calculation</div><div class="engine-grid">${Object.entries(App.data.engines).map(([id, e]) => `<button class="engine-card" data-action="set-facet" data-facet="type" data-value="${esc(id)}"><span class="row-icon" data-engine="${esc(id)}">${icon(ENGINE_ICON[id] || 'box')}</span><b>${esc(e.label)}</b><span>${esc(desc[id] || '')}</span><span class="n">${(counts.get(id) || { count: 0 }).count} items</span></button>`).join('')}</div></section>
<section class="idle-sec"><div class="idle-label">${icon('command')}Keyboard</div><div class="keys"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> move</span><span><kbd class="kbd">Tab</kbd> complete</span><span><kbd class="kbd">⏎</kbd> add</span><span><kbd class="kbd">⇧⏎</kbd> add &amp; repeat</span><span><kbd class="kbd">${esc(MOD)}⏎</kbd> add &amp; open tray</span><span><kbd class="kbd">${esc(MOD)}Z</kbd> undo</span><span><kbd class="kbd">${esc(MOD)}S</kbd> save order</span></div></section>
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
  els.in.value = item.n;
  App.armed = true;
  App.armedId = item.id;
  search();
  els.in.focus({ preventScroll: true });
  els.in.setSelectionRange(els.in.value.length, els.in.value.length);
};
const armById = (id) => {
  const item = Store.get(id);
  if (!item) return;
  if (coarse()) { openDetails(id); return; }
  armItem(item);
};

const addFeedback = (r, item, opts = {}) => {
  const spare = r.spare > 0 ? ` · ${fmtNum(r.spare)} ${item.bType} spare` : '';
  Toast.show(`Added ${plural(r.packs, 'pack')} of ${item.n}${spare}`, 'ok', 'check');
  requestAnimationFrame(() => {
    const line = $(`line-${item.id}`);
    if (line) { line.classList.remove('flash'); void line.offsetWidth; line.classList.add('flash'); if (!narrow()) line.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    els.trayBar.classList.remove('bump'); void els.trayBar.offsetWidth; els.trayBar.classList.add('bump');
  });
  if (opts.openTray) openTray();
};
const failFeedback = (r, focusEl) => {
  if (r.reason === 'needs-price') { Toast.show('Enter a supply price first', 'warn'); if (focusEl) focusEl.focus({ preventScroll: true }); }
  else if (r.reason === 'invalid-qty') Toast.show('Enter a quantity above 0', 'warn');
};

const commitIntent = (intent, target, opts = {}) => {
  if (!target) return false;
  const item = target.item;
  const qty = intent.qty != null ? intent.qty : (opts.useDefault ? quickQty() : null);
  if (qty == null || qty <= 0) return false;
  const req = Math.min(MAX_QTY, reqFrom(qty, intent.unit || 'default', item));
  const sp = opts.price != null ? opts.price : (intent.price != null ? intent.price : NaN);
  const r = Store.add(item.id, req, item.isDynamic ? sp : 0, true);
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

const lineHTML = (l) => {
  const it = l.item, id = esc(it.id);
  const spare = Store.lineSpare(l);
  const short = Math.max(0, l.req - l.packs * it.bQty);
  const stepper = (field, val, label, extra = '') => `<div class="field${field === 'sp' ? ' sp' : ''}"><label for="ln-${field}-${id}">${label}${extra}</label><div class="stepper${field === 'sp' ? ' sp' : ''}"><button class="step" data-action="step" data-id="${id}" data-field="${field}" data-d="-1" aria-label="Decrease">${icon('minus')}</button><input type="number" inputmode="decimal" class="line-in" id="ln-${field}-${id}" data-id="${id}" data-field="${field}" value="${esc(String(fmtNum(val)))}" min="0" max="${MAX_QTY}"><button class="step" data-action="step" data-id="${id}" data-field="${field}" data-d="1" aria-label="Increase">${icon('plus')}</button></div></div>`;
  return `<article class="line" id="line-${id}">
<div class="line-top">${itemIcon(it)}
<div class="line-info"><div class="line-name"><span class="nm" dir="auto">${esc(it.n)}</span>${tierTag(it)}</div><div class="line-meta">${esc(String(it.bQty))} ${esc(it.bType)} / pack · ${esc(it.isDynamic ? priceLabel(it) : it.p.toFixed(2) + ' EGP / pack')}</div></div>
<div class="line-cost" id="lc-${id}">${money(Store.lineCostP(l))} <small>EGP</small></div>
<button class="icon-btn danger" data-action="remove-line" data-id="${id}" aria-label="Remove ${esc(it.n)}">${icon('trash')}</button>
</div>
<div class="line-ctrls">
${stepper('req', l.req, `Need · ${esc(it.bType)}`, ` <span class="spare" id="lsp-${id}">${spare > 0 ? `· ${fmtNum(spare)} spare` : short > 0 ? `· ${fmtNum(short)} short` : ''}</span>`)}
${stepper('pack', l.packs, 'Packs')}
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
  const spare = Store.lineSpare(l), short = Math.max(0, l.req - l.packs * it.bQty);
  const s = $(`lsp-${id}`); if (s) s.textContent = spare > 0 ? `· ${fmtNum(spare)} spare` : short > 0 ? `· ${fmtNum(short)} short` : '';
};

const renderTotals = () => {
  const st = Store.state;
  const n = st.lines.size;
  const tot = money(Store.totalP());
  let packs = 0; st.lines.forEach(l => packs += l.packs);
  els.trayTotal.innerHTML = `${tot} <small>EGP</small>`;
  els.traySub.textContent = n ? `${plural(n, 'item')} · ${plural(packs, 'pack')}` : 'No items yet';
  els.trayBarCount.textContent = n;
  els.trayBarTotal.textContent = `${tot} EGP`;
  els.trayBar.classList.toggle('empty', !n && !st.orders.length);
  els.saveBtn.disabled = !n;
  document.querySelectorAll('[data-action="clear-tray"],[data-action="copy-tray"],[data-action="download-json"],[data-action="download-csv"]').forEach(b => b.disabled = !n);
};

const renderTray = () => {
  const st = Store.state;
  if (document.activeElement !== els.trayTitle) els.trayTitle.value = Store.title();
  const saved = st.current >= 0;
  els.trayStatus.textContent = saved ? 'Saved order' : 'Unsaved';
  els.trayStatus.classList.toggle('saved', saved);
  els.saveBtn.innerHTML = `${icon('save')}<span>${saved ? 'Update order' : 'Save order'}</span>`;
  const showOrders = st.orders.length || st.lines.size;
  els.orders.hidden = !showOrders;
  els.orders.innerHTML = st.orders.map((o, i) => `<span class="order${i === st.current ? ' on' : ''}"><button class="order-main" data-action="load-order" data-idx="${i}" title="${esc(o.name)} · ${money(Store.totalP(o.lines))} EGP">${esc(o.name)}</button><button class="order-x" data-action="delete-order" data-idx="${i}" aria-label="Delete order ${esc(o.name)}">${icon('x')}</button></span>`).join('') +
    `<button class="order new" data-action="new-order">${icon('plus')}New</button>`;
  const lines = Array.from(st.lines.values()).reverse();
  els.lines.innerHTML = lines.length ? lines.map(lineHTML).join('') :
    `<div class="tray-empty"><span class="empty-art">${icon('tray')}</span><div><b style="color:var(--fg)">Your calculation is empty</b><br>Search on the left and press ⏎,<br>or type <b style="color:var(--primary)">concor 5 x30</b>.</div></div>`;
  renderTotals();
};

const openTray = () => { if (!narrow()) return; document.body.classList.add('tray-open'); FocusTrap.set($('tray')); setTimeout(() => { const f = $('tray').querySelector('.tray-close'); if (f) f.focus({ preventScroll: true }); }, 60); };
const closeTray = () => { if (!document.body.classList.contains('tray-open')) return; document.body.classList.remove('tray-open'); FocusTrap.release(); };

const exportText = () => {
  const st = Store.state;
  if (!st.lines.size) return;
  let t = `${Store.title()}:\n\n`;
  st.lines.forEach(l => {
    const dp = l.item.isDynamic ? ` [Supply Price: ${l.sp}]` : '';
    t += `- ${l.item.n}${l.item.t ? ' ' + l.item.t : ''}: Req ${fmtNum(l.req)} ${l.item.bType} -> ${l.packs} Packs${dp} = ${money(Store.lineCostP(l))} EGP\n`;
  });
  t += `\nTotal: ${money(Store.totalP())} EGP`;
  copyText(t).then(ok => Toast.show(ok ? 'Summary copied' : 'Copy failed — select text manually', ok ? 'ok' : 'warn', ok ? 'copy' : 'warning'));
};
const downloadJSON = () => {
  if (!Store.state.lines.size) return;
  download(new Blob([JSON.stringify({ app: 'LX Search', version: 5, title: Store.title(), total: `${money(Store.totalP())} EGP`, items: Store.serializeLines() }, null, 2)], { type: 'application/json' }), `LX_Calc_${Date.now()}.json`);
  Toast.show('JSON download started', 'ok', 'download');
};
const csvEsc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const downloadCSV = () => {
  const lines = Array.from(Store.state.lines.values());
  if (!lines.length) return;
  const head = ['Name', 'Tag', 'Source', 'Type', 'Unit', 'Requested', 'Base Unit', 'Packs', 'Price per Pack (EGP)', 'Supply Price (EGP)', 'Cost (EGP)'];
  const rows = lines.map(l => [l.item.n, l.item.t, l.item.s, l.item.engineLabel, l.item.u, fmtNum(l.req), l.item.bType, l.packs, l.item.isDynamic ? '' : l.item.p.toFixed(2), l.item.isDynamic ? Number(l.sp).toFixed(2) : '', money(Store.lineCostP(l))]);
  rows.push(['Total', '', '', '', '', '', '', '', '', '', money(Store.totalP())]);
  const csv = [head, ...rows].map(r => r.map(csvEsc).join(',')).join('\r\n');
  download(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }), `LX_Calc_${Date.now()}.csv`);
  Toast.show('CSV download started', 'ok', 'table');
};

const saveOrder = () => {
  const r = Store.saveOrder();
  if (r.ok) Toast.show(r.updated ? 'Order updated' : 'Order saved', 'ok', 'bookmark');
  else if (r.reason === 'orders-full') Toast.show(`Maximum ${MAX_ORDERS} saved orders — delete one first`, 'warn');
};
const newOrder = () => {
  const r = Store.newOrder();
  if (!r.ok) Toast.show(`Maximum ${MAX_ORDERS} saved orders — delete one first`, 'warn');
  else if (r.autosaved) Toast.show('Unsaved work kept as a saved order', 'ok', 'save');
};
const loadOrder = (idx) => {
  const r = Store.loadOrder(idx);
  if (!r.ok) { if (r.reason === 'orders-full') Toast.show(`Maximum ${MAX_ORDERS} saved orders — delete one first`, 'warn'); return false; }
  if (!r.same) Toast.show(r.autosaved ? `Loaded ${r.name} · unsaved work kept` : `Loaded ${r.name}`, 'ok', 'bookmark');
  return true;
};
const deleteOrder = (idx) => { const name = Store.deleteOrder(idx); if (name) Toast.undo(`Deleted “${name}”`); };
const removeLine = (id) => { const l = Store.state.lines.get(id); if (l && Store.remove(id)) Toast.undo(`Removed ${l.item.n}`); };
const clearTray = () => { const n = Store.state.lines.size; if (Store.clear() && n) Toast.undo('Calculator cleared'); };
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
  const { packs, spare } = packInfo(req, item.bQty);
  out.innerHTML = `<b>${fmtNum(req)} ${esc(item.bType)} → ${plural(packs, 'pack')} · ${money(costOf(item, packs, sp))} EGP</b>${spare > 0 ? ` · ${fmtNum(spare)} spare` : ''}`;
};
const openDetails = (id) => {
  const item = Store.get(id);
  if (!item) return;
  Popover.close();
  App.lastFocus = document.activeElement;
  App.detail = { id, mode: addMode() };
  const l = Store.state.lines.get(id);
  const sheet = $('detailSheet');
  sheet.innerHTML = `<div class="sheet-head">${itemIcon(item)}<div style="min-width:0"><h2 class="sheet-title" id="detailTitle" dir="auto">${esc(item.n)}</h2><div class="sheet-tags">${tierTag(item)}<span class="tag src">${esc(item.u)}</span><span class="tag src">${esc(item.s)}</span><span class="tag">${esc(item.engineLabel)}</span>${l ? `<span class="tag ok">In tray · ${plural(l.packs, 'pack')}</span>` : ''}</div></div><button class="icon-btn" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
<div class="price-grid">${item.isDynamic ? `<div class="price-cell wide"><span>Price</span><b class="price supply">${Math.round(item.ratio * 100)}% of supply price</b></div>` : `<div class="price-cell"><span>1 pack · ${esc(String(item.bQty))} ${esc(item.bType)}</span><b class="price ${esc(item.engineId)}">${item.p.toFixed(2)} EGP</b></div><div class="price-cell"><span>1 ${esc(item.bType)}</span><b class="price ${esc(item.engineId)}">${money(Math.round(item.pP / item.bQty))} EGP</b></div>`}</div>
<div class="sheet-sec-label">Add to calculation</div>
<div class="sheet-add">
<div class="quick">${item.isDynamic ? `<input type="number" inputmode="decimal" class="sp" id="dSp" placeholder="Supply price" min="0" aria-label="Supply price"><span class="sep"></span>` : ''}<input type="number" inputmode="decimal" id="dQty" placeholder="${esc(String(quickQty()))}" min="0" max="${MAX_QTY}" aria-label="Quantity"><button class="add-btn" data-action="detail-add" aria-label="Add">${icon('plus')}</button></div>
<div class="seg" role="radiogroup" aria-label="Quantity unit"><button class="seg-btn" data-action="detail-mode" data-id="unit" id="dmUnit" role="radio">${esc(item.bType)}</button><button class="seg-btn" data-action="detail-mode" data-id="pack" id="dmPack" role="radio">Packs</button></div>
</div>
<div class="sheet-preview" id="dPreview"></div>
<div class="sheet-sec-label">Look it up</div>
<div class="links">${webLinks(item).map(x => `<a class="link-btn" href="${esc(x.href)}" target="_blank" rel="noopener noreferrer">${icon(x.icon)}${esc(x.label)}</a>`).join('')}<button class="link-btn" data-action="copy-item" data-id="${esc(id)}">${icon('copy')}Copy info</button></div>`;
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
  const r = Store.add(item.id, req, sp, true);
  if (!r.ok) { failFeedback(r, spIn); return; }
  closeModal();
  addFeedback(r, item);
};
const closeModal = () => {
  const m = $('detailModal');
  if (!m.classList.contains('open')) return false;
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
  FocusTrap.release();
  App.detail = null;
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
  'open-cmdk': () => Palette.open(),
  'clear-input': () => { els.in.value = ''; App.armed = false; App.armedId = null; search(); els.in.focus(); },
  'set-facet': (t) => setFacet(t.dataset.facet, t.dataset.value),
  'pick-facet': (t) => { setFacet(t.dataset.facet, t.dataset.value); },
  'clear-facet': (t) => setFacet(t.dataset.id, 'all'),
  'clear-facets': clearFacets,
  'facet-menu': (t) => facetMenu(t.dataset.id, t),
  'sort-menu': (t) => sortMenu(t),
  'pick-sort': (t) => { App.view.sort = t.dataset.value; Popover.close(); search(); },
  'set-add-mode': (t) => setAddMode(t.dataset.id),
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
  'remove-line': (t) => removeLine(t.dataset.id),
  step: (t) => stepLine(t.dataset.id, t.dataset.field, parseInt(t.dataset.d, 10)),
  'clear-tray': clearTray,
  'copy-tray': exportText,
  'download-json': downloadJSON,
  'download-csv': downloadCSV,
  'save-order': saveOrder,
  'new-order': newOrder,
  'load-order': (t) => loadOrder(parseInt(t.dataset.idx, 10)),
  'delete-order': (t) => deleteOrder(parseInt(t.dataset.idx, 10)),
  undo: doUndo,
  'open-tray': openTray,
  'close-tray': closeTray
};

const bind = () => {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (Popover.owner && !e.target.closest('#popover') && !(t && ['facet-menu', 'sort-menu', 'web-menu'].includes(t.dataset.action))) Popover.close();
    if (!e.target.closest('.menu-anchor')) { $('engineMenu').classList.remove('open'); $('engineBtn').setAttribute('aria-expanded', 'false'); }
    if (e.target === $('detailModal')) { closeModal(); return; }
    if (!t) return;
    const fn = ACTIONS[t.dataset.action];
    if (fn) fn(t, e);
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

  els.trayTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); els.trayTitle.blur(); } if (e.key === 'Escape') { els.trayTitle.value = Store.title(); els.trayTitle.blur(); } });
  els.trayTitle.addEventListener('change', () => {
    const v = els.trayTitle.value.trim();
    if (!v) { els.trayTitle.value = Store.title(); return; }
    if (Store.renameOrder(Store.state.current, v) && Store.state.current >= 0) Toast.show('Order renamed', 'ok', 'edit');
  });

  $('fileUpload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const rd = new FileReader();
    rd.onload = (ev) => {
      try {
        const r = Store.importEntries(JSON.parse(ev.target.result));
        if (!r.ok) Toast.show('Invalid file format', 'warn');
        else Toast.show(r.dropped ? `Loaded ${plural(r.count, 'item')} · ${r.dropped} not in catalog` : `Loaded ${plural(r.count, 'item')} from file`, 'ok', 'upload');
      } catch (err) { Toast.show('Invalid file format', 'warn'); }
    };
    rd.readAsText(file);
    e.target.value = '';
  });

  els.res.addEventListener('scroll', () => Popover.close(), { passive: true });
  window.addEventListener('resize', () => { Popover.close(); if (!narrow()) closeTray(); });
  document.addEventListener('wheel', () => { const a = document.activeElement; if (a && a.tagName === 'INPUT' && a.type === 'number') a.blur(); }, { passive: true });

  document.addEventListener('keydown', globalKeydown);

  Store.on((evt) => {
    if (evt.type === 'storage-error') { Toast.show('Could not save — storage full', 'warn'); return; }
    if (evt.type === 'pref') return;
    if (evt.type === 'edit') { renderTotals(); refreshRows(); return; }
    if (evt.type === 'rename') { renderTray(); return; }
    renderTray();
    refreshRows();
    if (Palette.isOpen()) Palette.refresh();
  });
};

const omniKeydown = (e) => {
  const st = App.omniState;
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
  if (mod && !e.shiftKey && e.code === 'KeyZ') {
    if (typing && a.type === 'text' && a.value) return;
    e.preventDefault(); doUndo(); return;
  }
  if (mod && e.code === 'KeyK') { e.preventDefault(); Palette.toggle(); return; }
  if (mod && e.code === 'KeyS') { e.preventDefault(); saveOrder(); return; }
  if (Palette.isOpen()) return;
  if (e.key === 'Escape') {
    if (Popover.owner) { Popover.close(); return; }
    if ($('engineMenu').classList.contains('open')) { $('engineMenu').classList.remove('open'); return; }
    if (closeModal()) return;
    if (document.body.classList.contains('tray-open')) { closeTray(); return; }
    return;
  }
  if (e.code === 'Slash' && !typing && !mod) { e.preventDefault(); closeTray(); els.in.focus({ preventScroll: true }); els.in.select(); }
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
    in: $('omniInput'), omnibar: $('omnibar'), lead: $('omniLead'), clear: $('omniClear'), hint: $('omniHint'),
    price: $('omniPriceInput'), priceWrap: $('omniPriceWrap'), typeSeg: $('typeSeg'), chips: $('facetChips'),
    res: $('resultsList'), meta: $('resultsMeta'), trayTitle: $('trayTitle'), trayStatus: $('trayStatus'),
    orders: $('ordersBar'), lines: $('trayLines'), trayTotal: $('trayTotal'), traySub: $('traySub'),
    saveBtn: $('saveOrderBtn'), trayBar: $('trayBar'), trayBarCount: $('trayBarCount'), trayBarTotal: $('trayBarTotal')
  });
  $('cmdkHint').textContent = `${isMac ? '⌘' : 'Ctrl '}K`;
  applyTheme();
  try {
    const res = await fetch('data/drugs.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    App.data = await res.json();
  } catch (err) { bootError(err); return; }
  App.db = buildCatalog(App.data);
  Store.init(App.db);
  bind();
  Palette.init();
  renderEngineMenu();
  renderModeSeg();
  search();
  renderTray();
  reveal();
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
