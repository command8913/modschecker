(function () {
  'use strict';
  const { h, api, toast, copy, modal, fmtDate } = UI;
  const root = document.getElementById('app');
  const S = { me: null, content: null, route: 'checker', pending: 0 };

  async function load() {
    const { user } = await api('GET', '/api/me');
    S.me = user;
    if (user.mustChange) return forcePasswordChange();
    S.content = await api('GET', '/api/content');
    if (user.role === 'admin') { try { S.pending = (await api('GET', '/api/admin/overview')).pending; } catch { /* ignore */ } }
    const r = location.hash.slice(1);
    S.route = r || (S.content.checker ? 'checker' : (S.content.sections[0] ? S.content.sections[0].id : 'none'));
    render();
  }

  async function forcePasswordChange() {
    root.replaceChildren(h('div', { class: 'main', style: 'margin:0;width:100%' }, h('h1', {}, 'Смена пароля'), h('p', { class: 'sub' }, 'Для продолжения задайте свой личный пароль.')));
    await changePassword(true);
    location.reload();
  }

  function changePassword(forced) {
    return modal({
      title: 'Смена пароля', subtitle: forced ? 'Это обязательный шаг после выдачи временного пароля.' : null,
      fields: [
        { name: 'oldPassword', label: 'Текущий пароль', type: 'password' },
        { name: 'newPassword', label: 'Новый пароль (минимум 8 символов)', type: 'password' },
        { name: 'repeat', label: 'Повторите новый пароль', type: 'password' }
      ],
      onSubmit: async v => {
        if (v.newPassword !== v.repeat) throw new Error('Пароли не совпадают.');
        await api('POST', '/api/password', { oldPassword: v.oldPassword, newPassword: v.newPassword });
        toast('Пароль изменён');
      }
    }).then(v => { if (v === null && forced) return changePassword(true); return v; });
  }

  async function logout() { await api('POST', '/api/logout'); location.href = '/login'; }

  function go(route) { location.hash = route; S.route = route; render(); document.querySelector('.sidebar')?.classList.remove('open'); }

  function render() {
    const { me, content } = S;
    const nav = [];
    if (content.checker) nav.push(navBtn('checker', 'Проверка модов'));
    content.sections.forEach(s => nav.push(navBtn(s.id, s.title)));
    if (me.role === 'admin') { nav.push(h('div', { class: 'nav-sep' })); nav.push(navBtn('admin', 'Админ-панель', S.pending)); }

    const view = h('div', { class: 'main' });
    const shell = h('div', { class: 'shell' },
      h('button', { class: 'btn menu-toggle', onclick: () => document.querySelector('.sidebar').classList.toggle('open') }, '☰'),
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' }, h('b', {}, 'SS Tools'), h('small', {}, 'by command8913')),
        nav,
        h('div', { class: 'side-foot' },
          h('span', {}, me.role === 'admin' ? 'Администратор' : 'Пользователь'), h('b', {}, me.username),
          me.expiresAt && me.role !== 'admin' ? h('span', {}, 'Доступ до ' + fmtDate(me.expiresAt)) : null,
          h('div', { class: 'row' },
            h('button', { class: 'btn sm', onclick: () => changePassword(false) }, 'Пароль'),
            h('button', { class: 'btn sm', onclick: logout }, 'Выйти')))),
      view);
    root.replaceChildren(shell);

    if (S.route === 'checker' && content.checker) Checker.mount(view, S);
    else if (S.route === 'admin' && me.role === 'admin') Admin.mount(view, S, { refresh: load, setPending: n => { S.pending = n; const b = document.querySelector('.nav-btn[data-r=admin] .badge'); if (b) b.textContent = n; } });
    else {
      const sec = content.sections.find(s => s.id === S.route);
      if (sec) sectionView(view, sec);
      else view.append(h('div', { class: 'empty' }, content.sections.length || content.checker ? 'Выберите раздел слева.' : 'Вам пока не выдан доступ ни к одному разделу.'));
    }
  }

  function navBtn(id, label, badge) {
    return h('button', { class: 'nav-btn' + (S.route === id ? ' active' : ''), 'data-r': id, onclick: () => go(id) }, label, badge ? h('span', { class: 'badge' }, badge) : null);
  }

  function sectionView(view, sec) {
    const list = h('div');
    const empty = h('div', { class: 'empty', hidden: true }, 'Ничего не найдено');
    const q = h('input', { type: 'search', class: 'search', placeholder: 'Поиск…', autocomplete: 'off' });
    const cards = sec.entries.map(e => {
      const long = e.content.length > 400;
      const pre = h('pre', { class: long ? 'collapsed' : '' }, e.content);
      const toggle = long ? h('button', { class: 'btn sm', onclick: () => { const c = pre.classList.toggle('collapsed'); toggle.textContent = c ? 'Показать полностью' : 'Свернуть'; } }, 'Показать полностью') : null;
      const isUrl = /^https?:\/\/\S+$/.test(e.content);
      const el = h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, e.name),
          h('div', { class: 'actions' }, toggle,
            isUrl ? h('a', { class: 'btn sm gold', href: e.content, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть') : null,
            h('button', { class: 'btn sm gold', onclick: ev => { copy(e.content); ev.target.textContent = 'copied!'; setTimeout(() => ev.target.textContent = 'copy', 1000); } }, 'copy'))),
        e.description ? h('div', { class: 'card-desc' }, e.description) : null, pre);
      el._text = (e.name + ' ' + e.content + ' ' + e.description).toLowerCase();
      return el;
    });
    list.append(...cards);
    q.addEventListener('input', () => {
      const t = q.value.trim().toLowerCase(); let n = 0;
      cards.forEach(c => { const ok = !t || c._text.includes(t); c.hidden = !ok; if (ok) n++; });
      empty.hidden = n > 0;
    });
    view.append(h('h1', {}, sec.title), h('p', { class: 'sub' }, sec.entries.length + ' записей'), h('div', { class: 'toolbar' }, q), list, empty);
    if (!sec.entries.length) empty.hidden = false, empty.textContent = 'Раздел пока пуст.';
  }

  window.addEventListener('hashchange', () => { const r = location.hash.slice(1); if (r && r !== S.route && S.content) { S.route = r; render(); } });
  load().catch(e => { root.replaceChildren(h('div', { class: 'empty' }, e.message)); });
})();
