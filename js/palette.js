const Palette = (() => {
  let items = [];
  let active = -1;
  let paneFocused = false;
  let paneIdx = 0;
  let lastQuery = '';
  let lastFocus = null;
  const E = {};
  const SIZES = QUICK_SIZES;

  const isOpen = () => E.root && E.root.classList.contains('open');
  const themeMode = () => document.documentElement.getAttribute('data-theme-mode') || 'system';
  const run = (fn, close = true) => () => { if (close) hide(true); fn(); };
  const keep = (fn) => () => { fn(); refresh(); };

  const commands = () => [
    { icon: 'tray', title: 'Open calculation', sub: `${Store.state.lines.size} items`, keys: 'tray calculator cart', actions: [{ icon: 'tray', label: 'Open calculation', shortcut: 'Enter', run: run(() => { if (narrow()) openTray(); else { const f = document.querySelector('.line-in'); if (f) f.focus(); } }) }] },
    { icon: 'plus', title: 'New calculation', sub: 'Alt N', keys: 'new calc calculation order blank add patient', actions: [{ icon: 'plus', label: 'New calculation', shortcut: 'Enter', run: run(() => newCalc()) }] },
    { icon: 'board', title: 'All calculations', sub: 'Alt B', keys: 'board overview all calculations orders compare side', actions: [{ icon: 'board', label: 'Open side by side', shortcut: 'Enter', run: run(() => openBoard()) }] },
    { icon: 'gear', title: 'Settings & rounding', sub: 'Nearest · up · down', keys: 'settings preferences rounding round ceil floor up down nearest', actions: [{ icon: 'gear', label: 'Open settings', shortcut: 'Enter', run: run(openSettings) }] },
    { icon: 'copy', title: 'Copy summary', sub: Store.title(), keys: 'export copy text share', actions: [{ icon: 'copy', label: `Copy ${Store.title()}`, shortcut: 'Enter', run: run(() => exportText()) }, { icon: 'board', label: 'Copy all calculations', run: run(copyAll) }] },
    { icon: 'download', title: 'Download', sub: 'JSON · CSV', keys: 'download export json csv file backup', actions: [{ icon: 'download', label: 'This calculation · JSON', shortcut: 'Enter', run: run(() => downloadJSON()) }, { icon: 'table', label: 'This calculation · CSV', run: run(() => downloadCSV()) }, { icon: 'download', label: 'All calculations · JSON', run: run(downloadAllJSON) }, { icon: 'table', label: 'All calculations · CSV', run: run(downloadAllCSV) }] },
    { icon: 'upload', title: 'Import file', sub: '.json', keys: 'import upload open file', actions: [{ icon: 'upload', label: 'Choose file…', shortcut: 'Enter', run: run(() => $('fileUpload').click()) }] },
    { icon: 'trash', title: 'Clear calculation', sub: 'Undo available', keys: 'clear empty reset delete', actions: [{ icon: 'trash', label: `Clear ${Store.title()}`, shortcut: 'Enter', run: run(clearTray) }] },
    ...Object.entries(App.data.engines).filter(([k]) => App.db.some(i => i.engineId === k && i.bQty > 1)).map(([k, e]) => { const cur = Store.state.prefs.rounding[k] || DEFAULT_ROUND; return { icon: 'calc', title: `Rounding · ${e.label}`, sub: ROUND_MODES[cur].label, keys: `rounding round ceil floor up down nearest ${e.label}`, actions: Object.entries(ROUND_MODES).map(([m, r]) => ({ icon: 'calc', label: r.verb, active: cur === m, run: keep(() => setRounding(k, m)) })) }; }),
    { icon: 'undo', title: 'Undo', sub: `${MOD} Z`, keys: 'undo revert back', actions: [{ icon: 'undo', label: 'Undo last change', shortcut: 'Enter', run: run(doUndo) }] },
    { icon: 'calc', title: 'Filter by calculation type', sub: App.view.facets.type === 'all' ? 'All' : App.data.engines[App.view.facets.type].label, keys: 'type engine insulin supply pack filter', actions: [{ icon: 'grid', label: 'All types', active: App.view.facets.type === 'all', run: run(() => setFacet('type', 'all')) }, ...Object.entries(App.data.engines).map(([k, e]) => ({ icon: ENGINE_ICON[k] || 'box', label: e.label, active: App.view.facets.type === k, run: run(() => { App.view.facets.type = k; search(); }) }))] },
    { icon: 'sliders', title: 'Reset filters & sort', sub: '', keys: 'reset clear filters sort', actions: [{ icon: 'x', label: 'Reset', shortcut: 'Enter', run: run(clearFacets) }] },
    { icon: 'ruler', title: 'Add quantities as', sub: addMode() === 'pack' ? 'Packs' : 'Base units', keys: 'unit pack mode global default', actions: [{ icon: 'ruler', label: 'Base units', active: addMode() === 'unit', run: keep(() => setAddMode('unit')) }, { icon: 'box', label: 'Packs', active: addMode() === 'pack', run: keep(() => setAddMode('pack')) }] },
    { icon: 'bolt', title: 'Default quick-add quantity', sub: String(quickQty()), keys: 'default quick size qty quantity', actions: SIZES.map(n => ({ icon: 'bolt', label: String(n), active: quickQty() === n, run: keep(() => setQuickQty(n)) })) },
    { icon: 'globe', title: 'Web search engine', sub: webEngine().label, keys: 'engine web search brave google bing duck startpage', actions: Object.entries(WEB_ENGINES).map(([k, w]) => ({ icon: w.icon, label: w.label, active: Store.state.prefs.web === k, run: keep(() => setWeb(k)) })) },
    { icon: THEME[themeMode()].icon, title: 'Theme', sub: THEME[themeMode()].label, keys: 'theme dark light system appearance', actions: ['system', 'light', 'dark'].map(m => ({ icon: THEME[m].icon, label: THEME[m].label, active: themeMode() === m, run: keep(() => setTheme(m)) })) }
  ];

  const calcActions = (cid) => [
    { icon: 'target', label: 'Switch to it', shortcut: 'Enter', run: run(() => { switchCalc(cid, { silent: true }); openTray(); }) },
    { icon: 'edit', label: 'Rename', run: keep(() => { const n = $('paneOrderName'); if (n && Store.renameCalc(cid, n.value)) Toast.show('Renamed', 'ok', 'edit'); }) },
    { icon: 'copy', label: 'Duplicate', run: keep(() => duplicateCalc(cid)) },
    { icon: 'copy', label: 'Copy summary', run: run(() => exportText(cid)) },
    { icon: 'trash', label: 'Delete calculation', run: run(() => deleteCalc(cid)) }
  ];

  const medActions = (item, intent) => {
    const acts = [
      { icon: 'plus', label: `Add to ${(intentCalc(intent) || Store.activeCalc()).name}`, shortcut: 'Enter', run: () => paneAdd(item, false, intent) },
      { icon: 'tray', label: 'Add & open tray', shortcut: `${MOD}⏎`, run: () => paneAdd(item, true, intent) },
      ...(multi() ? Store.state.calcs.filter(c => c.id !== (intentCalc(intent) || Store.activeCalc()).id).slice(0, 8).map(c => ({ icon: 'target', label: `Add to ${calcPos(c)} · ${c.name}`, run: () => paneAdd(item, false, intent, c.id) })) : []),
      { icon: 'info', label: 'Details', run: run(() => openDetails(item.id)) },
      { icon: 'copy', label: 'Copy info', run: () => copyItem(item.id) },
      ...webLinks(item).map(l => ({ icon: l.icon, label: `Search ${l.label}`, run: () => { window.open(l.href, '_blank', 'noopener'); } }))
    ];
    return acts;
  };

  const build = (q) => {
    const intent = parseCommand(q);
    const qn = normalizeText(intent.query);
    const list = [];
    if (qn) searchCatalog(App.db, intent.query).slice(0, 8).forEach(item => list.push({ type: 'med', item, intent, icon: KIND_ICON[item.kind] || 'box', title: item.n, sub: priceLabel(item), actions: medActions(item, intent) }));
    commands().filter(c => !qn || `${c.title} ${c.keys}`.toLowerCase().includes(qn)).forEach(c => list.push({ type: 'cmd', ...c }));
    Store.state.calcs.forEach((c, idx) => { if (!qn || normalizeText(c.name).includes(qn) || String(idx + 1) === qn) list.push({ type: 'order', cid: c.id, hue: c.hue, pos: idx + 1, icon: 'calc', title: c.name, sub: `${money(Store.totalP(c.lines))} EGP`, actions: calcActions(c.id) }); });
    return list;
  };

  const render = (q) => {
    items = build(q);
    active = items.length ? 0 : -1;
    paneFocused = false; paneIdx = 0;
    paint();
  };
  const refresh = () => {
    if (!isOpen()) return;
    const wp = paneFocused, wi = paneIdx, wa = active;
    items = build(E.input.value);
    active = Math.min(Math.max(wa, 0), items.length - 1);
    paneFocused = wp; paneIdx = wi;
    paint();
  };

  const paint = () => {
    E.panel.classList.toggle('pane-mode', paneFocused);
    if (!items.length) {
      E.list.innerHTML = '<div class="cmdk-empty">No matches</div>';
      E.pane.innerHTML = '<div class="cmdk-empty" style="margin:auto">Nothing selected</div>';
      return;
    }
    const labels = { med: 'Medicines', cmd: 'Commands', order: 'Calculations' };
    const seen = {};
    let html = '';
    items.forEach((it, i) => {
      if (!seen[it.type]) { html += `<div class="cmdk-group">${labels[it.type]}</div>`; seen[it.type] = 1; }
      html += `<div class="cmdk-item${i === active ? ' on' : ''}" role="option" aria-selected="${i === active}" data-pidx="${i}">${it.type === 'order' ? `<span class="num hue-${it.hue}">${it.pos}</span>` : icon(it.icon)}<span class="cmdk-title" dir="auto">${it.type === 'med' ? highlight(it.title, queryTokens(it.intent.query)) : esc(it.title)}</span><span class="cmdk-sub">${esc(it.sub || '')}</span>${it.actions.length > 1 ? icon('chev-right', 'sm') : ''}</div>`;
    });
    E.list.innerHTML = html;
    const on = E.list.querySelector('.cmdk-item.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
    paintPane();
  };

  const medPreview = (item) => {
    const qEl = $('paneQty'), sEl = $('paneSp');
    const q = qEl && qEl.value.trim() !== '' ? parseFloat(qEl.value) : quickQty();
    const sp = sEl ? parseFloat(sEl.value) : 0;
    const out = $('panePreview');
    if (!out) return;
    if (!(q > 0)) { out.textContent = 'Enter a quantity'; return; }
    if (item.isDynamic && isNaN(sp)) { out.textContent = 'Enter the supply price'; return; }
    const req = addMode() === 'pack' ? q * item.bQty : q;
    const { packs, spare, short } = Store.packsFor(item, req);
    out.innerHTML = `<b>${fmtNum(req)} ${esc(item.bType)} → ${esc(packWord(item, packs))} · ${money(costOf(item, packs, sp))} EGP</b>${spare > 0 ? ` · ${fmtNum(spare)} spare` : short > 0 ? ` · ${fmtNum(short)} short` : ''}`;
  };

  const paneAdd = (item, openAfter, intent, forced) => {
    const qEl = $('paneQty'), sEl = $('paneSp');
    const q = qEl && qEl.value.trim() !== '' ? parseFloat(qEl.value) : quickQty();
    const req = addMode() === 'pack' ? q * item.bQty : q;
    const sp = item.isDynamic ? (sEl && sEl.value.trim() !== '' ? parseFloat(sEl.value) : NaN) : 0;
    const dest = forced || (intent && intent.calc != null ? (Store.byPosition(intent.calc) || {}).id : undefined);
    if (intent && intent.calc != null && !dest) { Toast.show(`There is no calculation #${intent.calc}`, 'warn'); return; }
    const r = Store.add(item.id, req, sp, true, dest);
    if (!r.ok) {
      if (r.reason === 'needs-price') { paneFocused = true; paint(); const s = $('paneSp'); if (s) s.focus(); }
      failFeedback(r);
      return;
    }
    hide(true);
    addFeedback(r, item, { openTray: openAfter });
    if (!coarse()) els.in.focus({ preventScroll: true });
  };

  const paintPane = () => {
    const it = items[active];
    if (!it) { E.pane.innerHTML = ''; return; }
    let nav = 0;
    let fields = '';
    let head = `<div class="pane-head"><span class="row-icon"${it.type === 'med' ? ` data-engine="${esc(it.item.engineId)}"` : ''}>${icon(it.icon)}</span><div style="min-width:0"><div class="pane-title" dir="auto">${esc(it.title)}</div><div class="pane-sub">${esc(it.sub || '')}</div></div></div>`;
    if (it.type === 'order') {
      const o = Store.calc(it.cid);
      head = `<div class="pane-head"><span class="row-icon calc-ic hue-${it.hue}"><span class="num">${it.pos}</span></span><div style="min-width:0"><div class="pane-title" dir="auto">${esc(it.title)}</div><div class="pane-sub">${o ? `${plural(o.lines.size, 'item')} · ${money(Store.totalP(o.lines))} EGP${o.id === Store.state.active ? ' · current' : ''}` : ''}</div></div></div>`;
      fields = `<div class="pane-field"><label for="paneOrderName">Name</label><input type="text" id="paneOrderName" class="pane-input pnav" data-nav="${nav++}" value="${esc(o ? o.name : '')}" maxlength="60"></div>`;
    }
    if (it.type === 'med') {
      const item = it.item;
      const mem = Store.membership(item.id);
      head = `<div class="pane-head">${itemIcon(item)}<div style="min-width:0"><div class="pane-title" dir="auto">${esc(item.n)} ${tierTag(item)}</div><div class="pane-sub">${esc(item.u)} · ${esc(item.s)} · ${esc(priceLabel(item))}</div>${mem.length ? `<div class="pane-mem">${mem.map(x => `<span class="tag ok">${multi() ? `<span class="num hue-${x.calc.hue}">${x.pos}</span>` : ''}${esc(packWord(item, x.line.packs))}</span>`).join('')}</div>` : ''}</div></div>`;
      const q = it.intent.qty != null ? it.intent.qty : '';
      const p = it.intent.price != null ? it.intent.price : '';
      fields = `${item.isDynamic ? `<div class="pane-field"><label for="paneSp" style="color:var(--accent)">Supply price</label><input type="number" inputmode="decimal" id="paneSp" class="pane-input pnav" data-nav="${nav++}" value="${esc(String(p))}" placeholder="0" min="0" style="color:var(--accent)"></div>` : ''}
<div class="pane-field"><label for="paneQty">Quantity · ${addMode() === 'pack' ? 'packs' : esc(item.bType)}</label><input type="number" inputmode="decimal" id="paneQty" class="pane-input pnav" data-nav="${nav++}" value="${esc(String(q))}" placeholder="${esc(String(quickQty()))}" min="0"></div>
<div class="pane-preview" id="panePreview"></div>`;
    }
    E.pane.innerHTML = `${head}${fields}<div class="pane-actions">${it.actions.map((a, i) => `<div class="pane-action pnav${i === 0 ? ' first' : ''}" tabindex="0" role="button" data-nav="${nav + i}" data-aidx="${i}">${icon(a.icon)}<span class="grow">${esc(a.label)}</span>${a.active ? icon('check', 'chk') : ''}${a.shortcut ? `<kbd>${esc(a.shortcut)}</kbd>` : ''}</div>`).join('')}</div>`;
    if (it.type === 'med') medPreview(it.item);
    if (paneFocused) {
      const navs = Array.from(E.pane.querySelectorAll('.pnav'));
      const tgt = navs[Math.min(paneIdx, navs.length - 1)];
      if (tgt) tgt.focus({ preventScroll: true });
    }
  };

  const open = (preset) => {
    lastFocus = document.activeElement;
    Popover.close();
    E.root.classList.add('open');
    E.root.setAttribute('aria-hidden', 'false');
    const q = preset != null ? preset : lastQuery;
    E.input.value = q;
    render(q);
    FocusTrap.set(E.panel);
    E.input.focus({ preventScroll: true });
    setTimeout(() => { E.input.focus({ preventScroll: true }); E.input.select(); }, 40);
  };
  const hide = (silent) => {
    if (!isOpen()) return;
    E.root.classList.remove('open');
    E.root.setAttribute('aria-hidden', 'true');
    E.input.blur();
    FocusTrap.release();
    if (!silent && lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  };
  const toggle = () => isOpen() ? hide() : open();

  const exitPane = () => { paneFocused = false; paneIdx = 0; paint(); E.input.focus({ preventScroll: true }); };
  const enterPane = () => { const it = items[active]; if (it && (it.actions.length > 1 || it.type !== 'cmd')) { paneFocused = true; paneIdx = 0; paint(); return true; } return false; };
  const runDefault = (e) => {
    const it = items[active];
    if (!it) return;
    if (it.type === 'med' && e && (e.ctrlKey || e.metaKey)) { it.actions[1].run(); return; }
    it.actions[0].run();
  };

  const init = () => {
    Object.assign(E, { root: $('cmdk'), panel: $('cmdkPanel'), input: $('cmdkInput'), list: $('cmdkList'), pane: $('cmdkPane') });
    E.input.addEventListener('input', () => { lastQuery = E.input.value; render(lastQuery); });
    E.root.addEventListener('click', (e) => {
      if (e.target === E.root) { hide(); return; }
      const li = e.target.closest('.cmdk-item');
      if (li) {
        const i = parseInt(li.dataset.pidx, 10);
        active = i;
        if (coarse() || window.matchMedia('(max-width: 640px)').matches) { if (!enterPane()) { paneFocused = false; runDefault(); } }
        else { paneFocused = false; items[i].type === 'med' ? (paint(), $('paneQty') && $('paneQty').focus()) : runDefault(); }
        return;
      }
      const pa = e.target.closest('.pane-action');
      if (pa) { const it = items[active]; const a = it && it.actions[parseInt(pa.dataset.aidx, 10)]; if (a) { paneFocused = true; paneIdx = parseInt(pa.dataset.nav, 10); a.run(); } }
    });
    E.pane.addEventListener('input', (e) => { const it = items[active]; if (it && it.type === 'med' && (e.target.id === 'paneQty' || e.target.id === 'paneSp')) medPreview(it.item); });
    E.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { active = Math.min(active + 1, items.length - 1); paneFocused = false; paint(); } return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { active = Math.max(active - 1, 0); paneFocused = false; paint(); } return; }
      if (e.key === 'ArrowRight' || e.key === 'Tab') {
        const atEnd = E.input.selectionStart === E.input.value.length;
        if (e.key === 'ArrowRight' && !atEnd) return;
        if (e.key === 'Tab' && e.shiftKey) return;
        if (enterPane()) e.preventDefault();
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); runDefault(e); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (E.input.value) { E.input.value = ''; lastQuery = ''; render(''); } else hide(); }
    });
    E.pane.addEventListener('keydown', (e) => {
      const t = e.target.closest('.pnav');
      if (!t) return;
      const idx = parseInt(t.dataset.nav, 10);
      const navs = Array.from(E.pane.querySelectorAll('.pnav'));
      if (e.key === 'ArrowDown') { e.preventDefault(); paneIdx = Math.min(idx + 1, navs.length - 1); navs[paneIdx].focus({ preventScroll: true }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (idx === 0) { exitPane(); return; } paneIdx = idx - 1; navs[paneIdx].focus({ preventScroll: true }); return; }
      if (e.key === 'Escape' || (e.key === 'ArrowLeft' && t.tagName !== 'INPUT')) { e.preventDefault(); e.stopPropagation(); exitPane(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        paneIdx = idx;
        if (t.tagName === 'INPUT') { runDefault(e); return; }
        t.click();
      }
    });
  };

  return { init, open, hide, toggle, isOpen, refresh };
})();
