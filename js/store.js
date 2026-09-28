const SCHEMA_VERSION = 3;
const MAX_ORDERS = 10;
const MAX_UNDO = 25;
const KEYS = { ver: 'lx_schema_version', calc: 'lx_current_calc', orders: 'lx_calc_orders', engine: 'lx_engine', mode: 'lx_add_mode', qty: 'lx_default_qty', recent: 'lx_recent', draft: 'lx_draft_name' };

const Store = (() => {
  let db = [];
  let byId = new Map();
  const state = { lines: new Map(), orders: [], current: -1, draftName: '', prefs: { web: 'brave', addMode: 'unit', quickQty: 1 }, recent: [] };
  const listeners = new Set();
  let undoStack = [];
  let saveTimer = null;

  const emit = (evt) => listeners.forEach(fn => fn(evt || {}));
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const get = (id) => byId.get(id);

  const findLegacy = (it) => {
    if (!it) return null;
    if (it.id && byId.has(it.id)) return byId.get(it.id);
    return db.find(d => d.n === it.n && d.u === it.u && d.s === it.s && (d.t || '') === (it.t || '')) || null;
  };

  const hydrateEntries = (entries) => {
    if (!Array.isArray(entries)) return [];
    const out = [];
    entries.forEach(e => {
      if (!Array.isArray(e) || e.length !== 2 || !e[1]) return;
      const v = e[1];
      const item = (e[0] && byId.get(e[0])) || findLegacy(v.item);
      if (!item) return;
      const req = Math.max(0, Number(v.req) || 0);
      const packs = Math.max(0, Number(v.packs) || 0);
      const sp = Math.max(0, Number(v.supplyPrice != null ? v.supplyPrice : v.sp) || 0);
      out.push([item.id, { item, req, packs, sp }]);
    });
    return out;
  };

  const lineCostP = (l) => costOf(l.item, l.packs, l.sp);
  const lineSpare = (l) => Math.max(0, l.packs * l.item.bQty - l.req);
  const totalP = (lines = state.lines) => { let t = 0; lines.forEach(l => t += lineCostP(l)); return t; };

  const serializeLines = (lines = state.lines) => Array.from(lines.entries()).map(([id, l]) => [id, {
    req: l.req, packs: l.packs, supplyPrice: l.sp, cost: lineCostP(l) / 100,
    item: { id: l.item.id, n: l.item.n, t: l.item.t, u: l.item.u, s: l.item.s, bQty: l.item.bQty, bType: l.item.bType, engine: l.item.engineId }
  }]);
  const serializeOrders = () => state.orders.map(o => ({ id: o.id, name: o.name, total: `${money(totalP(o.lines))} EGP`, items: serializeLines(o.lines) }));

  const persistNow = () => {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(KEYS.ver, String(SCHEMA_VERSION));
      localStorage.setItem(KEYS.calc, JSON.stringify(serializeLines()));
      localStorage.setItem(KEYS.orders, JSON.stringify(serializeOrders()));
      localStorage.setItem(KEYS.recent, JSON.stringify(state.recent));
      localStorage.setItem(KEYS.draft, state.draftName || '');
      localStorage.setItem('lx_current_order', String(state.current));
    } catch (e) { emit({ type: 'storage-error' }); }
  };
  const persist = (now) => { clearTimeout(saveTimer); if (now) persistNow(); else saveTimer = setTimeout(persistNow, 250); };

  const load = () => {
    try {
      state.lines = new Map(hydrateEntries(JSON.parse(localStorage.getItem(KEYS.calc) || '[]')));
      const rawOrders = JSON.parse(localStorage.getItem(KEYS.orders) || '[]');
      state.orders = (Array.isArray(rawOrders) ? rawOrders : []).filter(o => o && typeof o === 'object').map(o => ({ id: String(o.id || Date.now()), name: String(o.name || 'Order').slice(0, 60), lines: new Map(hydrateEntries(o.items || [])) }));
      const cur = parseInt(localStorage.getItem('lx_current_order'), 10);
      state.current = Number.isInteger(cur) && cur >= 0 && cur < state.orders.length ? cur : -1;
      if (state.current >= 0) state.lines = new Map(Array.from(state.orders[state.current].lines.entries()).map(([k, v]) => [k, { ...v }]));
      const rec = JSON.parse(localStorage.getItem(KEYS.recent) || '[]');
      state.recent = Array.isArray(rec) ? rec.filter(id => byId.has(id)).slice(0, 8) : [];
      state.draftName = localStorage.getItem(KEYS.draft) || '';
      state.prefs.web = localStorage.getItem(KEYS.engine) || 'brave';
      state.prefs.addMode = localStorage.getItem(KEYS.mode) === 'pack' ? 'pack' : 'unit';
      state.prefs.quickQty = parseFloat(localStorage.getItem(KEYS.qty)) || 1;
      const ver = parseInt(localStorage.getItem(KEYS.ver) || '1', 10);
      if (ver < SCHEMA_VERSION) persist(true);
    } catch (e) {}
  };

  const snapshot = () => ({
    lines: new Map(Array.from(state.lines.entries()).map(([k, v]) => [k, { ...v }])),
    orders: state.orders.map(o => ({ ...o, lines: new Map(Array.from(o.lines.entries()).map(([k, v]) => [k, { ...v }])) })),
    current: state.current, draftName: state.draftName
  });
  const restore = (s) => { state.lines = s.lines; state.orders = s.orders; state.current = s.current; state.draftName = s.draftName; };
  const pushUndo = (label) => { undoStack.push({ label, snap: snapshot() }); if (undoStack.length > MAX_UNDO) undoStack.shift(); };
  const undo = () => {
    const e = undoStack.pop();
    if (!e) return null;
    restore(e.snap);
    persist();
    emit({ type: 'undo', label: e.label });
    return e.label;
  };

  const syncOrder = () => {
    if (state.current >= 0 && state.orders[state.current]) state.orders[state.current].lines = new Map(Array.from(state.lines.entries()).map(([k, v]) => [k, { ...v }]));
    persist();
  };

  const touchRecent = (id) => { state.recent = [id, ...state.recent.filter(x => x !== id)].slice(0, 8); };

  const add = (id, req, sp = 0, additive = true) => {
    const item = get(id);
    if (!item) return { ok: false, reason: 'no-item' };
    if (isNaN(req) || req <= 0 || req > MAX_QTY) return { ok: false, reason: 'invalid-qty' };
    if (item.isDynamic && (isNaN(sp) || sp == null || sp < 0)) return { ok: false, reason: 'needs-price' };
    if (!item.isDynamic) sp = 0;
    pushUndo(`added ${item.n}`);
    const prev = state.lines.get(id);
    const total = Math.min(MAX_QTY, additive && prev ? prev.req + req : req);
    const { packs, spare } = packInfo(total, item.bQty);
    const line = { item, req: total, packs, sp: item.isDynamic ? sp : 0 };
    state.lines.delete(id);
    state.lines.set(id, line);
    touchRecent(id);
    syncOrder();
    const costP = lineCostP(line);
    emit({ type: 'add', id });
    return { ok: true, item, packs, spare, costP, cost: costP / 100, req: total };
  };

  const edit = (id, field, val) => {
    const line = state.lines.get(id);
    if (!line) return { ok: false, reason: 'no-entry' };
    let v = parseFloat(val);
    if (isNaN(v) || v < 0) v = 0;
    let clamped = false;
    if (v > MAX_QTY) { v = MAX_QTY; clamped = true; }
    pushUndo(`edited ${line.item.n}`);
    if (field === 'pack') { line.packs = Math.round(v); }
    else if (field === 'req') { line.req = v; line.packs = packInfo(v, line.item.bQty).packs; }
    else if (field === 'sp') { line.sp = v; }
    syncOrder();
    emit({ type: 'edit', id, field });
    const costP = lineCostP(line);
    return { ok: true, item: line.item, req: line.req, packs: line.packs, spare: lineSpare(line), costP, cost: costP / 100, clamped };
  };

  const remove = (id) => {
    const line = state.lines.get(id);
    if (!line) return false;
    pushUndo(`removed ${line.item.n}`);
    state.lines.delete(id);
    syncOrder();
    emit({ type: 'remove', id });
    return true;
  };

  const clear = () => {
    if (!state.lines.size && state.current < 0) return false;
    pushUndo('cleared the calculator');
    state.lines = new Map();
    state.current = -1;
    state.draftName = '';
    persist();
    emit({ type: 'clear' });
    return true;
  };

  const autoSaveUnfinished = () => {
    const name = `Unfinished ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    state.orders.push({ id: Date.now().toString(), name: state.draftName || name, lines: snapshot().lines });
  };

  const guardUnsaved = () => {
    if (state.current === -1 && state.lines.size > 0) {
      if (state.orders.length >= MAX_ORDERS) return { ok: false, reason: 'orders-full' };
      autoSaveUnfinished();
      return { ok: true, autosaved: true };
    }
    return { ok: true, autosaved: false };
  };

  const newOrder = () => {
    pushUndo('started a new order');
    const g = guardUnsaved();
    if (!g.ok) { undoStack.pop(); return g; }
    state.lines = new Map(); state.current = -1; state.draftName = '';
    persist();
    emit({ type: 'orders' });
    return g;
  };

  const saveOrder = () => {
    if (!state.lines.size) return { ok: false, reason: 'empty' };
    if (state.current >= 0) { syncOrder(); persist(true); emit({ type: 'orders' }); return { ok: true, updated: true }; }
    if (state.orders.length >= MAX_ORDERS) return { ok: false, reason: 'orders-full' };
    pushUndo('saved an order');
    const d = new Date();
    const name = state.draftName || `Order ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    state.orders.push({ id: Date.now().toString(), name: name.slice(0, 60), lines: snapshot().lines });
    state.current = state.orders.length - 1;
    state.draftName = '';
    persist(true);
    emit({ type: 'orders' });
    return { ok: true, updated: false };
  };

  const loadOrder = (idx) => {
    const o = state.orders[idx];
    if (!o) return { ok: false };
    if (idx === state.current) return { ok: true, same: true, name: o.name };
    pushUndo(`switched to ${o.name}`);
    const g = guardUnsaved();
    if (!g.ok) { undoStack.pop(); return g; }
    state.lines = new Map(Array.from(o.lines.entries()).map(([k, v]) => [k, { ...v }]));
    state.current = idx;
    persist();
    emit({ type: 'orders' });
    return { ok: true, name: o.name, autosaved: g.autosaved };
  };

  const deleteOrder = (idx) => {
    const o = state.orders[idx];
    if (!o) return false;
    pushUndo(`deleted order "${o.name}"`);
    state.orders.splice(idx, 1);
    if (state.current === idx) { state.current = -1; state.lines = new Map(); }
    else if (state.current > idx) state.current--;
    persist();
    emit({ type: 'orders' });
    return o.name;
  };

  const renameOrder = (idx, name) => {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) return false;
    if (idx < 0) { state.draftName = clean; persist(); emit({ type: 'rename' }); return true; }
    const o = state.orders[idx];
    if (!o || o.name === clean) return false;
    pushUndo(`renamed ${o.name}`);
    o.name = clean;
    persist();
    emit({ type: 'rename' });
    return true;
  };

  const duplicateOrder = (idx) => {
    const o = state.orders[idx];
    if (!o) return { ok: false };
    if (state.orders.length >= MAX_ORDERS) return { ok: false, reason: 'orders-full' };
    pushUndo(`duplicated ${o.name}`);
    state.orders.splice(idx + 1, 0, { id: Date.now().toString(), name: `${o.name} (Copy)`.slice(0, 60), lines: new Map(Array.from(o.lines.entries()).map(([k, v]) => [k, { ...v }])) });
    if (state.current > idx) state.current++;
    persist();
    emit({ type: 'orders' });
    return { ok: true };
  };

  const importEntries = (data) => {
    if (!data || !Array.isArray(data.items)) return { ok: false };
    const entries = hydrateEntries(data.items);
    pushUndo('imported a file');
    state.lines = new Map(entries);
    state.current = -1;
    state.draftName = typeof data.title === 'string' && data.title !== 'Current calculation' ? data.title.slice(0, 60) : '';
    persist();
    emit({ type: 'import' });
    return { ok: true, count: entries.length, dropped: data.items.length - entries.length };
  };

  const setPref = (k, v) => {
    state.prefs[k] = v;
    const map = { web: KEYS.engine, addMode: KEYS.mode, quickQty: KEYS.qty };
    try { localStorage.setItem(map[k], String(v)); } catch (e) {}
    emit({ type: 'pref', key: k });
  };

  const title = () => state.current >= 0 && state.orders[state.current] ? state.orders[state.current].name : (state.draftName || 'Current calculation');

  const init = (catalog) => {
    db = catalog;
    byId = new Map(db.map(d => [d.id, d]));
    load();
  };

  window.addEventListener('storage', (e) => {
    if ([KEYS.calc, KEYS.orders].includes(e.key)) { load(); emit({ type: 'external' }); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistNow(); });

  return {
    init, on, get, state, add, edit, remove, clear, newOrder, saveOrder, loadOrder, deleteOrder, renameOrder, duplicateOrder,
    importEntries, setPref, undo, title, totalP, lineCostP, lineSpare, serializeLines, hydrateEntries, persist, load,
    get db() { return db; }, get undoStack() { return undoStack; }, set undoStack(v) { undoStack = v; }, snapshot, restore
  };
})();
