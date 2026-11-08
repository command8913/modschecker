(function () {
  'use strict';
  const { h, api, toast, copy, modal, confirm, fmtDate } = UI;
  const TABS = [['users', 'Пользователи'], ['content', 'Разделы и записи'], ['hashes', 'Хэши читов'], ['rules', 'Правила чекера'], ['audit', 'Журнал'], ['backup', 'Бэкап / настройки']];
  const state = { tab: 'users', section: null };
  let ctx, S, body;

  const SEV = { high: ['Высокая', 'bad'], medium: ['Средняя', 'warn'], low: ['Низкая', 'info'] };
  const STATUS = { active: ['Активен', 'ok'], pending: ['Ожидает', 'warn'], blocked: ['Заблокирован', 'bad'] };
  const toDateInput = iso => (iso ? new Date(iso).toLocaleDateString('sv-SE') : '');
  const fromDateInput = v => (v ? new Date(v + 'T23:59:59').toISOString() : null);

  function mount(view, appState, c) {
    S = appState; ctx = c;
    body = h('div');
    const tabs = h('div', { class: 'subtabs' }, TABS.map(([id, label]) =>
      h('button', { class: 'btn' + (state.tab === id ? ' active' : ''), onclick: () => { state.tab = id; ctx.refresh(); } }, label,
        id === 'users' && S.pending ? h('span', { class: 'badge' }, S.pending) : null)));
    view.append(h('h1', {}, 'Админ-панель'), h('p', { class: 'sub' }, 'Доступы, списки, хэши и правила проверки модов'), tabs, body);
    ({ users, content, hashes, rules, audit, backup })[state.tab]().catch(e => body.replaceChildren(h('div', { class: 'empty' }, e.message)));
  }

  const act = async (fn, okText) => { try { await fn(); if (okText) toast(okText); await ctx.refresh(); } catch (e) { toast(e.message, true); } };

  // ================= USERS =================
  async function users() {
    const { users: list, settings } = await api('GET', '/api/admin/users');
    const sectionOpts = () => [{ value: '*', label: 'Все разделы (в т.ч. будущие)' }, { value: 'checker', label: 'Проверка модов' }, ...S.content.sections.map(s => ({ value: s.id, label: s.title }))];
    const secName = id => (id === 'checker' ? 'Проверка модов' : (S.content.sections.find(s => s.id === id) || { title: id }).title);

    const accessModal = (u, title, submit, extraStatus) => modal({
      title, subtitle: u.username, submit,
      fields: [
        { name: 'role', label: 'Роль', type: 'select', value: u.role, options: [{ value: 'user', label: 'Пользователь' }, { value: 'admin', label: 'Администратор' }] },
        { name: 'sections', label: 'Доступ к разделам', type: 'checks', value: u.sections, options: sectionOpts(), exclusive: '*' },
        { name: 'expires', label: 'Доступ действует до', type: 'date', value: toDateInput(u.expiresAt), hint: 'Пусто — бессрочно. После этой даты вход закрывается автоматически.' },
        { name: 'note', label: 'Заметка', value: u.note }
      ],
      onSubmit: v => api('PATCH', '/api/admin/users/' + u.id, { role: v.role, sections: v.sections, expiresAt: fromDateInput(v.expires), note: v.note, ...(extraStatus ? { status: extraStatus } : {}) })
    });

    const rows = list.map(u => {
      const [stText, stCls] = STATUS[u.status];
      const expired = u.expiresAt && new Date(u.expiresAt) < new Date() && u.role !== 'admin';
      const me = u.id === S.me.id;
      const btns = [];
      if (u.status === 'pending') {
        btns.push(h('button', { class: 'btn sm primary', onclick: async () => { await accessModal(u, 'Одобрить заявку', 'Выдать доступ', 'active'); await ctx.refresh(); } }, 'Одобрить'));
      } else {
        btns.push(h('button', { class: 'btn sm', onclick: async () => { await accessModal(u, 'Права и доступ', 'Сохранить'); await ctx.refresh(); } }, 'Права'));
        if (!me) btns.push(u.status === 'blocked'
          ? h('button', { class: 'btn sm', onclick: () => act(() => api('PATCH', '/api/admin/users/' + u.id, { status: 'active' }), 'Разблокирован') }, 'Разблокировать')
          : h('button', { class: 'btn sm danger', onclick: () => act(() => api('PATCH', '/api/admin/users/' + u.id, { status: 'blocked' }), 'Доступ отозван') }, 'Забрать доступ'));
      }
      btns.push(h('button', { class: 'btn sm', onclick: async () => {
        await modal({ title: 'Сброс пароля', subtitle: u.username + ' — при входе придётся сменить пароль. Все сессии пользователя закроются.', submit: 'Сбросить', fields: [{ name: 'p', label: 'Временный пароль (минимум 8 символов)', type: 'text', value: Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 8).toUpperCase() + '7' }], onSubmit: v => api('PATCH', '/api/admin/users/' + u.id, { password: v.p }).then(() => { copy(v.p); }) });
      } }, 'Пароль'));
      if (!me) btns.push(h('button', { class: 'btn sm danger', onclick: async () => { if (await confirm('Удалить пользователя?', u.username)) act(() => api('DELETE', '/api/admin/users/' + u.id), 'Удалён'); } }, u.status === 'pending' ? 'Отклонить' : '✕'));
      return h('tr', {},
        h('td', {}, h('b', {}, u.username), me ? h('span', { class: 'muted' }, ' (вы)') : null, u.note ? h('div', { class: 'muted', style: 'font-size:12px' }, u.note) : null),
        h('td', {}, u.role === 'admin' ? 'Админ' : 'Пользователь'),
        h('td', {}, h('span', { class: 'pill ' + stCls }, stText)),
        h('td', {}, u.role === 'admin' || u.sections.includes('*') ? 'Все' : (u.sections.length ? u.sections.map(secName).join(', ') : h('span', { class: 'muted' }, 'нет'))),
        h('td', {}, u.role === 'admin' ? '—' : h('span', { class: expired ? 'pill bad' : '' }, u.expiresAt ? fmtDate(u.expiresAt) + (expired ? ' (истёк)' : '') : 'бессрочно')),
        h('td', {}, fmtDate(u.lastLogin, true)),
        h('td', {}, h('div', { class: 'actions' }, btns)));
    });

    const reg = h('select', { onchange: e => act(() => api('PATCH', '/api/admin/settings', { registration: e.target.value }), 'Сохранено'), style: 'width:auto' },
      h('option', { value: 'open', selected: settings.registration === 'open' }, 'Заявки на регистрацию: открыты'),
      h('option', { value: 'closed', selected: settings.registration === 'closed' }, 'Заявки на регистрацию: закрыты'));

    body.replaceChildren(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', onclick: async () => {
          await modal({ title: 'Новый пользователь', submit: 'Создать', fields: [
            { name: 'username', label: 'Логин' },
            { name: 'password', label: 'Временный пароль (минимум 8 символов)', value: Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 8).toUpperCase() + '7' },
            { name: 'role', label: 'Роль', type: 'select', value: 'user', options: [{ value: 'user', label: 'Пользователь' }, { value: 'admin', label: 'Администратор' }] },
            { name: 'sections', label: 'Доступ к разделам', type: 'checks', value: ['*'], options: sectionOpts(), exclusive: '*' },
            { name: 'expires', label: 'Доступ действует до', type: 'date', hint: 'Пусто — бессрочно.' },
            { name: 'note', label: 'Заметка' }
          ], onSubmit: async v => { await api('POST', '/api/admin/users', { username: v.username, password: v.password, role: v.role, sections: v.sections, expiresAt: fromDateInput(v.expires), note: v.note }); copy(v.password); toast('Создан. Пароль скопирован.'); } });
          await ctx.refresh();
        } }, '＋ Пользователь'),
        h('span', { class: 'grow' }), reg),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Пользователь', 'Роль', 'Статус', 'Разделы', 'Срок', 'Последний вход', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, rows))));
  }

  // ================= CONTENT =================
  async function content() {
    const { sections } = await api('GET', '/api/admin/sections');
    if (!state.section || !sections.some(s => s.id === state.section)) state.section = sections[0] && sections[0].id;
    const sec = sections.find(s => s.id === state.section);
    const full = S.content.sections.find(s => s.id === state.section);
    const entries = full ? full.entries : [];

    const secModal = (s) => modal({
      title: s ? 'Раздел' : 'Новый раздел', submit: 'Сохранить',
      fields: [
        { name: 'title', label: 'Название', value: s ? s.title : '' },
        { name: 'type', label: 'Тип записей', type: 'select', value: s ? s.type : 'command', options: [{ value: 'command', label: 'Команды / текст' }, { value: 'link', label: 'Ссылки (кнопка «Открыть»)' }] }
      ],
      onSubmit: async v => { const r = s ? await api('PATCH', '/api/admin/sections/' + s.id, v) : await api('POST', '/api/admin/sections', v); if (!s) state.section = r.section.id; }
    });
    const moveSec = (i, d) => { const ids = sections.map(s => s.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; act(() => api('POST', '/api/admin/sections/reorder', { ids })); };
    const moveEntry = (i, d) => { const ids = entries.map(e => e.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; act(() => api('POST', '/api/admin/entries/reorder', { ids })); };

    const entryModal = (e) => modal({
      title: e ? 'Редактировать запись' : 'Новая запись', wide: true, submit: 'Сохранить',
      fields: [
        { name: 'name', label: 'Название', value: e ? e.name : '' },
        { name: 'content', label: 'Содержимое (команда / ссылка / поисковый запрос)', type: 'textarea', rows: 8, value: e ? e.content : '' },
        { name: 'description', label: 'Описание (необязательно)', value: e ? e.description : '' },
        { name: 'sectionId', label: 'Раздел', type: 'select', value: e ? e.sectionId : state.section, options: sections.map(s => ({ value: s.id, label: s.title })) }
      ],
      onSubmit: v => (e ? api('PATCH', '/api/admin/entries/' + e.id, v) : api('POST', '/api/admin/entries', v))
    });

    const secList = h('div', {}, sections.map((s, i) => h('div', { class: 'nav-btn' + (s.id === state.section ? ' active' : ''), style: 'height:auto;padding:8px 12px;cursor:pointer', onclick: () => { state.section = s.id; ctx.refresh(); } },
      h('span', {}, s.title, h('span', { class: 'muted' }, ' · ' + s.count)),
      h('span', { class: 'actions' },
        h('button', { class: 'btn sm', title: 'Выше', onclick: ev => { ev.stopPropagation(); moveSec(i, -1); } }, '↑'),
        h('button', { class: 'btn sm', title: 'Ниже', onclick: ev => { ev.stopPropagation(); moveSec(i, 1); } }, '↓')))));

    const right = sec ? [
      h('div', { class: 'toolbar', style: 'margin-top:0' },
        h('h2', { style: 'margin:0' }, sec.title),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: async () => { await secModal(sec); await ctx.refresh(); } }, 'Переименовать'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirm('Удалить раздел?', `«${sec.title}» и все ${sec.count} записей будут удалены.`)) act(() => api('DELETE', '/api/admin/sections/' + sec.id), 'Раздел удалён'); } }, 'Удалить раздел'),
        h('button', { class: 'btn primary', onclick: async () => { await entryModal(null); await ctx.refresh(); } }, '＋ Запись')),
      entries.length ? entries.map((e, i) => h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, e.name),
          h('div', { class: 'actions' },
            h('button', { class: 'btn sm', onclick: () => moveEntry(i, -1) }, '↑'), h('button', { class: 'btn sm', onclick: () => moveEntry(i, 1) }, '↓'),
            h('button', { class: 'btn sm', onclick: async () => { await entryModal(e); await ctx.refresh(); } }, 'Изменить'),
            h('button', { class: 'btn sm danger', onclick: async () => { if (await confirm('Удалить запись?', e.name)) act(() => api('DELETE', '/api/admin/entries/' + e.id), 'Удалено'); } }, '✕'))),
        h('pre', { class: 'collapsed' }, e.content))) : h('div', { class: 'empty' }, 'В разделе пока нет записей')
    ] : [h('div', { class: 'empty' }, 'Создайте первый раздел')];

    body.replaceChildren(h('div', { style: 'display:grid;grid-template-columns:minmax(200px,260px) 1fr;gap:20px;align-items:start' },
      h('div', {}, h('button', { class: 'btn primary wide', style: 'margin:0 0 12px', onclick: async () => { await secModal(null); await ctx.refresh(); } }, '＋ Раздел'), secList,
        h('p', { class: 'muted', style: 'font-size:12.5px' }, 'Раздел «Проверка модов» встроенный; доступ к нему выдаётся в правах пользователя.')),
      h('div', {}, right)));
  }

  // ================= HASHES =================
  async function hashes() {
    const { hashes: list } = await api('GET', '/api/admin/hashes');
    const q = h('input', { type: 'search', class: 'search', placeholder: 'Поиск по хэшу или метке…' });
    const tbody = h('tbody');
    const count = h('span', { class: 'muted' });
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const rows = list.filter(x => !t || x.hash.includes(t) || (x.label || '').toLowerCase().includes(t)).slice().reverse();
      count.textContent = rows.length + ' из ' + list.length;
      tbody.replaceChildren(...rows.slice(0, 500).map(x => h('tr', {},
        h('td', { class: 'mono' }, x.hash), h('td', {}, x.label || h('span', { class: 'muted' }, '—')),
        h('td', {}, x.addedBy + ' · ' + fmtDate(x.addedAt)),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn sm', onclick: () => copy(x.hash) }, 'copy'),
          h('button', { class: 'btn sm', onclick: async () => { await modal({ title: 'Метка хэша', subtitle: x.hash, fields: [{ name: 'label', label: 'Название чита / метка', value: x.label }], onSubmit: v => api('PATCH', '/api/admin/hashes/' + x.hash, v) }); await ctx.refresh(); } }, 'Метка'),
          h('button', { class: 'btn sm danger', onclick: () => act(() => api('DELETE', '/api/admin/hashes/' + x.hash), 'Удалён') }, '✕'))))));
      if (rows.length > 500) tbody.append(h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Показаны первые 500 — уточните поиск.')));
    };
    q.addEventListener('input', draw); draw();
    body.replaceChildren(
      h('p', { class: 'sub' }, 'SHA-1 известных читов. Совпадение файла с этим списком = «ЧИТ» в чекере. Вставьте любой текст со списком хэшей — разберутся автоматически.'),
      h('div', { class: 'toolbar' }, q, count, h('button', { class: 'btn primary', onclick: async () => {
        await modal({ title: 'Добавить хэши', subtitle: 'Можно вставить много сразу (по одному в строке или любым текстом).', submit: 'Добавить', fields: [
          { name: 'text', label: 'SHA-1 (40 hex-символов)', type: 'textarea', rows: 7 }, { name: 'label', label: 'Метка для всех (например, название чита)' }
        ], onSubmit: async v => { const r = await api('POST', '/api/admin/hashes', v); toast(`Добавлено: ${r.added}, дубликатов: ${r.skipped}`); } });
        await ctx.refresh();
      } }, '＋ Добавить')),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['SHA-1', 'Метка', 'Добавил', ''].map(t => h('th', {}, t)))), tbody)));
  }

  // ================= RULES =================
  async function rules() {
    const { rules: list } = await api('GET', '/api/admin/rules');
    const TARGET = { content: 'строки в .class', path: 'пути файлов в jar', name: 'имя файла / мода' };
    const ruleModal = r => modal({
      title: r ? 'Правило' : 'Новое правило', wide: true, submit: 'Сохранить',
      fields: [
        { name: 'name', label: 'Название', value: r ? r.name : '' },
        { name: 'severity', label: 'Серьёзность', type: 'select', value: r ? r.severity : 'medium', options: [{ value: 'high', label: 'Высокая — «Вероятный чит»' }, { value: 'medium', label: 'Средняя — «Подозрительно»' }, { value: 'low', label: 'Низкая — «Проверить вручную»' }] },
        { name: 'target', label: 'Где искать', type: 'select', value: r ? r.target : 'content', options: Object.entries(TARGET).map(([value, label]) => ({ value, label })) },
        { name: 'mode', label: 'Условие', type: 'select', value: r ? r.mode : 'any', options: [{ value: 'any', label: 'Любая из строк' }, { value: 'all', label: 'Все строки вместе' }] },
        { name: 'scope', label: 'Для режима «все вместе»', type: 'select', value: r ? r.scope : 'class', options: [{ value: 'class', label: 'в одном классе' }, { value: 'jar', label: 'в любых классах jar' }] },
        { name: 'terms', label: 'Строки поиска (по одной на строку)', type: 'textarea', rows: 8, value: r ? r.terms.join('\n') : '' },
        { name: 'caseSensitive', label: 'Учитывать регистр', type: 'checkbox', value: r ? r.caseSensitive : false },
        { name: 'enabled', label: 'Правило включено', type: 'checkbox', value: r ? r.enabled : true },
        { name: 'description', label: 'Комментарий', value: r ? r.description : '' }
      ],
      onSubmit: v => (r ? api('PATCH', '/api/admin/rules/' + r.id, v) : api('POST', '/api/admin/rules', v))
    });
    body.replaceChildren(
      h('p', { class: 'sub' }, 'Эти правила использует чекер модов. Изменения применяются сразу при следующей проверке.'),
      h('div', { class: 'toolbar' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: async () => { await ruleModal(null); await ctx.refresh(); } }, '＋ Правило')),
      ...list.map(r => {
        const [sv, cls] = SEV[r.severity];
        return h('div', { class: 'card', style: r.enabled ? '' : 'opacity:.55' },
          h('div', { class: 'card-head' },
            h('div', {}, h('span', { class: 'card-title' }, r.name), ' ', h('span', { class: 'pill ' + cls }, sv), ' ', h('span', { class: 'pill' }, TARGET[r.target]), r.enabled ? null : h('span', { class: 'pill' }, 'выключено')),
            h('div', { class: 'actions' },
              h('button', { class: 'btn sm', onclick: () => act(() => api('PATCH', '/api/admin/rules/' + r.id, { enabled: !r.enabled })) }, r.enabled ? 'Выключить' : 'Включить'),
              h('button', { class: 'btn sm', onclick: async () => { await ruleModal(r); await ctx.refresh(); } }, 'Изменить'),
              h('button', { class: 'btn sm danger', onclick: async () => { if (await confirm('Удалить правило?', r.name)) act(() => api('DELETE', '/api/admin/rules/' + r.id), 'Удалено'); } }, '✕'))),
          r.description ? h('div', { class: 'card-desc' }, r.description) : null,
          h('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:6px' }, (r.mode === 'all' ? 'все из' : 'любая из') + ' ' + r.terms.length + (r.caseSensitive ? ' · с учётом регистра' : '')),
          h('pre', { class: 'collapsed' }, r.terms.join('  |  ')));
      }));
  }

  // ================= AUDIT =================
  async function audit() {
    const { audit: list } = await api('GET', '/api/admin/audit');
    body.replaceChildren(h('p', { class: 'sub' }, 'Последние 500 событий: входы, изменения доступа и данных.'),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Время', 'Кто', 'Действие', 'Детали'].map(t => h('th', {}, t)))),
        h('tbody', {}, list.map(a => h('tr', {}, h('td', {}, fmtDate(a.t, true)), h('td', {}, a.actor), h('td', {}, h('span', { class: 'pill' + (a.action.includes('fail') || a.action.includes('denied') ? ' bad' : '') }, a.action)), h('td', { class: 'mono' }, a.detail)))))));
  }

  // ================= BACKUP =================
  async function backup() {
    const ov = await api('GET', '/api/admin/overview');
    const file = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      if (!(await confirm('Импортировать бэкап?', 'Разделы, записи, хэши и правила будут ЗАМЕНЕНЫ данными из файла. Пользователи не затрагиваются.', 'Заменить'))) return;
      act(async () => api('POST', '/api/admin/import', JSON.parse(await f.text())), 'Импортировано');
    } });
    body.replaceChildren(
      h('div', { class: 'stats' }, [['Пользователей', ov.users], ['Ждут одобрения', ov.pending], ['Записей', ov.entries], ['Хэшей', ov.hashes], ['Правил', ov.rules], ['Активных сессий', ov.sessions]].map(([l, n]) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, l)))),
      h('div', { class: 'card plain' }, h('h2', {}, 'Резервная копия'), h('p', { class: 'muted' }, 'Экспорт включает разделы, записи, хэши и правила (без пользователей и паролей).'),
        h('div', { class: 'toolbar', style: 'margin:0' },
          h('button', { class: 'btn gold', onclick: async () => {
            const r = await fetch('/api/admin/export'); const blob = await r.blob();
            const a = h('a', { href: URL.createObjectURL(blob), download: 'ss-portal-backup-' + new Date().toISOString().slice(0, 10) + '.json' }); a.click(); URL.revokeObjectURL(a.href);
          } }, 'Скачать бэкап'),
          h('button', { class: 'btn', onclick: () => file.click() }, 'Импорт из файла…'), file)));
  }

  window.Admin = { mount };
})();
