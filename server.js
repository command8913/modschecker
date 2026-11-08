'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./lib/store');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 7;
const db = store.load();
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- helpers ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

function parseCookies(h) {
  const o = {};
  (h || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch { /* ignore */ } }
  });
  return o;
}

function audit(actor, action, detail = '') {
  db.audit.push({ t: now(), actor: actor || '-', action, detail: String(detail).slice(0, 300) });
  if (db.audit.length > 2000) db.audit.splice(0, db.audit.length - 2000);
}

function accessState(u) {
  if (u.status === 'pending') return 'pending';
  if (u.status === 'blocked') return 'blocked';
  if (u.role !== 'admin' && u.expiresAt && new Date(u.expiresAt).getTime() < Date.now()) return 'expired';
  return 'ok';
}
const canSection = (u, id) => u.role === 'admin' || (u.sections || []).includes('*') || (u.sections || []).includes(id);
const publicUser = u => ({
  id: u.id, username: u.username, role: u.role, status: u.status, sections: u.sections,
  expiresAt: u.expiresAt, mustChange: !!u.mustChange, note: u.note || '',
  createdAt: u.createdAt, lastLogin: u.lastLogin || null
});

function killSessions(userId) {
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === userId) delete db.sessions[k];
}

function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 128; }
function validUsername(n) { return typeof n === 'string' && /^[A-Za-z0-9_.-]{3,24}$/.test(n); }

// ---------- rate limit ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const h = hits.get(key);
  if (!h || t - h.first > windowMs) { hits.set(key, { first: t, count: 1 }); return false; }
  h.count++;
  return h.count > max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t - v.first > 3600e3) hits.delete(k); }, 600e3).unref();

// ---------- middleware ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.modrinth.com; connect-src 'self' https://api.modrinth.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '8mb' }));

