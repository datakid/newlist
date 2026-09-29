const MAX_QTY = 999999;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const normalizeDigits = (s) => String(s == null ? '' : s).replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)));
const normalizeText = (s) => normalizeDigits(s).toLowerCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
const toPiastres = (v) => Math.round((Number(v) || 0) * 100);
const money = (p) => (p / 100).toFixed(2);
const fmtNum = (n) => Number.isInteger(n) ? n : +Number(n).toFixed(2);
const ROUND_MODES = {
  round: { label: 'Nearest', verb: 'Round to nearest', glyph: '≈', fn: Math.round },
  ceil: { label: 'Up', verb: 'Always round up', glyph: '↑', fn: Math.ceil },
  floor: { label: 'Down', verb: 'Always round down', glyph: '↓', fn: Math.floor }
};
const DEFAULT_ROUND = 'round';
const roundPacks = (ratio, mode) => {
  const snapped = Math.abs(ratio - Math.round(ratio)) < 1e-9 ? Math.round(ratio) : ratio;
  return (ROUND_MODES[mode] || ROUND_MODES[DEFAULT_ROUND]).fn(snapped);
};
const packInfo = (req, bQty, mode = DEFAULT_ROUND, minOne = false) => {
  const q = bQty || 1;
  const r = Math.max(0, req || 0);
  let packs = roundPacks(r / q, mode);
  if (minOne && r > 0 && packs < 1) packs = 1;
  const cover = packs * q;
  return { packs, spare: Math.max(0, +(cover - r).toFixed(4)), short: Math.max(0, +(r - cover).toFixed(4)), exact: +(r / q).toFixed(4) };
};

const QTY_RE = /(?<=[\s\d])[x*×]\s*(\d+(?:[.,]\d+)?)\s*([up])?\s*$/i;
const PRICE_RE = /\s*@\s*(\d+(?:[.,]\d+)?)\s*/i;
const CALC_RE = /(?:^|\s)#\s*(\d{1,2})(?=\s|$)/;

const parseCommand = (raw) => {
  let s = normalizeDigits(raw);
  const intent = { query: '', qty: null, unit: null, price: null, qtyInvalid: false, calc: null };
  const cm = s.match(CALC_RE);
  if (cm) {
    intent.calc = parseInt(cm[1], 10);
    s = s.slice(0, cm.index) + ' ' + s.slice(cm.index + cm[0].length);
  }
  const pm = s.match(PRICE_RE);
  if (pm) {
    intent.price = parseFloat(pm[1].replace(',', '.'));
    s = s.slice(0, pm.index) + ' ' + s.slice(pm.index + pm[0].length);
  }
  const qm = s.match(QTY_RE);
  if (qm) {
    const n = parseFloat(qm[1].replace(',', '.'));
    s = s.slice(0, qm.index);
    if (n > 0) {
      intent.qty = Math.min(n, MAX_QTY);
      const l = qm[2] ? qm[2].toLowerCase() : null;
      intent.unit = l === 'u' ? 'unit' : l === 'p' ? 'pack' : 'default';
    } else intent.qtyInvalid = true;
  }
  intent.query = s.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
  return intent;
};

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const hashStr = (s) => { let h = 5381; for (let k = 0; k < s.length; k++) { h = ((h << 5) + h) + s.charCodeAt(k); h |= 0; } return (h >>> 0).toString(36); };
const makeStableId = (name, unit, company) => `${slugify(name) || 'item'}-${hashStr(`${name}|${unit}|${company}`)}`;

const levenshtein = (a, b, max = 3) => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
};

const kindFor = (unit) => {
  const u = unit.toLowerCase();
  if (/tab|cap|film/.test(u)) return 'pill';
  if (/pen|cartridge/.test(u)) return 'syringe';
  if (u.includes('vial')) return 'vial';
  if (u.includes('bottle')) return 'bottle';
  if (/spray|inhaler/.test(u)) return 'inhaler';
  if (u.includes('tube')) return 'tube';
  return 'box';
};

const COST_MODELS = {
  fixed: (item, packs) => Math.round(packs * item.pP),
  share: (item, packs, sp) => Math.round(packs * Math.round(toPiastres(sp) * item.ratio))
};
const costOf = (item, packs, sp) => (COST_MODELS[item.model] || COST_MODELS.fixed)(item, packs || 0, sp || 0);

