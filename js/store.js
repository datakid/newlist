const SCHEMA_VERSION = 4;
const MAX_CALCS = 30;
const MAX_UNDO = 40;
const HUES = 10;
const KEYS = {
  ver: 'lx_schema_version', ws: 'lx_workspace', calc: 'lx_current_calc', orders: 'lx_calc_orders', cur: 'lx_current_order', draft: 'lx_draft_name',
  engine: 'lx_engine', mode: 'lx_add_mode', qty: 'lx_default_qty', recent: 'lx_recent', rounding: 'lx_rounding', minOne: 'lx_min_one'
};

const Store = (() => {
  let db = [];
  let byId = new Map();
  const state = { calcs: [], active: null, seq: 0, prefs: { web: 'brave', addMode: 'unit', quickQty: 1, rounding: {}, minOne: true }, recent: [] };
  const listeners = new Set();
  let undoStack = [];
  let saveTimer = null;
  let lastUndo = { key: null, at: 0 };

  const emit = (evt) => listeners.forEach(fn => fn(evt || {}));
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const get = (id) => byId.get(id);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const cloneLines = (m) => new Map(Array.from(m.entries()).map(([k, v]) => [k, { ...v }]));

  const roundingFor = (item) => state.prefs.rounding[item.engineId] || item.rounding || DEFAULT_ROUND;
  const packsFor = (item, req) => packInfo(req, item.bQty, roundingFor(item), state.prefs.minOne);

  const calc = (id) => state.calcs.find(c => c.id === id) || null;
  const activeCalc = () => calc(state.active) || state.calcs[0];
  const indexOf = (id) => state.calcs.findIndex(c => c.id === id);
  const byPosition = (n) => state.calcs[n - 1] || null;
  const freeHue = () => {
    const used = new Set(state.calcs.map(c => c.hue));
    for (let h = 0; h < HUES; h++) if (!used.has(h)) return h;
    return state.seq % HUES;
  };
  const makeCalc = (name, lines) => {
    state.seq++;
    const now = Date.now();
    return { id: uid(), name: String(name || `Calc ${state.seq}`).trim().slice(0, 60) || `Calc ${state.seq}`, hue: freeHue(), lines: lines || new Map(), created: now, updated: now };
  };
  const touch = (...cs) => { const now = Date.now(); cs.forEach(c => { if (c) c.updated = now; }); };
  const ensureOne = () => {
    if (!state.calcs.length) state.calcs.push(makeCalc());
    if (!calc(state.active)) state.active = state.calcs[0].id;
  };

  const findLegacy = (it) => {
    if (!it) return null;
    if (it.id && byId.has(it.id)) return byId.get(it.id);
    return db.find(d => d.n === it.n && d.u === it.u && d.s === it.s && (d.t || '') === (it.t || '')) || null;
  };

  const hydrateEntries = (entries, legacy = true) => {
    if (!Array.isArray(entries)) return [];
    const out = [];
    entries.forEach(e => {
      if (!Array.isArray(e) || e.length !== 2 || !e[1]) return;
      const v = e[1];
      const item = (e[0] && byId.get(e[0])) || findLegacy(v.item);
      if (!item) return;
      const req = Math.min(MAX_QTY, Math.max(0, Number(v.req) || 0));
      const sp = item.isDynamic ? Math.max(0, Number(v.supplyPrice != null ? v.supplyPrice : v.sp) || 0) : 0;
      const auto = packsFor(item, req).packs;
      const hasPacks = v.packs != null && !isNaN(Number(v.packs));
      let packs = hasPacks ? Math.max(0, Math.round(Number(v.packs))) : auto;
      const legacyAuto = Math.ceil(req / (item.bQty || 1));
      let manual = hasPacks && (legacy ? packs !== legacyAuto : !!v.manual);
      if (!manual) packs = auto;
      out.push([item.id, { item, req, packs, sp, manual }]);
    });
    return out;
  };

  const lineCostP = (l) => costOf(l.item, l.packs, l.sp);
  const lineSpare = (l) => Math.max(0, +(l.packs * l.item.bQty - l.req).toFixed(4));
  const lineShort = (l) => Math.max(0, +(l.req - l.packs * l.item.bQty).toFixed(4));
  const linesOf = (x) => x instanceof Map ? x : (x && x.lines) || activeCalc().lines;
  const totalP = (x) => { let t = 0; linesOf(x).forEach(l => t += lineCostP(l)); return t; };
  const packsTotal = (x) => { let t = 0; linesOf(x).forEach(l => t += l.packs); return t; };
  const grandTotalP = () => state.calcs.reduce((a, c) => a + totalP(c.lines), 0);

  const serializeLines = (x) => Array.from(linesOf(x).entries()).map(([id, l]) => [id, {
    req: l.req, packs: l.packs, supplyPrice: l.sp, manual: !!l.manual, cost: lineCostP(l) / 100,
    item: { id: l.item.id, n: l.item.n, t: l.item.t, u: l.item.u, s: l.item.s, bQty: l.item.bQty, bType: l.item.bType, engine: l.item.engineId }
  }]);
  const serializeCalc = (c) => ({ id: c.id, name: c.name, hue: c.hue, created: c.created, updated: c.updated, total: `${money(totalP(c.lines))} EGP`, items: serializeLines(c.lines) });
  const serializeWorkspace = () => ({ v: SCHEMA_VERSION, active: state.active, seq: state.seq, calcs: state.calcs.map(serializeCalc) });

  const persistNow = () => {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(KEYS.ver, String(SCHEMA_VERSION));
      localStorage.setItem(KEYS.ws, JSON.stringify(serializeWorkspace()));
      localStorage.setItem(KEYS.recent, JSON.stringify(state.recent));
    } catch (e) { emit({ type: 'storage-error' }); }
  };
  const persist = (now) => { clearTimeout(saveTimer); if (now) persistNow(); else saveTimer = setTimeout(persistNow, 250); };

  const readJSON = (k, fallback) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; } catch (e) { return fallback; } };

  const loadPrefs = () => {
    state.prefs.web = localStorage.getItem(KEYS.engine) || 'brave';
    state.prefs.addMode = localStorage.getItem(KEYS.mode) === 'pack' ? 'pack' : 'unit';
    state.prefs.quickQty = parseFloat(localStorage.getItem(KEYS.qty)) || 1;
    const r = readJSON(KEYS.rounding, {});
    state.prefs.rounding = {};
    if (r && typeof r === 'object') Object.entries(r).forEach(([k, v]) => { if (ROUND_MODES[v]) state.prefs.rounding[k] = v; });
    state.prefs.minOne = localStorage.getItem(KEYS.minOne) !== '0';
  };

  const migrateLegacy = () => {
    const lines = new Map(hydrateEntries(readJSON(KEYS.calc, []), true));
    const rawOrders = readJSON(KEYS.orders, []);
    const orders = Array.isArray(rawOrders) ? rawOrders.filter(o => o && typeof o === 'object') : [];
    const cur = parseInt(localStorage.getItem(KEYS.cur), 10);
    state.calcs = [];
    state.seq = 0;
    orders.forEach((o, i) => state.calcs.push(makeCalc(String(o.name || `Calc ${i + 1}`), new Map(hydrateEntries(o.items || [], true)))));
    if (Number.isInteger(cur) && cur >= 0 && cur < state.calcs.length) { state.calcs[cur].lines = lines; state.active = state.calcs[cur].id; }
    else if (lines.size) { const c = makeCalc(localStorage.getItem(KEYS.draft) || 'Unsaved calculation', lines); state.calcs.push(c); state.active = c.id; }
    return state.calcs.length > 0;
  };

  const load = () => {
    try { loadPrefs(); } catch (e) {}
    let migrated = false;
    try {
      const ws = readJSON(KEYS.ws, null);
      if (ws && Array.isArray(ws.calcs)) {
        state.seq = Number(ws.seq) || ws.calcs.length;
        state.calcs = ws.calcs.filter(c => c && typeof c === 'object').map((c, i) => ({
          id: String(c.id || uid()), name: String(c.name || `Calc ${i + 1}`).slice(0, 60),
          hue: Number.isInteger(c.hue) ? ((c.hue % HUES) + HUES) % HUES : i % HUES,
          created: Number(c.created) || Date.now(), updated: Number(c.updated) || Date.now(),
          lines: new Map(hydrateEntries(c.items || [], false))
        }));
        state.active = ws.active;
      } else migrated = migrateLegacy();
      const rec = readJSON(KEYS.recent, []);
      state.recent = Array.isArray(rec) ? rec.filter(id => byId.has(id)).slice(0, 8) : [];
    } catch (e) {}
    ensureOne();
    if (migrated || parseInt(localStorage.getItem(KEYS.ver) || '1', 10) < SCHEMA_VERSION) persist(true);
    return { migrated };
  };

  const snapshot = () => ({ calcs: state.calcs.map(c => ({ ...c, lines: cloneLines(c.lines) })), active: state.active, seq: state.seq });
  const restore = (s) => { state.calcs = s.calcs; state.active = s.active; state.seq = s.seq; ensureOne(); };
  const pushUndo = (label, key) => {
    const now = Date.now();
    if (key && lastUndo.key === key && now - lastUndo.at < 1500) { lastUndo.at = now; return; }
    lastUndo = { key: key || null, at: now };
    undoStack.push({ label, snap: snapshot() });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  };
  const undo = () => {
    const e = undoStack.pop();
    lastUndo = { key: null, at: 0 };
    if (!e) return null;
    restore(e.snap);
    persist();
    emit({ type: 'undo', label: e.label });
    return e.label;
  };

  const touchRecent = (id) => { state.recent = [id, ...state.recent.filter(x => x !== id)].slice(0, 8); };
  const target = (calcId) => calcId ? calc(calcId) : activeCalc();

  const add = (id, req, sp = 0, additive = true, calcId) => {
    const item = get(id);
    const c = target(calcId);
    if (!item) return { ok: false, reason: 'no-item' };
    if (!c) return { ok: false, reason: 'no-calc' };
    if (isNaN(req) || req <= 0 || req > MAX_QTY) return { ok: false, reason: 'invalid-qty' };
    if (item.isDynamic && (isNaN(sp) || sp == null || sp < 0)) return { ok: false, reason: 'needs-price' };
    pushUndo(`added ${item.n} to ${c.name}`);
    const prev = c.lines.get(id);
    const total = Math.min(MAX_QTY, additive && prev ? prev.req + req : req);
    const line = { item, req: total, packs: packsFor(item, total).packs, sp: item.isDynamic ? sp : 0, manual: false };
    c.lines.delete(id);
    c.lines.set(id, line);
    touch(c);
    touchRecent(id);
    persist();
    const costP = lineCostP(line);
    emit({ type: 'add', id, calcId: c.id });
    return { ok: true, item, calc: c, packs: line.packs, spare: lineSpare(line), short: lineShort(line), costP, cost: costP / 100, req: total };
  };

  const edit = (id, field, val, calcId) => {
    const c = target(calcId);
    const line = c && c.lines.get(id);
    if (!line) return { ok: false, reason: 'no-entry' };
    let v = parseFloat(val);
    if (isNaN(v) || v < 0) v = 0;
    let clamped = false;
    if (v > MAX_QTY) { v = MAX_QTY; clamped = true; }
    pushUndo(`edited ${line.item.n}`, `edit:${c.id}:${id}:${field}`);
    if (field === 'pack') { line.packs = Math.round(v); line.manual = line.packs !== packsFor(line.item, line.req).packs; }
    else if (field === 'req') { line.req = v; line.packs = packsFor(line.item, v).packs; line.manual = false; }
    else if (field === 'sp') { line.sp = v; }
    touch(c);
    persist();
    emit({ type: 'edit', id, field, calcId: c.id });
    const costP = lineCostP(line);
    return { ok: true, item: line.item, req: line.req, packs: line.packs, spare: lineSpare(line), short: lineShort(line), costP, cost: costP / 100, clamped };
  };

  const resetPacks = (id, calcId) => {
    const c = target(calcId);
    const line = c && c.lines.get(id);
    if (!line || !line.manual) return false;
    pushUndo(`reset packs of ${line.item.n}`);
    line.packs = packsFor(line.item, line.req).packs;
    line.manual = false;
    touch(c);
    persist();
    emit({ type: 'edit', id, field: 'pack', calcId: c.id });
    return true;
  };

  const remove = (id, calcId) => {
    const c = target(calcId);
    const line = c && c.lines.get(id);
    if (!line) return false;
    pushUndo(`removed ${line.item.n}`);
    c.lines.delete(id);
    touch(c);
    persist();
    emit({ type: 'remove', id, calcId: c.id });
    return true;
  };

  const clear = (calcId) => {
    const c = target(calcId);
    if (!c || !c.lines.size) return false;
    pushUndo(`cleared ${c.name}`);
    c.lines = new Map();
    touch(c);
    persist();
    emit({ type: 'clear', calcId: c.id });
    return true;
  };

  const newCalc = (name, opts = {}) => {
    if (state.calcs.length >= MAX_CALCS) return { ok: false, reason: 'full' };
    pushUndo('created a calculation');
    const c = makeCalc(name, opts.lines);
    const at = opts.after ? indexOf(opts.after) + 1 : state.calcs.length;
    state.calcs.splice(at > 0 ? at : state.calcs.length, 0, c);
    if (opts.activate !== false) state.active = c.id;
    persist();
    emit({ type: 'calcs', calcId: c.id });
    return { ok: true, calc: c };
  };

  const switchTo = (id) => {
    const c = calc(id);
    if (!c) return { ok: false };
    if (state.active === id) return { ok: true, same: true, calc: c };
    state.active = id;
    persist();
    emit({ type: 'switch', calcId: id });
    return { ok: true, calc: c };
  };
  const switchBy = (d) => {
    const n = state.calcs.length;
    if (n < 2) return { ok: false };
    const i = indexOf(activeCalc().id);
    return switchTo(state.calcs[((i + d) % n + n) % n].id);
  };

  const renameCalc = (id, name) => {
    const c = calc(id);
    const clean = String(name || '').trim().slice(0, 60);
    if (!c || !clean || c.name === clean) return false;
    pushUndo(`renamed ${c.name}`);
    c.name = clean;
    touch(c);
    persist();
    emit({ type: 'rename', calcId: id });
    return true;
  };

  const recolor = (id, hue) => {
    const c = calc(id);
    if (!c || c.hue === hue) return false;
    c.hue = ((hue % HUES) + HUES) % HUES;
    persist();
    emit({ type: 'rename', calcId: id });
    return true;
  };

  const duplicateCalc = (id) => {
    const c = calc(id);
    if (!c) return { ok: false };
    if (state.calcs.length >= MAX_CALCS) return { ok: false, reason: 'full' };
    pushUndo(`duplicated ${c.name}`);
    const d = makeCalc(`${c.name} copy`, cloneLines(c.lines));
    state.calcs.splice(indexOf(id) + 1, 0, d);
    state.active = d.id;
    persist();
    emit({ type: 'calcs', calcId: d.id });
    return { ok: true, calc: d };
  };

  const deleteCalc = (id) => {
    const i = indexOf(id);
    if (i < 0) return null;
    const c = state.calcs[i];
    pushUndo(`deleted ${c.name}`);
    state.calcs.splice(i, 1);
    if (state.active === id && state.calcs.length) state.active = state.calcs[Math.min(i, state.calcs.length - 1)].id;
    ensureOne();
    persist();
    emit({ type: 'calcs' });
    return c.name;
  };

  const moveCalc = (id, toIndex) => {
    const i = indexOf(id);
    if (i < 0) return false;
    const to = Math.max(0, Math.min(state.calcs.length - 1, toIndex));
    if (to === i) return false;
    pushUndo('reordered calculations');
    const [c] = state.calcs.splice(i, 1);
    state.calcs.splice(to, 0, c);
    persist();
    emit({ type: 'calcs' });
    return true;
  };

  const mergeLineInto = (to, l) => {
    const prev = to.lines.get(l.item.id);
    let line;
    if (!prev) line = { ...l };
    else {
      const req = Math.min(MAX_QTY, prev.req + l.req);
      const manual = prev.manual || l.manual;
      line = { item: l.item, req, packs: manual ? prev.packs + l.packs : packsFor(l.item, req).packs, sp: prev.sp || l.sp, manual };
    }
    to.lines.delete(l.item.id);
    to.lines.set(l.item.id, line);
    return !!prev;
  };

  const transferLine = (itemId, fromId, toId, mode = 'move') => {
    const from = calc(fromId);
    const l = from && from.lines.get(itemId);
    const fresh = toId === '__new';
    if (fresh && state.calcs.length >= MAX_CALCS) return { ok: false, reason: 'full' };
    let to = fresh ? null : calc(toId);
    if (!l || (!fresh && (!to || from === to))) return { ok: false };
    pushUndo(`${mode === 'copy' ? 'copied' : 'moved'} ${l.item.n}`);
    if (fresh) { to = makeCalc(); state.calcs.push(to); }
    const merged = mergeLineInto(to, l);
    if (mode !== 'copy') from.lines.delete(itemId);
    touch(from, to);
    persist();
    emit({ type: 'transfer', id: itemId, calcId: to.id, fromId: from.id });
    return { ok: true, merged, item: l.item, to, from };
  };

  const mergeCalc = (fromId, toId) => {
    const from = calc(fromId), to = calc(toId);
    if (!from || !to || from === to) return { ok: false };
    pushUndo(`merged ${from.name} into ${to.name}`);
    let merged = 0;
    from.lines.forEach(l => { if (mergeLineInto(to, l)) merged++; });
    state.calcs.splice(indexOf(fromId), 1);
    if (state.active === fromId) state.active = to.id;
    touch(to);
    persist();
    emit({ type: 'calcs', calcId: to.id });
    return { ok: true, count: from.lines.size, merged, from, to };
  };

  const membership = (itemId) => {
    const out = [];
    state.calcs.forEach((c, i) => { const l = c.lines.get(itemId); if (l) out.push({ calc: c, pos: i + 1, line: l, active: c.id === state.active }); });
    return out;
  };

  const importEntries = (data) => {
    if (!data || typeof data !== 'object') return { ok: false };
    const groups = Array.isArray(data.calcs) ? data.calcs.map(c => ({ name: c.name, hue: c.hue, items: c.items })) : Array.isArray(data.items) ? [{ name: typeof data.title === 'string' && data.title !== 'Current calculation' ? data.title : 'Imported', items: data.items }] : null;
    if (!groups || !groups.length) return { ok: false };
    if (state.calcs.length + groups.length > MAX_CALCS) return { ok: false, reason: 'full' };
    pushUndo('imported a file');
    let count = 0, dropped = 0, first = null;
    const onlyEmpty = state.calcs.length === 1 && !state.calcs[0].lines.size;
    const replaced = onlyEmpty ? state.calcs[0].id : null;
    groups.forEach(g => {
      const src = Array.isArray(g.items) ? g.items : [];
      const entries = hydrateEntries(src, !Array.isArray(data.calcs));
      count += entries.length;
      dropped += src.length - entries.length;
      const c = makeCalc(g.name || 'Imported', new Map(entries));
      state.calcs.push(c);
      if (!first) first = c;
    });
    if (replaced) state.calcs = state.calcs.filter(c => c.id !== replaced);
    state.active = first.id;
    persist();
    emit({ type: 'import' });
    return { ok: true, count, dropped, calcs: groups.length, calc: first };
  };

  const reflow = () => {
    let changed = 0;
    state.calcs.forEach(c => c.lines.forEach(l => {
      if (l.manual) return;
      const p = packsFor(l.item, l.req).packs;
      if (p !== l.packs) { l.packs = p; changed++; }
    }));
    persist();
    return changed;
  };

  const prefKeys = { web: KEYS.engine, addMode: KEYS.mode, quickQty: KEYS.qty };
  const setPref = (k, v) => {
    state.prefs[k] = v;
    try { if (prefKeys[k]) localStorage.setItem(prefKeys[k], String(v)); } catch (e) {}
    emit({ type: 'pref', key: k });
  };
  const setRounding = (engineId, mode) => {
    if (!ROUND_MODES[mode]) return 0;
    state.prefs.rounding[engineId] = mode;
    try { localStorage.setItem(KEYS.rounding, JSON.stringify(state.prefs.rounding)); } catch (e) {}
    const changed = reflow();
    emit({ type: 'rounding', changed });
    return changed;
  };
  const setMinOne = (v) => {
    state.prefs.minOne = !!v;
    try { localStorage.setItem(KEYS.minOne, v ? '1' : '0'); } catch (e) {}
    const changed = reflow();
    emit({ type: 'rounding', changed });
    return changed;
  };

  const title = () => activeCalc().name;

  const init = (catalog) => {
    db = catalog;
    byId = new Map(db.map(d => [d.id, d]));
    return load();
  };

  Object.defineProperty(state, 'lines', { get: () => activeCalc().lines, enumerable: false });

  window.addEventListener('storage', (e) => {
    if (e.key === KEYS.ws || e.key === KEYS.rounding || e.key === KEYS.minOne) { load(); emit({ type: 'external' }); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistNow(); });

  return {
    init, on, get, state, add, edit, remove, clear, resetPacks,
    newCalc, switchTo, switchBy, renameCalc, recolor, duplicateCalc, deleteCalc, moveCalc, transferLine, mergeCalc,
    calc, activeCalc, indexOf, byPosition, membership, importEntries, setPref, setRounding, setMinOne, roundingFor, packsFor,
    undo, title, totalP, packsTotal, grandTotalP, lineCostP, lineSpare, lineShort, serializeLines, serializeCalc, serializeWorkspace,
    hydrateEntries, persist, persistNow, load,
    get db() { return db; }, get undoStack() { return undoStack; }, set undoStack(v) { undoStack = v; }, snapshot, restore
  };
})();
