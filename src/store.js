// Almacén de suscriptores en un archivo JSON (la "plantilla").
// Simple, sin dependencias y legible/editable a mano.
// Para escalar a futuro se puede migrar a SQLite o Postgres sin cambiar la API.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'subscribers.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ subscribers: [] }, null, 2));
  }
}

function load() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return { subscribers: [] };
  }
}

// Guardado atómico (escribe a un .tmp y luego renombra) para no corromper el archivo.
function save(data) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function list() {
  return load().subscribers;
}

function getByUsername(username) {
  return load().subscribers.find((s) => s.username === username) || null;
}

// Otorga (o extiende) una suscripción por X días.
// Si el usuario sigue activo, suma los días sobre la fecha de vencimiento actual.
function grant(username, days, plan) {
  const data = load();
  let sub = data.subscribers.find((s) => s.username === username);
  const now = new Date();
  const stillActive = sub && sub.expires_at && new Date(sub.expires_at) > now;
  const base = stillActive ? new Date(sub.expires_at) : now;
  const expires = new Date(base.getTime() + days * 86400000);

  if (!sub) {
    sub = {
      username,
      plan: plan || 'mensual',
      expires_at: expires.toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    data.subscribers.push(sub);
  } else {
    sub.plan = plan || sub.plan || 'mensual';
    sub.expires_at = expires.toISOString();
    sub.updated_at = now.toISOString();
  }
  save(data);
  return sub;
}

// Revoca: deja la suscripción como vencida (fecha en el pasado).
function revoke(username) {
  const data = load();
  const sub = data.subscribers.find((s) => s.username === username);
  if (!sub) return null;
  sub.expires_at = new Date(Date.now() - 1000).toISOString();
  sub.updated_at = new Date().toISOString();
  save(data);
  return sub;
}

module.exports = { list, getByUsername, grant, revoke };
