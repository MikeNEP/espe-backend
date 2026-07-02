// Pedidos de películas/series (sin dependencias).
// Los envían los usuarios por el bot de Telegram/WhatsApp con "!pedir <título>".
// Se guardan en data/requests.json con estado y forman una cola.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'requests.json');

// Estados posibles de un pedido.
const STATUS = ['pendiente', 'aprobado', 'cumplido', 'rechazado'];
// Estados que "cuentan" para el límite semanal (no penalizamos los rechazados).
const COUNTED = ['pendiente', 'aprobado', 'cumplido'];

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ requests: [] }, null, 2));
}

function load() {
  ensure();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(data.requests)) data.requests = [];
    return data;
  } catch {
    return { requests: [] };
  }
}

function save(data) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE); // escritura atómica
}

// ¿Cuándo fue el último pedido "que cuenta" de este usuario?
function lastCountedAt(platform, userId) {
  const mine = load().requests.filter(
    (r) => r.platform === platform && r.userId === String(userId) && COUNTED.includes(r.status),
  );
  if (mine.length === 0) return 0;
  return Math.max(...mine.map((r) => new Date(r.createdAt).getTime() || 0));
}

// ¿Puede pedir? Aplica el límite (maxPerWindow por windowDays).
function canRequest(platform, userId, windowDays, maxPerWindow) {
  const since = Date.now() - windowDays * 86400000;
  const mine = load().requests.filter(
    (r) =>
      r.platform === platform &&
      r.userId === String(userId) &&
      COUNTED.includes(r.status) &&
      (new Date(r.createdAt).getTime() || 0) >= since,
  );
  if (mine.length < maxPerWindow) return { ok: true };
  // Calcula cuándo se libera el cupo (cuando el más viejo salga de la ventana).
  const oldest = Math.min(...mine.map((r) => new Date(r.createdAt).getTime() || 0));
  const nextAt = oldest + windowDays * 86400000;
  return { ok: false, nextAt, count: mine.length };
}

// Agrega un pedido. Devuelve el pedido y su posición en la cola.
function add({ platform, userId, userName, title }) {
  const data = load();
  const req = {
    id: 'r' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    platform,
    userId: String(userId),
    userName: userName || '',
    title: String(title).slice(0, 300),
    status: 'pendiente',
    note: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.requests.push(req);
  save(data);
  return { request: req, position: queuePosition(req.id) };
}

// Posición del pedido dentro de la cola de pendientes (1 = próximo).
function queuePosition(id) {
  const pending = load()
    .requests.filter((r) => r.status === 'pendiente')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const idx = pending.findIndex((r) => r.id === id);
  return idx === -1 ? 0 : idx + 1;
}

function list(filter = {}) {
  let rows = load().requests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  if (filter.platform) rows = rows.filter((r) => r.platform === filter.platform);
  return rows;
}

// Pedidos pendientes de un usuario concreto.
function pendingForUser(platform, userId) {
  return load()
    .requests.filter(
      (r) => r.platform === platform && r.userId === String(userId) && r.status === 'pendiente',
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function setStatus(id, status, note) {
  if (!STATUS.includes(status)) return null;
  const data = load();
  const req = data.requests.find((r) => r.id === id);
  if (!req) return null;
  req.status = status;
  if (note != null) req.note = String(note).slice(0, 500);
  req.updatedAt = new Date().toISOString();
  save(data);
  return req;
}

function stats() {
  const rows = load().requests;
  return {
    total: rows.length,
    pendiente: rows.filter((r) => r.status === 'pendiente').length,
    aprobado: rows.filter((r) => r.status === 'aprobado').length,
    cumplido: rows.filter((r) => r.status === 'cumplido').length,
    rechazado: rows.filter((r) => r.status === 'rechazado').length,
  };
}

module.exports = {
  STATUS, add, list, setStatus, canRequest, queuePosition,
  pendingForUser, lastCountedAt, stats,
};
