(function () {
  'use strict';
  const { h, api, toast, copy, fmtDate } = UI;

  const VERDICT = {
    cheat:      { label: '🚨 ЧИТ — хэш в базе',                 rank: 0, short: 'ЧИТ (хэш)' },
    danger:     { label: '⛔ Вероятный чит',                    rank: 1, short: 'Вероятный чит' },
    suspicious: { label: '⚠️ Подозрительный',                   rank: 2, short: 'Подозрительные' },
    restricted: { label: '🚫 Ограниченный мод',                 rank: 3, short: 'Ограниченные' },
    notice:     { label: '🔎 Проверить вручную',                rank: 4, short: 'Проверить вручную' },
    ok:         { label: '✔ Ничего не найдено (нет в Modrinth)', rank: 5, short: 'Не найдено' },
    clean:      { label: '✅ Чистый (Modrinth)',                 rank: 6, short: 'Чистые (Modrinth)' }
  };
  const SEV_RANK = { high: 3, medium: 2, low: 1 };
  const SEV_LABEL = { high: 'ВЫСОКАЯ', medium: 'СРЕДНЯЯ', low: 'НИЗКАЯ' };
  const MAX_CLASS = 8 * 1024 * 1024;
  const MAX_FILE = 250 * 1024 * 1024;
  const MAX_NESTED = 40 * 1024 * 1024;
  const tick = () => new Promise(r => setTimeout(r, 0));
  const latin1 = new TextDecoder('latin1');

  let last = { results: [], meta: null };
  let CFG = null;

  // ---------------- hashing / io ----------------
  async function sha1(buf) {
    const d = await crypto.subtle.digest('SHA-1', buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const fmtSize = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : (n / 1024).toFixed(1) + ' КБ');

  async function pool(items, limit, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k], k); }
    }));
  }

  // ---------------- Modrinth ----------------
  async function modrinthLookup(hashes) {
    const versions = {}, projects = {};
    const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
    for (const part of chunk(hashes, 200)) {
      const r = await fetch('https://api.modrinth.com/v2/version_files', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: part, algorithm: 'sha1' })
      });
      if (!r.ok) throw new Error('Modrinth ' + r.status);
      Object.assign(versions, await r.json());
    }
    const ids = [...new Set(Object.values(versions).map(v => v.project_id))];
    for (const part of chunk(ids, 100)) {
      const r = await fetch('https://api.modrinth.com/v2/projects?ids=' + encodeURIComponent(JSON.stringify(part)));
      if (r.ok) (await r.json()).forEach(p => { projects[p.id] = p; });
    }
    return { versions, projects };
  }

  // ---------------- metadata ----------------
  async function readText(zip, name, max = 512 * 1024) {
    const f = zip.file(name);
    if (!f) return null;
    try { const t = await f.async('string'); return t.length > max ? t.slice(0, max) : t; } catch { return null; }
  }
  function tryJson(t) {
    try { return JSON.parse(t); } catch { /* trailing commas etc. */ }
    try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
  }
  const firstStr = v => (Array.isArray(v) ? firstStr(v[0]) : (typeof v === 'string' ? v : ''));

  async function readMeta(zip) {
    const m = { loader: 'Unknown', id: '', name: '', version: '', mc: '' };
    let t;
    if ((t = await readText(zip, 'fabric.mod.json'))) {
      const j = tryJson(t) || {};
      Object.assign(m, { loader: 'Fabric', id: j.id || '', name: j.name || '', version: String(j.version || ''), mc: firstStr(j.depends && j.depends.minecraft) });
      if (j.environment === 'client') m.env = 'client';
    } else if ((t = await readText(zip, 'quilt.mod.json'))) {
      const j = (tryJson(t) || {}).quilt_loader || {};
      const mc = Array.isArray(j.depends) ? j.depends.find(d => d && d.id === 'minecraft') : null;
      Object.assign(m, { loader: 'Quilt', id: j.id || '', name: (j.metadata && j.metadata.name) || '', version: String(j.version || ''), mc: mc ? firstStr(mc.versions) : '' });
    } else if ((t = await readText(zip, 'META-INF/neoforge.mods.toml')) || (t = await readText(zip, 'META-INF/mods.toml'))) {
      const g = re => { const x = t.match(re); return x ? x[1] : ''; };
      const mc = t.match(/modId\s*=\s*"minecraft"[\s\S]{0,300}?versionRange\s*=\s*"([^"]+)"/) || t.match(/versionRange\s*=\s*"([^"]+)"[\s\S]{0,300}?modId\s*=\s*"minecraft"/);
      Object.assign(m, { loader: zip.file('META-INF/neoforge.mods.toml') ? 'NeoForge' : 'Forge', id: g(/modId\s*=\s*"([^"]+)"/), name: g(/displayName\s*=\s*"([^"]+)"/), version: g(/^\s*version\s*=\s*"([^"]+)"/m), mc: mc ? mc[1] : '' });
    } else if ((t = await readText(zip, 'mcmod.info'))) {
      const j = tryJson(t); const e = Array.isArray(j) ? j[0] : (j && j.modList ? j.modList[0] : j) || {};
      Object.assign(m, { loader: 'Forge (legacy)', id: e.modid || '', name: e.name || '', version: String(e.version || ''), mc: e.mcversion || '' });
    } else if ((t = await readText(zip, 'plugin.yml')) || (t = await readText(zip, 'paper-plugin.yml'))) {
      const g = re => { const x = t.match(re); return x ? x[1].trim().replace(/^['"]|['"]$/g, '') : ''; };
      Object.assign(m, { loader: 'Bukkit/Paper', name: g(/^name:\s*(.+)$/m), id: g(/^name:\s*(.+)$/m), version: g(/^version:\s*(.+)$/m), mc: g(/^api-version:\s*(.+)$/m) });
    } else if ((t = await readText(zip, 'addon.json')) && /namespace/.test(t)) {
      const j = tryJson(t) || {};
      Object.assign(m, { loader: 'LabyMod', id: j.namespace || '', name: j.displayName || j.name || '', version: String(j.version || '') });
    } else if (Object.keys(zip.files).some(f => f.toLowerCase().includes('labymod'))) m.loader = 'LabyMod?';
    return m;
  }

  // ---------------- rule engine ----------------
  function prepRules(rules) {
    return rules.filter(r => r.enabled !== false && r.terms && r.terms.length).map(r => ({
      ...r, _terms: r.caseSensitive ? r.terms : r.terms.map(t => t.toLowerCase())
    }));
  }
  function nameMatch(text, term) {
    if (term.length >= 6 || /[^a-z0-9]/.test(term)) return text.includes(term);
    return new RegExp('(^|[^a-z0-9])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(text);
  }

  // Собирает находки. acc: {findings:Map, jarState:Map}
  function addHit(acc, rule, evidence) {
    let f = acc.findings.get(rule.id);
    if (!f) { f = { ruleId: rule.id, rule: rule.name, severity: rule.severity, kind: rule.target, evidence: [] }; acc.findings.set(rule.id, f); }
    if (f.evidence.length < 6 && !f.evidence.includes(evidence)) f.evidence.push(evidence);
  }

  async function scanZip(zip, rules, acc, prefix, depth, opts, stats) {
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    const lowNames = names.map(n => n.toLowerCase());
    stats.entries += names.length;

    // path rules
    for (const r of rules.filter(x => x.target === 'path')) {
      const seen = new Set(); let firstEv = null;
      for (let i = 0; i < names.length; i++) {
        const hay = r.caseSensitive ? names[i] : lowNames[i];
        for (const t of r._terms) if (hay.includes(t)) { seen.add(t); firstEv = firstEv || names[i]; if (r.mode === 'any') addHit(acc, r, prefix + names[i]); }
      }
      if (r.mode === 'all' && seen.size === r._terms.length) addHit(acc, r, prefix + firstEv);
    }

    // class-name obfuscation heuristic
    const classes = names.filter(n => n.endsWith('.class') && !n.startsWith('META-INF/versions/'));
    stats.classes += classes.length;
    const tiny = classes.filter(n => { const s = n.slice(n.lastIndexOf('/') + 1, -6); return s.length <= 2; }).length;
    if (classes.length >= 15 && tiny / classes.length > 0.5) {
      stats.obf = Math.max(stats.obf || 0, Math.round((tiny / classes.length) * 100));
    }

    // content rules
    const crules = rules.filter(r => r.target === 'content');
    if (crules.length && opts.deep) {
      const textFiles = names.filter(n => /\.(mf|json|toml|properties|txt|yml|yaml|cfg|xml)$/i.test(n) && !n.startsWith('assets/') && !n.startsWith('data/'));
      const targets = [...classes, ...names.filter(n => n.endsWith('.class') && n.startsWith('META-INF/versions/')), ...textFiles];
      let n = 0;
      for (const path of targets) {
        const entry = zip.files[path];
        const size = entry._data && entry._data.uncompressedSize;
        if (size && size > (path.endsWith('.class') ? MAX_CLASS : 262144)) continue;
        let text;
        try { text = latin1.decode(await entry.async('uint8array')); } catch { continue; }
        stats.scanned++;
        let lower = null;
        for (const r of crules) {
          let hay = text;
          if (!r.caseSensitive) hay = lower || (lower = text.toLowerCase());
          const found = [];
          for (const t of r._terms) if (hay.includes(t)) found.push(t);
          if (!found.length) continue;
          if (r.mode === 'any') addHit(acc, r, `${prefix}${path}  ⟶  ${found[0]}`);
          else if (r.scope === 'class') { if (found.length === r._terms.length) addHit(acc, r, `${prefix}${path}`); }
          else {
            const st = acc.jar.get(r.id) || { seen: new Set(), ev: [] };
            found.forEach(t => { if (!st.seen.has(t)) { st.seen.add(t); st.ev.push(`${prefix}${path} ⟶ ${t}`); } });
            acc.jar.set(r.id, st);
          }
        }
        if (++n % 40 === 0) await tick();
      }
    }

    // nested jars (Jar-in-Jar)
    if (opts.deep && opts.nested && depth < 1) {
      for (const n of names.filter(x => x.toLowerCase().endsWith('.jar'))) {
        const size = zip.files[n]._data && zip.files[n]._data.uncompressedSize;
        if (size && size > MAX_NESTED) continue;
        try {
          const inner = await JSZip.loadAsync(await zip.files[n].async('uint8array'));
          stats.nested++;
          await scanZip(inner, rules, acc, prefix + n + '!/', depth + 1, opts, stats);
        } catch { /* вложенный файл не zip */ }
      }
    }
  }

  function finishJarRules(rules, acc) {
    for (const r of rules.filter(x => x.target === 'content' && x.mode === 'all' && x.scope === 'jar')) {
      const st = acc.jar.get(r.id);
      if (st && st.seen.size === r._terms.length) st.ev.slice(0, 6).forEach(e => addHit(acc, r, e));
    }
  }

  // ---------------- analyze one file ----------------
  async function analyzeFile(file, hash, ctx) {
    const { cfg, rules, mr, opts } = ctx;
    const res = { name: file.webkitRelativePath || file.name, size: file.size, hash, lastModified: file.lastModified, findings: [], meta: null, modrinth: null, verdict: 'ok', note: '' };
    const label = cfg.hashes[hash];
    const ver = mr && mr.versions[hash];
    if (ver) {
      const p = mr.projects[ver.project_id];
      res.modrinth = { title: p ? p.title : ver.name, slug: p ? p.slug : ver.project_id, version: ver.version_number, id: ver.project_id };
    }
    if (hash in cfg.hashes) {
      res.verdict = 'cheat'; res.note = label ? 'Известный чит: ' + label : 'Хэш найден в базе читов';
      res.findings.push({ rule: 'Хэш найден в базе читов' + (label ? ' (' + label + ')' : ''), severity: 'high', kind: 'hash', evidence: [hash] });
      try { const z = await JSZip.loadAsync(await file.arrayBuffer()); res.meta = await readMeta(z); } catch { /* ignore */ }
      return res;
    }
    if (file.size > MAX_FILE) {
      res.findings.push({ rule: 'Файл слишком большой для разбора в браузере', severity: 'low', kind: 'info', evidence: [fmtSize(file.size)] });
      res.verdict = 'notice'; return res;
    }
    let zip;
    try { zip = await JSZip.loadAsync(await file.arrayBuffer()); }
    catch (e) {
      res.findings.push({ rule: 'Не удалось открыть как JAR/ZIP (повреждён, зашифрован или не jar)', severity: 'medium', kind: 'info', evidence: [String(e.message || e).slice(0, 120)] });
      res.verdict = 'suspicious'; return res;
    }
    res.meta = await readMeta(zip);
    const verified = !!res.modrinth;

    const acc = { findings: new Map(), jar: new Map() };
    const stats = { entries: 0, classes: 0, scanned: 0, nested: 0 };

    // name rules
    const nameText = [file.name, res.meta.id, res.meta.name, res.modrinth && res.modrinth.title, res.modrinth && res.modrinth.slug].filter(Boolean).join(' | ').toLowerCase();
    for (const r of rules.filter(x => x.target === 'name')) {
      const hit = r._terms.filter(t => nameMatch(nameText, t.toLowerCase()));
      if (r.mode === 'any' ? hit.length : hit.length === r._terms.length) addHit(acc, r, 'совпало: ' + hit.slice(0, 3).join(', '));
    }

    // deep scan (проверенные в Modrinth файлы пропускаем, если не включено «глубоко проверять всё»)
    if (!verified || opts.deepVerified) await scanZip(zip, rules, acc, '', 0, { deep: opts.deep, nested: opts.nested }, stats);
    finishJarRules(rules, acc);

    res.findings = [...acc.findings.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
    res.stats = stats;

    // эвристики
    if (!verified) {
      if (stats.obf) res.findings.push({ rule: `Обфусцированные имена классов (${stats.obf}% — a, b, ab…)`, severity: 'low', kind: 'heuristic', evidence: [] });
      if (res.meta.loader === 'Unknown' && stats.classes > 0) res.findings.push({ rule: 'Нет метаданных мода (fabric.mod.json / mods.toml / plugin.yml)', severity: 'low', kind: 'heuristic', evidence: [] });
      if (stats.classes === 0 && !res.findings.length) res.findings.push({ rule: 'В архиве нет .class файлов — это не мод', severity: 'low', kind: 'heuristic', evidence: [] });
    }

    // итоговый вердикт
    const top = res.findings.reduce((m, f) => Math.max(m, SEV_RANK[f.severity]), 0);
    const onlyName = res.findings.length && res.findings.every(f => f.kind === 'name');
    if (top === 3) res.verdict = 'danger';
    else if (verified && onlyName) res.verdict = 'restricted';
    else if (top === 2) res.verdict = onlyName ? 'restricted' : 'suspicious';
    else if (top === 1) res.verdict = onlyName ? 'restricted' : 'notice';
    else res.verdict = verified ? 'clean' : 'ok';
    return res;
  }

  // ---------------- run ----------------
  async function run(files, ui) {
    const opts = { modrinth: ui.opt.modrinth.checked, deep: ui.opt.deep.checked, nested: ui.opt.nested.checked, deepVerified: ui.opt.deepVerified.checked };
    const rules = prepRules(CFG.rules);
    ui.setBusy(true); ui.warn.textContent = '';
    const hashes = [];
    // 1. hash
    await pool(files, 3, async (f, i) => {
      hashes[i] = await sha1(await f.arrayBuffer());
      ui.progress((i + 1) / files.length * 30, `Хэширование ${i + 1}/${files.length}`);
    });
    // 2. modrinth
    let mr = null;
    if (opts.modrinth) {
      ui.progress(32, 'Запрос к Modrinth…');
      try { mr = await modrinthLookup([...new Set(hashes)]); }
      catch (e) { ui.warn.textContent = 'Modrinth недоступен (' + e.message + ') — проверка по Modrinth пропущена, остальное работает.'; }
    }
    // 3. analyze
    const results = []; let done = 0;
    await pool(files, 2, async (f, i) => {
      try { results[i] = await analyzeFile(f, hashes[i], { cfg: CFG, rules, mr, opts }); }
      catch (e) { results[i] = { name: f.name, size: f.size, hash: hashes[i], findings: [{ rule: 'Ошибка анализа: ' + e.message, severity: 'medium', kind: 'info', evidence: [] }], verdict: 'suspicious' }; }
      done++; ui.progress(35 + done / files.length * 65, `Анализ ${done}/${files.length}: ${f.name}`);
      await tick();
    });
    // дубликаты по хэшу
    const seen = {};
    results.forEach(r => { (seen[r.hash] = seen[r.hash] || []).push(r); });
    Object.values(seen).forEach(a => { if (a.length > 1) a.forEach(r => { r.duplicates = a.length; }); });
    last = { results, meta: { at: new Date().toISOString(), modrinth: !!mr, total: files.length } };
    ui.progress(100, 'Готово');
    ui.setBusy(false);
    ui.show();
  }

  // ---------------- reports ----------------
  function reportText(user) {
    const { results, meta } = last;
    const by = {}; results.forEach(r => { by[r.verdict] = (by[r.verdict] || 0) + 1; });
    const lines = [`Проверка модов — ${fmtDate(meta.at, true)}`, `Проверяющий: ${user}`, `Файлов: ${results.length}  (Modrinth: ${meta.modrinth ? 'да' : 'нет'})`, ''];
    Object.keys(VERDICT).forEach(k => { if (by[k]) lines.push(`${VERDICT[k].short}: ${by[k]}`); });
    lines.push('');
    results.slice().sort(cmp).filter(r => r.verdict !== 'clean' && r.verdict !== 'ok').forEach(r => {
      lines.push(`[${VERDICT[r.verdict].short}] ${r.name}  (${fmtSize(r.size)})`, `   SHA-1: ${r.hash}`);
      if (r.note) lines.push('   ' + r.note);
      r.findings.forEach(f => { lines.push(`   - [${SEV_LABEL[f.severity]}] ${f.rule}`); f.evidence.slice(0, 3).forEach(e => lines.push('       ' + e)); });
    });
    return lines.join('\n');
  }
  const cmp = (a, b) => VERDICT[a.verdict].rank - VERDICT[b.verdict].rank || a.name.localeCompare(b.name);
  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

  // ---------------- UI ----------------
  async function collectDropped(items) {
    const out = [];
    const walk = async entry => {
      if (entry.isFile) { const f = await new Promise(r => entry.file(r, () => r(null))); if (f) out.push(f); }
      else if (entry.isDirectory) {
        const rd = entry.createReader();
        for (;;) { const batch = await new Promise(r => rd.readEntries(r, () => r([]))); if (!batch.length) break; for (const e of batch) await walk(e); }
      }
    };
    const entries = [...items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    for (const e of entries) await walk(e);
    return out;
  }

  async function mount(view, S) {
    view.append(h('h1', {}, 'Проверка модов'), h('p', { class: 'sub' }, 'Файлы не загружаются на сервер — анализ происходит в вашем браузере. Наружу уходят только SHA-1 хэши (в Modrinth).'));
    const loading = h('div', { class: 'empty' }, 'Загрузка правил…');
    view.append(loading);
    try { CFG = await api('GET', '/api/checker/data'); } catch (e) { loading.textContent = e.message; return; }
    loading.remove();

    const opt = {
      modrinth: h('input', { type: 'checkbox', checked: true }),
      deep: h('input', { type: 'checkbox', checked: true }),
      nested: h('input', { type: 'checkbox', checked: true }),
      deepVerified: h('input', { type: 'checkbox' })
    };
    const picker = h('input', { type: 'file', multiple: true, accept: '.jar,.zip,.disabled', hidden: true });
    const folder = h('input', { type: 'file', webkitdirectory: true, hidden: true });
    const bar = h('div'); const barText = h('div', { class: 'muted', style: 'text-align:center;font-size:13px' });
    const prog = h('div', { hidden: true }, h('div', { class: 'progress' }, bar), barText);
    const warn = h('div', { class: 'err-text' });
    const out = h('div');
    const drop = h('div', { class: 'drop' }, h('div', { class: 'big' }, 'Перетащите сюда .jar файлы или папку mods'),
      h('p', {}, 'или'), h('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap' },
        h('button', { class: 'btn primary', onclick: e => { e.stopPropagation(); picker.click(); } }, 'Выбрать файлы'),
        h('button', { class: 'btn', onclick: e => { e.stopPropagation(); folder.click(); } }, 'Выбрать папку')),
      h('p', { style: 'font-size:12.5px' }, `База: ${Object.keys(CFG.hashes).length} хэшей читов · ${CFG.rules.length} правил`));

    const ui = {
      opt, warn,
      setBusy: b => { prog.hidden = !b && barText.textContent !== 'Готово'; drop.style.opacity = b ? .5 : 1; drop.style.pointerEvents = b ? 'none' : ''; },
      progress: (p, t) => { prog.hidden = false; bar.style.width = p + '%'; barText.textContent = t; },
      show: () => renderResults(out, S.me.username)
    };
    const start = files => {
      const jars = files.filter(f => /\.(jar|zip|disabled)$/i.test(f.name));
      if (!jars.length) return toast('Не найдено .jar файлов', true);
      out.replaceChildren(); run(jars, ui).catch(e => { ui.setBusy(false); toast(e.message, true); });
    };
    picker.addEventListener('change', () => { start([...picker.files]); picker.value = ''; });
    folder.addEventListener('change', () => { start([...folder.files]); folder.value = ''; });
    drop.addEventListener('click', () => picker.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async e => { e.preventDefault(); drop.classList.remove('over'); start(await collectDropped(e.dataTransfer.items)); });

    const optRow = h('div', { class: 'opts' },
      h('label', {}, opt.modrinth, 'Сверять с Modrinth'), h('label', {}, opt.deep, 'Глубокий анализ кода'),
      h('label', {}, opt.nested, 'Вложенные jar (Jar-in-Jar)'), h('label', {}, opt.deepVerified, 'Глубоко проверять и файлы из Modrinth'));
    view.append(drop, picker, folder, optRow, prog, warn, out);
    if (last.results.length) renderResults(out, S.me.username);
  }

  function renderResults(out, user) {
    const { results } = last;
    const hidden = new Set(['clean']);
    const q = h('input', { type: 'search', class: 'search', placeholder: 'Фильтр по имени / хэшу / находке…' });
    const list = h('div'); const chipsBox = h('div', { class: 'chips' });
    const counts = {}; results.forEach(r => { counts[r.verdict] = (counts[r.verdict] || 0) + 1; });
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const rows = results.slice().sort(cmp).filter(r => !hidden.has(r.verdict) && (!t || (r.name + r.hash + r.findings.map(f => f.rule).join(' ')).toLowerCase().includes(t)));
      list.replaceChildren(...rows.map(card), rows.length ? '' : h('div', { class: 'empty' }, 'Нет файлов по текущему фильтру'));
    };
    Object.keys(VERDICT).filter(k => counts[k]).forEach(k => {
      const cb = h('input', { type: 'checkbox', checked: !hidden.has(k), onchange: () => { cb.checked ? hidden.delete(k) : hidden.add(k); draw(); } });
      chipsBox.append(h('label', { class: 'chip' }, cb, `${VERDICT[k].short}: ${counts[k]}`));
    });
    const bad = results.filter(r => ['cheat', 'danger', 'suspicious'].includes(r.verdict)).length;
    out.replaceChildren(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, results.length), h('span', {}, 'файлов проверено')),
        h('div', { class: 'stat' }, h('b', { style: bad ? 'color:#ff6b6b' : 'color:var(--green)' }, bad), h('span', {}, 'читы / подозрительные')),
        h('div', { class: 'stat' }, h('b', {}, results.filter(r => r.modrinth).length), h('span', {}, 'найдено в Modrinth'))),
      h('div', { class: 'toolbar' }, q,
        h('button', { class: 'btn gold', onclick: () => copy(reportText(user)) }, 'Копировать отчёт'),
        h('button', { class: 'btn', onclick: () => download('mods-report.txt', reportText(user), 'text/plain') }, '.txt'),
        h('button', { class: 'btn', onclick: () => download('mods-report.json', JSON.stringify({ checkedBy: user, ...last.meta, results: results.map(r => ({ ...r })) }, null, 1), 'application/json') }, '.json'),
        h('button', { class: 'btn', onclick: () => download('mods-report.csv', '﻿' + ['file,size,sha1,verdict,loader,mod,mc,modrinth,findings'].concat(results.slice().sort(cmp).map(r => [r.name, r.size, r.hash, r.verdict, r.meta && r.meta.loader, r.meta && (r.meta.name || r.meta.id), r.meta && r.meta.mc, r.modrinth && r.modrinth.title, r.findings.map(f => f.rule).join('; ')].map(csvCell).join(','))).join('\n'), 'text/csv') }, '.csv')),
      chipsBox, h('div', { style: 'height:6px' }), list);
    q.addEventListener('input', draw);
    draw();
  }

  function card(r) {
    const m = r.meta;
    const sevOrder = r.findings;
    const body = [];
    const more = sevOrder.length > 5;
    const items = sevOrder.map((f, i) => h('div', { class: 'finding', hidden: more && i >= 5 },
      h('span', { class: 'sev ' + f.severity }, SEV_LABEL[f.severity]), f.rule,
      f.evidence.length ? f.evidence.slice(0, 4).map(e => h('code', {}, e)) : null));
    body.push(items);
    if (more) { const b = h('button', { class: 'btn sm', style: 'margin-top:8px', onclick: () => { items.forEach(x => x.hidden = false); b.remove(); } }, `Показать все (${sevOrder.length})`); body.push(b); }
    return h('div', { class: 'res ' + r.verdict },
      h('div', { class: 'res-head' }, h('div', { class: 'res-name' }, r.name), h('div', { style: 'font-weight:600' }, VERDICT[r.verdict].label)),
      h('div', { class: 'res-meta' },
        h('span', {}, fmtSize(r.size)),
        m ? [h('span', {}, 'Loader: ' + m.loader), m.name || m.id ? h('span', {}, 'Мод: ' + (m.name || m.id) + (m.version ? ' ' + m.version : '')) : null, m.mc ? h('span', {}, 'MC: ' + m.mc) : null] : null,
        r.modrinth ? h('span', {}, 'Modrinth: ', h('a', { href: 'https://modrinth.com/project/' + encodeURIComponent(r.modrinth.slug), target: '_blank', rel: 'noopener noreferrer' }, r.modrinth.title + ' ' + r.modrinth.version)) : null,
        r.lastModified ? h('span', {}, 'Изменён: ' + fmtDate(new Date(r.lastModified).toISOString(), true)) : null,
        r.duplicates ? h('span', { class: 'pill warn' }, 'дубликат ×' + r.duplicates) : null),
      h('div', { class: 'res-meta' }, h('span', { class: 'hash', title: 'Копировать', onclick: () => copy(r.hash) }, 'SHA-1: ' + r.hash)),
      r.note ? h('div', { class: 'finding' }, r.note) : null, body);
  }

  window.Checker = { mount };
})();