// CSRF: все изменяющие запросы должны нести кастомный заголовок (кросс-доменно его не отправить без CORS) + SameSite=Strict
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'ss-portal') return res.status(403).json({ error: 'csrf' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function session(req) {
  const tok = parseCookies(req.headers.cookie).sid;
  if (!tok) return null;
  const key = sha(tok);
  const s = db.sessions[key];
  if (!s || s.expires < Date.now()) return null;
  const user = db.users.find(u => u.id === s.userId);
  if (!user) return null;
  return { user, key };
}

function needAuth(req, res, next) {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  const st = accessState(s.user);
  if (st !== 'ok') { delete db.sessions[s.key]; store.save(); return res.status(403).json({ error: st }); }
  req.user = s.user; req.sessionKey = s.key;
  next();
}
const needAdmin = [needAuth, (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden' }))];
const noMustChange = (req, res, next) => (req.user.mustChange ? res.status(403).json({ error: 'must_change' }) : next());

function startSession(req, res, user) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(tok)] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 864e5, ip: req.ip, created: now() };
  const secure = req.secure || process.env.COOKIE_SECURE === '1';
  res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

// ---------- bootstrap admin ----------
if (!db.users.some(u => u.role === 'admin')) {
  const name = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.users.push({
    id: uid(), username: name, usernameLower: name.toLowerCase(), passHash: bcrypt.hashSync(pass, 10),
    role: 'admin', status: 'active', sections: ['*'], expiresAt: null, mustChange: !process.env.ADMIN_PASSWORD,
    note: 'Создан автоматически', createdAt: now()
  });
  audit('system', 'bootstrap_admin', name);
  store.save();
  console.log('\n==================================================');
  console.log(' Создан администратор');
  console.log('   логин:  ' + name);
  console.log('   пароль: ' + pass + (process.env.ADMIN_PASSWORD ? '' : '   (смените при первом входе)'));
  console.log('==================================================\n');
}

// ---------- pages ----------
const view = f => path.join(__dirname, 'views', f);
app.get('/', (req, res) => {
  const s = session(req);
  if (!s || accessState(s.user) !== 'ok') return res.redirect('/login');
  res.sendFile(view('app.html'));
});
app.get('/login', (req, res) => {
  const s = session(req);
  if (s && accessState(s.user) === 'ok') return res.redirect('/');
  res.sendFile(view('login.html'));
});
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '5m' }));
app.get('/vendor/jszip.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'jszip', 'dist', 'jszip.min.js')));

// ---------- auth API ----------
app.post('/api/register', (req, res) => {
  if (db.settings.registration !== 'open') return res.status(403).json({ error: 'Регистрация закрыта. Обратитесь к администратору.' });
  if (limited('reg|' + req.ip, 5, 3600e3)) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже.' });
  const username = str(req.body.username, 24), password = req.body.password;
  if (!validUsername(username)) return res.status(400).json({ error: 'Логин: 3–24 символа (латиница, цифры, _ . -).' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Пароль: минимум 8 символов.' });
  if (db.users.some(u => u.usernameLower === username.toLowerCase())) return res.status(409).json({ error: 'Такой логин уже занят.' });
  db.users.push({
    id: uid(), username, usernameLower: username.toLowerCase(), passHash: bcrypt.hashSync(password, 10),
    role: 'user', status: 'pending', sections: ['*'], expiresAt: null, mustChange: false,
    note: str(req.body.note, 200), createdAt: now()
  });
  audit(username, 'register');
  store.save();
  res.json({ ok: true, message: 'Заявка отправлена. Дождитесь, пока администратор выдаст доступ.' });
});

app.post('/api/login', (req, res) => {
  const username = str(req.body.username, 24), password = req.body.password;
  const key = 'login|' + req.ip + '|' + username.toLowerCase();
  if (limited(key, 8, 10 * 60e3)) return res.status(429).json({ error: 'Слишком много попыток входа. Подождите 10 минут.' });
  const user = db.users.find(u => u.usernameLower === username.toLowerCase());
  const ok = bcrypt.compareSync(typeof password === 'string' ? password : '', user ? user.passHash : DUMMY_HASH);
  if (!user || !ok) { audit(username, 'login_failed', req.ip); store.save(); return res.status(401).json({ error: 'Неверный логин или пароль.' }); }
  const st = accessState(user);
  const msg = {
    pending: 'Ваша заявка ещё не одобрена администратором.',
    blocked: 'Доступ заблокирован администратором.',
    expired: 'Срок вашего доступа истёк. Обратитесь к администратору.'
  };
  if (st !== 'ok') { audit(user.username, 'login_denied', st); store.save(); return res.status(403).json({ error: msg[st], state: st }); }
  hits.delete(key);
  user.lastLogin = now();
  startSession(req, res, user);
  audit(user.username, 'login', req.ip);
  store.save();
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const s = session(req);
  if (s) { delete db.sessions[s.key]; store.save(); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', needAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/password', needAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!bcrypt.compareSync(String(oldPassword || ''), req.user.passHash)) return res.status(400).json({ error: 'Текущий пароль неверен.' });
  if (!validPassword(newPassword)) return res.status(400).json({ error: 'Новый пароль: минимум 8 символов.' });
  if (newPassword === oldPassword) return res.status(400).json({ error: 'Новый пароль должен отличаться от старого.' });
  req.user.passHash = bcrypt.hashSync(newPassword, 10);
  req.user.mustChange = false;
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === req.user.id && k !== req.sessionKey) delete db.sessions[k];
  audit(req.user.username, 'password_change');
  store.save();
  res.json({ ok: true });
});

// ---------- content API ----------
app.get('/api/content', needAuth, noMustChange, (req, res) => {
  const u = req.user;
  const sections = db.sections
    .filter(s => canSection(u, s.id))
    .sort((a, b) => a.order - b.order)
    .map(s => ({ ...s, entries: db.entries.filter(e => e.sectionId === s.id).sort((a, b) => a.order - b.order) }));
  res.json({ sections, checker: canSection(u, 'checker') });
});

app.get('/api/checker/data', needAuth, noMustChange, (req, res) => {
  if (!canSection(req.user, 'checker')) return res.status(403).json({ error: 'forbidden' });
  const hashes = {};
  db.hashes.forEach(h => { hashes[h.hash] = h.label || ''; });
  res.json({ hashes, rules: db.rules.filter(r => r.enabled) });
});

// ---------- admin API ----------
const admin = express.Router();
admin.use(needAdmin, noMustChange);

admin.get('/overview', (req, res) => res.json({
  users: db.users.length, pending: db.users.filter(u => u.status === 'pending').length,
  entries: db.entries.length, hashes: db.hashes.length, rules: db.rules.length, sessions: Object.keys(db.sessions).length
}));

// users
const activeAdmins = () => db.users.filter(u => u.role === 'admin' && u.status === 'active');
function cleanSections(arr) {
  if (!Array.isArray(arr)) return ['*'];
  if (arr.includes('*')) return ['*'];
  const valid = new Set(['checker', ...db.sections.map(s => s.id)]);
  return [...new Set(arr.filter(x => valid.has(x)))];
}
function cleanExpiry(v) {
  if (v === null || v === '' || v === undefined) return null;
  const d = new Date(v);
  return isNaN(d) ? undefined : d.toISOString();
}

admin.get('/users', (req, res) => res.json({
  users: db.users.map(publicUser).sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || a.username.localeCompare(b.username)),
  settings: db.settings
}));

admin.post('/users', (req, res) => {
  const username = str(req.body.username, 24), password = req.body.password;
  if (!validUsername(username)) return res.status(400).json({ error: 'Логин: 3–24 символа (латиница, цифры, _ . -).' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Пароль: минимум 8 символов.' });
  if (db.users.some(u => u.usernameLower === username.toLowerCase())) return res.status(409).json({ error: 'Такой логин уже есть.' });
  const exp = cleanExpiry(req.body.expiresAt);
  if (exp === undefined) return res.status(400).json({ error: 'Неверная дата.' });
  const u = {
    id: uid(), username, usernameLower: username.toLowerCase(), passHash: bcrypt.hashSync(password, 10),
    role: req.body.role === 'admin' ? 'admin' : 'user', status: 'active', sections: cleanSections(req.body.sections),
    expiresAt: exp, mustChange: true, note: str(req.body.note, 200), createdAt: now()
  };
  db.users.push(u);
  audit(req.user.username, 'user_create', username);
  store.save();
  res.json({ user: publicUser(u) });
});

admin.patch('/users/:id', (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Не найден.' });
  const self = u.id === req.user.id;
  const b = req.body;
  const changes = [];
  const backup = { ...u };
  if (b.status !== undefined) {
    if (!['pending', 'active', 'blocked'].includes(b.status)) return res.status(400).json({ error: 'Неверный статус.' });
    if (self && b.status !== 'active') return res.status(400).json({ error: 'Нельзя заблокировать самого себя.' });
    u.status = b.status; changes.push('status=' + b.status);
    if (b.status !== 'active') killSessions(u.id);
  }
  if (b.role !== undefined) {
    if (!['user', 'admin'].includes(b.role)) return res.status(400).json({ error: 'Неверная роль.' });
    if (self && b.role !== 'admin') return res.status(400).json({ error: 'Нельзя снять админа с самого себя.' });
    u.role = b.role; changes.push('role=' + b.role);
  }
  if (b.sections !== undefined) { u.sections = cleanSections(b.sections); changes.push('sections=' + u.sections.join(',')); }
  if (b.expiresAt !== undefined) {
    const exp = cleanExpiry(b.expiresAt);
    if (exp === undefined) return res.status(400).json({ error: 'Неверная дата.' });
    u.expiresAt = exp; changes.push('expires=' + (exp || 'never'));
  }
  if (b.note !== undefined) u.note = str(b.note, 200);
  if (b.password !== undefined) {
    if (!validPassword(b.password)) return res.status(400).json({ error: 'Пароль: минимум 8 символов.' });
    u.passHash = bcrypt.hashSync(b.password, 10); u.mustChange = true; killSessions(u.id); changes.push('password_reset');
  }
  if (activeAdmins().length === 0) {
    Object.assign(u, backup);
    return res.status(400).json({ error: 'Должен остаться хотя бы один активный администратор.' });
  }
  audit(req.user.username, 'user_update', u.username + ' ' + changes.join(' '));
  store.save();
  res.json({ user: publicUser(u) });
});

admin.delete('/users/:id', (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Не найден.' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить самого себя.' });
  if (u.role === 'admin' && u.status === 'active' && activeAdmins().length <= 1) return res.status(400).json({ error: 'Нельзя удалить последнего администратора.' });
  killSessions(u.id);
  db.users = db.users.filter(x => x.id !== u.id);
  audit(req.user.username, 'user_delete', u.username);
  store.save();
  res.json({ ok: true });
});

admin.patch('/settings', (req, res) => {
  if (req.body.registration !== undefined) {
    if (!['open', 'closed'].includes(req.body.registration)) return res.status(400).json({ error: 'Неверное значение.' });
    db.settings.registration = req.body.registration;
  }
  audit(req.user.username, 'settings', JSON.stringify(db.settings));
  store.save();
  res.json({ settings: db.settings });
});

// sections
admin.get('/sections', (req, res) => res.json({
  sections: [...db.sections].sort((a, b) => a.order - b.order).map(s => ({ ...s, count: db.entries.filter(e => e.sectionId === s.id).length }))
}));
admin.post('/sections', (req, res) => {
  const title = str(req.body.title, 40);
  if (!title) return res.status(400).json({ error: 'Укажите название.' });
  const type = req.body.type === 'link' ? 'link' : 'command';
  let id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 's';
  while (db.sections.some(s => s.id === id) || id === 'checker') id += '-' + Math.floor(Math.random() * 100);
  const s = { id, title, type, order: db.sections.length };
  db.sections.push(s);
  audit(req.user.username, 'section_create', title);
  store.save();
  res.json({ section: s });
});
admin.patch('/sections/:id', (req, res) => {
  const s = db.sections.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Не найден.' });
  if (req.body.title !== undefined) { const t = str(req.body.title, 40); if (!t) return res.status(400).json({ error: 'Пустое название.' }); s.title = t; }
  if (req.body.type !== undefined) s.type = req.body.type === 'link' ? 'link' : 'command';
  audit(req.user.username, 'section_update', s.title);
  store.save();
  res.json({ section: s });
});
admin.post('/sections/reorder', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  ids.forEach((id, i) => { const s = db.sections.find(x => x.id === id); if (s) s.order = i; });
  store.save();
  res.json({ ok: true });
});
admin.delete('/sections/:id', (req, res) => {
  const s = db.sections.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Не найден.' });
  db.sections = db.sections.filter(x => x.id !== s.id);
  db.entries = db.entries.filter(e => e.sectionId !== s.id);
  db.users.forEach(u => { u.sections = (u.sections || []).filter(x => x !== s.id); });
  audit(req.user.username, 'section_delete', s.title);
  store.save();
  res.json({ ok: true });
});

