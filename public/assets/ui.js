(function () {
  'use strict';

  // Безопасное построение DOM (без innerHTML)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return el;
  }

  async function api(method, url, body) {
    const opt = { method, headers: { 'X-Requested-With': 'ss-portal' } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(url, opt);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 || (r.status === 403 && ['blocked', 'expired', 'pending'].includes(d.error))) { location.href = '/login'; }
      const e = new Error(d.error || 'Ошибка ' + r.status); e.code = d.error; e.status = r.status; throw e;
    }
    return d;
  }

  function toast(text, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : '') }, text);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), err ? 5000 : 2200);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    toast('Скопировано');
  }

  const fmtDate = (iso, withTime) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('ru-RU', withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium' });
  };

  /**
   * Универсальная форма в модальном окне.
   * fields: [{name,label,type:text|password|textarea|select|checkbox|date|checks,options:[{value,label}],value,hint,rows,required}]
   */
  function modal({ title, subtitle, fields, submit = 'Сохранить', wide, onSubmit, extra }) {
    return new Promise(resolve => {
      const inputs = {};
      const err = h('div', { class: 'err-text' });
      const form = h('form', { novalidate: true });
      for (const f of fields) {
        let el;
        if (f.type === 'textarea') el = h('textarea', { rows: f.rows || 5, value: f.value || '' });
        else if (f.type === 'select') el = h('select', {}, f.options.map(o => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
        else if (f.type === 'checkbox') el = h('input', { type: 'checkbox', checked: !!f.value });
        else if (f.type === 'checks') {
          const boxes = f.options.map(o => {
            const cb = h('input', { type: 'checkbox', checked: (f.value || []).includes(o.value) });
            cb._v = o.value;
            return { cb, node: h('label', { class: 'chip' }, cb, o.label) };
          });
          el = h('div', { class: 'chips' }, boxes.map(b => b.node));
          el._get = () => boxes.filter(b => b.cb.checked).map(b => b.cb._v);
          if (f.exclusive) {
            const all = boxes.find(b => b.cb._v === f.exclusive);
            const sync = () => boxes.forEach(b => { if (b !== all) b.cb.disabled = all.cb.checked; });
            all.cb.addEventListener('change', sync); sync();
          }
        } else el = h('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '', autocomplete: f.type === 'password' ? 'new-password' : 'off' });
        inputs[f.name] = el;
        if (f.type === 'checkbox') form.append(h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--text)' }, el, f.label));
        else form.append(h('label', {}, f.label, f.type === 'checks' ? h('div', { style: 'margin-top:6px' }, el) : el, f.hint ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, f.hint) : null));
      }
      const close = v => { ov.remove(); resolve(v); };
      const btn = h('button', { class: 'btn primary', type: 'submit' }, submit);
      form.append(err, h('div', { class: 'btns' }, extra || null, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Отмена'), btn));
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const v = {};
        for (const f of fields) {
          const el = inputs[f.name];
          v[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'checks' ? el._get() : el.value;
        }
        btn.disabled = true; err.textContent = '';
        try { await onSubmit(v); close(v); }
        catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      });
      const ov = h('div', { class: 'overlay' }, h('div', { class: 'modal' + (wide ? ' wide' : '') }, h('h2', {}, title), subtitle ? h('div', { class: 'muted' }, subtitle) : null, form));
      ov.addEventListener('mousedown', e => { if (e.target === ov) close(null); });
      document.body.append(ov);
      const first = form.querySelector('input:not([type=checkbox]),textarea,select');
      if (first) first.focus();
    });
  }

  const confirmBox = (title, text, ok = 'Удалить') => modal({
    title, subtitle: text, fields: [], submit: ok, onSubmit: async () => {}
  }).then(v => v !== null);

  window.UI = { h, api, toast, copy, modal, confirm: confirmBox, fmtDate };
})();
