// Almacén de suscriptores en un archivo JSON (la "plantilla").
// Guarda: usuario, teléfono, plan, vencimiento, baneo e historial de pagos.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'subscribers.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ subscribers: [] }, null, 2));
}

function load() {
  ensure();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // Normaliza registros antiguos para que tengan todos los campos.
    for (const s of data.subscribers) {
      if (s.phone == null) s.phone = '';
      if (s.banned == null) s.banned = false;
      if (!Array.isArray(s.history)) s.history = [];
    }
    return data;
  } catch (e) {
    return { subscribers: [] };
  }
}

function save(data) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function list() { return load().subscribers; }
function getByUsername(username) { return load().subscribers.find((s) => s.username === username) || null; }

// Otorga/extiende una suscripción y registra el pago en el historial.
function grant(username, days, plan, opts = {}) {
  const data = load();
  let sub = data.subscribers.find((s) => s.username === username);
  const now = new Date();
  const stillActive = sub && sub.expires_at && new Date(sub.expires_at) > now;
  const base = stillActive ? new Date(sub.expires_at) : now;
  const expires = new Date(base.getTime() + days * 86400000);

  if (!sub) {
    sub = {
      username, plan: plan || 'mensual', phone: opts.phone || '', banned: false,
      expires_at: expires.toISOString(), created_at: now.toISOString(), updated_at: now.toISOString(),
      history: [],
    };
    data.subscribers.push(sub);
  } else {
    sub.plan = plan || sub.plan || 'mensual';
    sub.expires_at = expires.toISOString();
    sub.updated_at = now.toISOString();
    if (opts.phone) sub.phone = opts.phone;
  }
  sub.history = sub.history || [];
  sub.history.push({ date: now.toISOString(), action: 'pago', days, plan: sub.plan, amount: opts.amount || 0 });
  save(data);
  return sub;
}

function revoke(username) {
  const data = load();
  const sub = data.subscribers.find((s) => s.username === username);
  if (!sub) return null;
  sub.expires_at = new Date(Date.now() - 1000).toISOString();
  sub.updated_at = new Date().toISOString();
  sub.history = sub.history || [];
  sub.history.push({ date: new Date().toISOString(), action: 'revocado', days: 0, plan: sub.plan, amount: 0 });
  save(data);
  return sub;
}

function setBanned(username, banned) {
  const data = load();
  const sub = data.subscribers.find((s) => s.username === username);
  if (!sub) return null;
  sub.banned = Boolean(banned);
  sub.updated_at = new Date().toISOString();
  sub.history = sub.history || [];
  sub.history.push({ date: new Date().toISOString(), action: banned ? 'baneado' : 'desbaneado', days: 0, plan: sub.plan, amount: 0 });
  save(data);
  return sub;
}

function setPhone(username, phone) {
  const data = load();
  const sub = data.subscribers.find((s) => s.username === username);
  if (!sub) return null;
  sub.phone = phone || '';
  sub.updated_at = new Date().toISOString();
  save(data);
  return sub;
}

module.exports = { list, getByUsername, grant, revoke, setBanned, setPhone };