// entries
function entryFields(b) {
  return { name: str(b.name, 120), content: typeof b.content === 'string' ? b.content.trim().slice(0, 300000) : '', description: str(b.description, 500) };
}
admin.post('/entries', (req, res) => {
  const sec = db.sections.find(s => s.id === req.body.sectionId);
  if (!sec) return res.status(400).json({ error: 'Раздел не найден.' });
  const f = entryFields(req.body);
  if (!f.name || !f.content) return res.status(400).json({ error: 'Название и содержимое обязательны.' });
  const order = Math.max(-1, ...db.entries.filter(e => e.sectionId === sec.id).map(e => e.order)) + 1;
  const e = { id: uid(), sectionId: sec.id, ...f, order };
  db.entries.push(e);
  audit(req.user.username, 'entry_create', sec.title + ' / ' + f.name);
  store.save();
  res.json({ entry: e });
});
admin.patch('/entries/:id', (req, res) => {
  const e = db.entries.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Не найдена.' });
  const f = entryFields({ name: req.body.name ?? e.name, content: req.body.content ?? e.content, description: req.body.description ?? e.description });
  if (!f.name || !f.content) return res.status(400).json({ error: 'Название и содержимое обязательны.' });
  Object.assign(e, f);
  if (req.body.sectionId && req.body.sectionId !== e.sectionId && db.sections.some(s => s.id === req.body.sectionId)) {
    e.sectionId = req.body.sectionId;
    e.order = Math.max(-1, ...db.entries.filter(x => x.sectionId === e.sectionId && x !== e).map(x => x.order)) + 1;
  }
  audit(req.user.username, 'entry_update', e.name);
  store.save();
  res.json({ entry: e });
});
admin.post('/entries/reorder', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  ids.forEach((id, i) => { const e = db.entries.find(x => x.id === id); if (e) e.order = i; });
  store.save();
  res.json({ ok: true });
});
admin.delete('/entries/:id', (req, res) => {
  const e = db.entries.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Не найдена.' });
  db.entries = db.entries.filter(x => x.id !== e.id);
  audit(req.user.username, 'entry_delete', e.name);
  store.save();
  res.json({ ok: true });
});

