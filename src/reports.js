// Reportes de bugs enviados desde la app (sin dependencias).
// Se guardan en data/reports.json y se avisan al admin.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'reports.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ reports: [] }, null, 2));
}

function load() {
  ensure();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(data.reports)) data.reports = [];
    return data;
  } catch {
    return { reports: [] };
  }
}

function save(data) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function add({ username, message, device, appVersion }) {
  const data = load();
  const report = {
    id: 'b' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    username: (username || '').toString().slice(0, 64),
    message: (message || '').toString().slice(0, 2000),
    device: (device || '').toString().slice(0, 120),
    appVersion: (appVersion || '').toString().slice(0, 40),
    status: 'nuevo', // nuevo | visto | resuelto
    createdAt: new Date().toISOString(),
  };
  data.reports.push(report);
  save(data);
  return report;
}

function list(filter = {}) {
  let rows = load().reports.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  return rows;
}

function setStatus(id, status) {
  const data = load();
  const r = data.reports.find((x) => x.id === id);
  if (!r) return null;
  r.status = status;
  save(data);
  return r;
}

module.exports = { add, list, setStatus };