const buildCatalog = (data) => {
  const defs = data.defaults || {};
  const reverse = {};
  Object.entries(data.aliases || {}).forEach(([g, b]) => { (reverse[b] = reverse[b] || []).push(g); });
  return data.items.map(raw => {
    const sourceId = raw.source || defs.source;
    const engineId = raw.engine || defs.engine;
    const eng = data.engines[engineId];
    const src = data.sources[sourceId] || { label: sourceId, ar: sourceId };
    const tier = raw.tier ? data.tiers[raw.tier] : null;
    let bQty = 1, bType = raw.unit;
    if (eng.baseUnit) { bQty = raw.packUnits || eng.packUnits || 1; bType = eng.baseUnit; }
    else {
      const m = raw.unit.match(/(\d+)/);
      if (m) { bQty = parseInt(m[1], 10); bType = raw.unit.replace(/\d+/g, '').trim() || 'Unit'; }
    }
    const legacyName = tier ? `${raw.name} ${tier.ar}` : raw.name;
    const nameN = normalizeText(raw.name);
    const generics = reverse[nameN.split(' ')[0]] || [];
    const words = [...new Set([...nameN.split(' '), ...nameN.split(/[\s/]+/)])].filter(Boolean);
    return {
      id: makeStableId(legacyName, raw.unit, src.ar || src.label),
      n: raw.name, t: tier ? tier.ar : '', tLabel: tier ? tier.label : '', tierId: raw.tier || '',
      u: raw.unit, p: raw.price, pP: toPiastres(raw.price),
      sourceId, s: src.label, engineId, engineLabel: eng.label, model: eng.model, ratio: eng.ratio || 1, rounding: ROUND_MODES[eng.rounding] ? eng.rounding : DEFAULT_ROUND,
      isDynamic: eng.model === 'share', bQty, bType, kind: kindFor(raw.unit), generics, nameN, words,
      hay: normalizeText([raw.name, tier ? `${tier.ar} ${tier.label}` : '', raw.unit, src.label, src.ar, eng.label, ...generics].join(' '))
    };
  });
};

const scoreToken = (item, tk) => {
  let best = 0;
  if (item.words[0] && item.words[0].startsWith(tk)) best = item.words[0] === tk ? 40 : 28;
  for (const w of item.words) {
    if (w === tk) best = Math.max(best, 30);
    else if (w.startsWith(tk)) best = Math.max(best, 20);
  }
  if (!best) for (const g of item.generics) if (g.startsWith(tk)) best = Math.max(best, g === tk ? 26 : 18);
  if (!best && item.hay.includes(tk)) best = 8;
  if (!best && tk.length >= 4 && !/\d/.test(tk)) {
    const lim = tk.length >= 7 ? 2 : 1;
    for (const w of item.words.concat(item.generics)) {
      const cand = w.length > tk.length + 1 ? w.slice(0, tk.length) : w;
      const d = levenshtein(cand, tk, lim);
      if (d <= lim) best = Math.max(best, 6 - d);
    }
  }
  return best;
};

const queryTokens = (q) => normalizeText(q).split(' ').filter(Boolean);
const naturalCmp = (a, b) => a.n.localeCompare(b.n, undefined, { numeric: true, sensitivity: 'base' }) || a.tierId.localeCompare(b.tierId);

const matchScore = (item, tokens, qn) => {
  let total = 0;
  for (const tk of tokens) { const s = scoreToken(item, tk); if (!s) return 0; total += s; }
  if (item.nameN === qn) total += 100;
  else if (item.nameN.startsWith(qn)) total += 15;
  return total;
};

const FACETS = [
  { key: 'type', title: 'Type', any: 'Any type', get: i => i.engineId, name: i => i.engineLabel },
  { key: 'unit', title: 'Unit', any: 'Any unit', get: i => i.u, name: i => i.u },
  { key: 'source', title: 'Source', any: 'Any source', get: i => i.sourceId, name: i => i.s },
  { key: 'tier', title: 'Tier', any: 'Any tier', get: i => i.tierId || 'standard', name: i => i.tLabel || 'Standard' }
];
const facetPass = (item, facets, skip) => FACETS.every(f => f.key === skip || !facets[f.key] || facets[f.key] === 'all' || f.get(item) === facets[f.key]);

const searchCatalog = (db, query, facets = {}) => {
  const tokens = queryTokens(query);
  const qn = normalizeText(query);
  const out = [];
  for (const item of db) {
    if (!facetPass(item, facets)) continue;
    const score = tokens.length ? matchScore(item, tokens, qn) : 1;
    if (score) out.push({ item, score });
  }
  out.sort((a, b) => b.score - a.score || naturalCmp(a.item, b.item));
  return out.map(r => r.item);
};

const facetCounts = (db, query, facets, key) => {
  const f = FACETS.find(x => x.key === key);
  const tokens = queryTokens(query);
  const qn = normalizeText(query);
  const map = new Map();
  for (const item of db) {
    if (!facetPass(item, facets, key)) continue;
    if (tokens.length && !matchScore(item, tokens, qn)) continue;
    const v = f.get(item);
    const cur = map.get(v) || { name: f.name(item), count: 0 };
    cur.count++;
    map.set(v, cur);
  }
  return map;
};

const suggestFor = (db, query) => {
  const tk = queryTokens(query).find(t => t.length >= 4 && !/\d/.test(t));
  if (!tk) return null;
  let best = null, bestD = Infinity;
  for (const item of db) {
    for (const w of [item.words[0], ...item.generics]) {
      if (!w) continue;
      const d = levenshtein(w, tk, 3);
      if (d < bestD) { bestD = d; best = item; }
    }
  }
  if (!best || bestD > 3 || bestD >= tk.length / 2) return null;
  const brand = best.n.split(' ')[0];
  return brand.charAt(0).toUpperCase() + brand.slice(1);
};