// hashes
admin.get('/hashes', (req, res) => res.json({ hashes: db.hashes }));
admin.post('/hashes', (req, res) => {
  const found = String(req.body.text || '').toLowerCase().match(/\b[a-f0-9]{40}\b/g) || [];
  const label = str(req.body.label, 80);
  const have = new Set(db.hashes.map(h => h.hash));
  let added = 0;
  for (const h of new Set(found)) if (!have.has(h)) { db.hashes.push({ hash: h, label, addedBy: req.user.username, addedAt: now() }); added++; }
  audit(req.user.username, 'hash_add', `${added} new of ${found.length}`);
  store.save();
  res.json({ added, skipped: new Set(found).size - added });
});
admin.patch('/hashes/:hash', (req, res) => {
  const h = db.hashes.find(x => x.hash === req.params.hash);
  if (!h) return res.status(404).json({ error: 'Не найден.' });
  h.label = str(req.body.label, 80);
  store.save();
  res.json({ hash: h });
});
admin.delete('/hashes/:hash', (req, res) => {
  const before = db.hashes.length;
  db.hashes = db.hashes.filter(x => x.hash !== req.params.hash);
  if (db.hashes.length === before) return res.status(404).json({ error: 'Не найден.' });
  audit(req.user.username, 'hash_delete', req.params.hash);
  store.save();
  res.json({ ok: true });
});

