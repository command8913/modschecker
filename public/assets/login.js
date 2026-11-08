(function () {
  'use strict';
  let mode = 'login';
  const $ = id => document.getElementById(id);
  const msg = $('msg');
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === m));
    document.querySelectorAll('.reg-only').forEach(e => { e.hidden = m !== 'register'; });
    $('submit').textContent = m === 'login' ? 'Войти' : 'Отправить заявку';
    $('password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    msg.textContent = ''; msg.className = 'msg';
  }
  $('tabs').addEventListener('click', e => { if (e.target.dataset.tab) setMode(e.target.dataset.tab); });
  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    msg.textContent = ''; msg.className = 'msg';
    const username = $('username').value.trim(), password = $('password').value;
    if (mode === 'register' && password !== $('password2').value) { msg.textContent = 'Пароли не совпадают.'; msg.className = 'msg err'; return; }
    $('submit').disabled = true;
    try {
      const r = await fetch('/api/' + mode, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ss-portal' },
        body: JSON.stringify({ username, password, note: $('note').value })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = d.error || 'Ошибка'; msg.className = 'msg err'; return; }
      if (mode === 'login') location.href = '/';
      else { msg.textContent = d.message; msg.className = 'msg ok'; $('form').reset(); }
    } catch { msg.textContent = 'Нет связи с сервером.'; msg.className = 'msg err'; }
    finally { $('submit').disabled = false; }
  });
})();
