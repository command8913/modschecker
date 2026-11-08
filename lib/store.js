'use strict';
const fs = require('fs');
const path = require('path');
const FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
let db = null;

function seed() {
  const r = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed', f), 'utf8'));
  const crypto = require('crypto');
  const now = new Date().toISOString();
  return {
    users: [],
    sessions: {},
    audit: [],
    settings: { registration: 'open' },
    sections: r('sections.json'),
    entries: r('entries.json').map(e => ({ id: crypto.randomUUID(), ...e })),
    hashes: r('hashes.json').map(h => ({ hash: h, label: '', addedBy: 'seed', addedAt: now })),
    rules: require('../seed/rules.js')
  };
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

function load() {
  if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  else { db = seed(); save(); }
  const now = Date.now();
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].expires < now) delete db.sessions[k];
  return db;
}

module.exports = { load, save, get: () => db, FILE };