// rules
function ruleFields(b) {
  const terms = (Array.isArray(b.terms) ? b.terms : String(b.terms || '').split('\n')).map(t => String(t).trim()).filter(Boolean).slice(0, 2000);
  return {
    name: str(b.name, 120), severity: ['high', 'medium', 'low'].includes(b.severity) ? b.severity : 'medium',
    target: ['content', 'path', 'name'].includes(b.target) ? b.target : 'content', mode: b.mode === 'all' ? 'all' : 'any',
    scope: b.scope === 'jar' ? 'jar' : 'class', caseSensitive: !!b.caseSensitive, enabled: b.enabled !== false,
    description: str(b.description, 400), terms
  };
}
admin.get('/rules', (req, res) => res.json({ rules: db.rules }));
admin.post('/rules', (req, res) => {
  const f = ruleFields(req.body);
  if (!f.name || !f.terms.length) return res.status(400).json({ error: 'Название и хотя бы одна строка обязательны.' });
  const r = { id: uid(), ...f };
  db.rules.push(r);
  audit(req.user.username, 'rule_create', f.name);
  store.save();
  res.json({ rule: r });
});
admin.patch('/rules/:id', (req, res) => {
  const r = db.rules.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Не найдено.' });
  const f = ruleFields({ ...r, ...req.body });
  if (!f.name || !f.terms.length) return res.status(400).json({ error: 'Название и хотя бы одна строка обязательны.' });
  Object.assign(r, f);
  audit(req.user.username, 'rule_update', r.name);
  store.save();
  res.json({ rule: r });
});
admin.delete('/rules/:id', (req, res) => {
  const r = db.rules.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Не найдено.' });
  db.rules = db.rules.filter(x => x.id !== r.id);
  audit(req.user.username, 'rule_delete', r.name);
  store.save();
  res.json({ ok: true });
});

// audit / backup
admin.get('/audit', (req, res) => res.json({ audit: db.audit.slice(-500).reverse() }));
admin.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="ss-portal-backup.json"');
  res.json({ version: 2, sections: db.sections, entries: db.entries, hashes: db.hashes, rules: db.rules });
});
admin.post('/import', (req, res) => {
  const b = req.body;
  if (!b || !Array.isArray(b.sections) || !Array.isArray(b.entries)) return res.status(400).json({ error: 'Неверный формат бэкапа.' });
  db.sections = b.sections.map((s, i) => ({ id: str(s.id, 60), title: str(s.title, 40), type: s.type === 'link' ? 'link' : 'command', order: i })).filter(s => s.id && s.title);
  const ids = new Set(db.sections.map(s => s.id));
  db.entries = b.entries.filter(e => ids.has(e.sectionId)).map((e, i) => ({ id: uid(), sectionId: e.sectionId, order: Number.isFinite(e.order) ? e.order : i, ...entryFields(e) })).filter(e => e.name && e.content);
  if (Array.isArray(b.hashes)) db.hashes = b.hashes.filter(h => /^[a-f0-9]{40}$/.test(h.hash)).map(h => ({ hash: h.hash, label: str(h.label, 80), addedBy: str(h.addedBy, 24) || 'import', addedAt: h.addedAt || now() }));
  if (Array.isArray(b.rules)) db.rules = b.rules.map(r => ({ id: uid(), ...ruleFields(r) })).filter(r => r.name && r.terms.length);
  audit(req.user.username, 'import', `${db.sections.length} sections, ${db.entries.length} entries`);
  store.save();
  res.json({ ok: true });
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => { // eslint-disable-line
  if (req.path.startsWith('/api')) return res.status(err.status || 500).json({ error: err.status === 400 ? 'Неверный запрос' : 'Ошибка сервера' });
  res.status(500).send('Error');
});

app.listen(PORT, () => console.log(`SS Portal: http://localhost:${PORT}`));
