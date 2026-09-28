const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const icon = (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = isMac ? '⌘' : 'Ctrl';

const WEB_ENGINES = {
  brave: { label: 'Brave Search', icon: 'compass', web: q => `https://search.brave.com/search?q=${q}`, img: q => `https://search.brave.com/images?q=${q}` },
  ddg: { label: 'DuckDuckGo', icon: 'shield', web: q => `https://duckduckgo.com/?q=${q}`, img: q => `https://duckduckgo.com/?q=${q}&ia=images&iax=images` },
  startpage: { label: 'Startpage', icon: 'lock', web: q => `https://www.startpage.com/do/dsearch?query=${q}`, img: q => `https://www.startpage.com/do/dsearch?query=${q}&cat=images` },
  google: { label: 'Google', icon: 'globe', web: q => `https://www.google.com/search?q=${q}`, img: q => `https://www.google.com/search?tbm=isch&q=${q}` },
  bing: { label: 'Bing', icon: 'search', web: q => `https://www.bing.com/search?q=${q}`, img: q => `https://www.bing.com/images/search?q=${q}` }
};
const webEngine = () => WEB_ENGINES[Store.state.prefs.web] || WEB_ENGINES.brave;
const webLinks = (item) => {
  const q = encodeURIComponent(item.n);
  const e = webEngine();
  return [
    { icon: e.icon, label: e.label, href: e.web(q) },
    { icon: 'image', label: 'Images', href: e.img(q) },
    { icon: 'cross', label: 'Drugs.com', href: `https://www.drugs.com/search.php?searchterm=${q}` },
    { icon: 'sparkle', label: 'Perplexity', href: `https://www.perplexity.ai/search?q=${q}` }
  ];
};

const KIND_ICON = { pill: 'pill', syringe: 'syringe', vial: 'vial', bottle: 'bottle', inhaler: 'air', tube: 'tube', box: 'box' };
const ENGINE_ICON = { pack: 'box', insulin: 'syringe', supply: 'percent' };
const itemIcon = (item, cls = '') => `<span class="row-icon" data-engine="${esc(item.engineId)}" aria-hidden="true">${icon(KIND_ICON[item.kind] || 'box', cls)}</span>`;
const tierTag = (item) => item.t ? `<span class="tag tier-${esc(item.tierId)}" dir="auto" title="${esc(item.tLabel)}">${esc(item.t)}</span>` : '';
const priceLabel = (item) => item.isDynamic ? `${Math.round(item.ratio * 100)}% of supply` : `${item.p.toFixed(2)} EGP`;
const unitPriceLabel = (item) => item.isDynamic ? '' : `${money(Math.round(item.pP / item.bQty))} / ${item.bType}`;

const highlight = (txt, tokens) => {
  let out = esc(txt);
  if (!tokens || !tokens.length) return out;
  const parts = [...new Set(tokens.filter(t => t.length > 0))].sort((a, b) => b.length - a.length).map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return out;
  const re = new RegExp(`(${parts.join('|')})(?![^<]*>)`, 'gi');
  return out.replace(re, '<mark>$1</mark>');
};

const Toast = (() => {
  const host = () => $('toasts');
  const dismiss = (t) => { if (!t || t.classList.contains('out')) return; t.classList.add('out'); setTimeout(() => t.remove(), 320); };
  const trim = () => { const h = host(); while (h.children.length >= 3) h.firstChild.remove(); };
  const show = (msg, kind = 'ok', ic) => {
    const h = host();
    Array.from(h.children).forEach(t => { if (t.dataset.msg === msg) t.remove(); });
    trim();
    const t = document.createElement('div');
    t.className = `toast ${kind === 'ok' ? '' : kind}`;
    t.dataset.msg = msg;
    t.innerHTML = `${icon(ic || (kind === 'warn' ? 'warning' : 'check'))}<span class="msg">${esc(msg)}</span>`;
    h.appendChild(t);
    setTimeout(() => dismiss(t), 2800);
    return t;
  };
  const undo = (msg) => {
    const h = host();
    h.querySelectorAll('.toast.has-undo').forEach(x => x.remove());
    trim();
    const t = document.createElement('div');
    t.className = 'toast del has-undo';
    t.innerHTML = `${icon('trash')}<span class="msg">${esc(msg)}</span><button class="undo" data-action="undo">${icon('undo', 'sm')}UNDO</button><span class="bar" style="animation-duration:30s"></span>`;
    h.appendChild(t);
    setTimeout(() => dismiss(t), 30000);
    return t;
  };
  const clearUndo = () => host().querySelectorAll('.toast.has-undo').forEach(dismiss);
  return { show, undo, clearUndo };
})();

const legacyCopy = (text) => {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
};
const copyText = (text) => new Promise(res => {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => res(true)).catch(() => res(legacyCopy(text)));
  else res(legacyCopy(text));
});
const download = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
};

const FocusTrap = (() => {
  let box = null, handler = null;
  const focusables = (c) => Array.from(c.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length);
  const set = (c) => {
    release();
    box = c;
    handler = (e) => {
      if (e.key !== 'Tab') return;
      const f = focusables(c);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    c.addEventListener('keydown', handler);
  };
  const release = () => { if (box && handler) box.removeEventListener('keydown', handler); box = null; handler = null; };
  return { set, release };
})();

const Popover = (() => {
  let owner = null;
  const el = () => $('popover');
  const open = (key, anchor, html, width = 210) => {
    if (owner === key) { close(); return false; }
    const p = el();
    p.innerHTML = html;
    const r = anchor.getBoundingClientRect();
    const w = Math.max(width, r.width);
    p.style.minWidth = `${w}px`;
    p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const below = r.bottom + 6;
    p.classList.add('open');
    const h = p.offsetHeight;
    p.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below}px`;
    owner = key;
    anchor.setAttribute('aria-expanded', 'true');
    p._anchor = anchor;
    return true;
  };
  const close = () => {
    if (!owner) return;
    const p = el();
    p.classList.remove('open');
    if (p._anchor) p._anchor.setAttribute('aria-expanded', 'false');
    owner = null;
  };
  return { open, close, get owner() { return owner; } };
})();
