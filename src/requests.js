// Pedidos de películas/series (sin dependencias).
// Los envían los usuarios por el bot con "!pedir <título>". Se guardan en
// data/requests.json. Si varios piden el MISMO título (pendiente), se AGRUPAN
// sumando votos en vez de duplicar, y la cola se ordena por más votados.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'requests.json');

const STATUS = ['pendiente', 'aprobado', 'cumplido', 'rechazado'];
const COUNTED = ['pendiente', 'aprobado', 'cumplido']; // cuentan para el límite

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
  fs.renameSync(tmp, FILE);
}

// Normaliza títulos para detectar duplicados (sin acentos, signos ni mayúsculas).
function normTitle(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const votesOf = (r) => (Array.isArray(r.voters) ? r.voters.length : 1);

// Momento en que un usuario participó en un pedido (como creador o votante).
function participationTime(r, platform, userId) {
  if (Array.isArray(r.voters)) {
    const v = r.voters.find((x) => x.platform === platform && x.userId === String(userId));
    if (v) return new Date(v.at).getTime() || 0;
  }
  if (r.platform === platform && r.userId === String(userId)) {
    return new Date(r.createdAt).getTime() || 0;
  }
  return null;
}

// ¿Puede pedir? Límite: maxPerWindow pedidos (o votos) por windowDays.
function canRequest(platform, userId, windowDays, maxPerWindow) {
  const since = Date.now() - windowDays * 86400000;
  const times = [];
  for (const r of load().requests) {
    if (!COUNTED.includes(r.status)) continue;
    const t = participationTime(r, platform, userId);
    if (t != null && t >= since) times.push(t);
  }
  if (times.length < maxPerWindow) return { ok: true };
  const oldest = Math.min(...times);
  return { ok: false, nextAt: oldest + windowDays * 86400000, count: times.length };
}

// ¿El usuario ya está en este pedido pendiente?
function userInRequest(r, platform, userId) {
  return participationTime(r, platform, userId) != null;
}

// Agrega un pedido o suma un voto si el título ya está pendiente.
// Devuelve { request, voted, votes, already }.
function add({ platform, userId, userName, title }) {
  const data = load();
  const nt = normTitle(title);
  const now = new Date().toISOString();
  const voter = { platform, userId: String(userId), userName: userName || '', at: now };

  const existing = data.requests.find((r) => r.status === 'pendiente' && normTitle(r.title) === nt);
  if (existing) {
    existing.voters = existing.voters || [
      { platform: existing.platform, userId: existing.userId, userName: existing.userName, at: existing.createdAt },
    ];
    if (userInRequest(existing, platform, userId)) {
      return { request: existing, voted: false, already: true, votes: votesOf(existing) };
    }
    existing.voters.push(voter);
    existing.updatedAt = now;
    save(data);
    return { request: existing, voted: true, votes: votesOf(existing) };
  }

  const req = {
    id: 'r' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    platform,
    userId: String(userId),
    userName: userName || '',
    title: String(title).slice(0, 300),
    status: 'pendiente',
    note: '',
    voters: [voter],
    createdAt: now,
    updatedAt: now,
  };
  data.requests.push(req);
  save(data);
  return { request: req, voted: false, votes: 1 };
}

// Cola de pendientes ordenada por votos (desc) y luego por antigüedad.
function queue() {
  return load()
    .requests.filter((r) => r.status === 'pendiente')
    .sort((a, b) => votesOf(b) - votesOf(a) || a.createdAt.localeCompare(b.createdAt));
}

function queuePosition(id) {
  const idx = queue().findIndex((r) => r.id === id);
  return idx === -1 ? 0 : idx + 1;
}

function list(filter = {}) {
  let rows = load().requests.slice();
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  if (filter.platform) rows = rows.filter((r) => r.platform === filter.platform);
  // Pendientes por votos; el resto por fecha reciente.
  rows.sort((a, b) => {
    if (a.status === 'pendiente' && b.status === 'pendiente') {
      return votesOf(b) - votesOf(a) || a.createdAt.localeCompare(b.createdAt);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
  return rows.map((r) => ({ ...r, votes: votesOf(r) }));
}

function pendingForUser(platform, userId) {
  return load()
    .requests.filter((r) => r.status === 'pendiente' && userInRequest(r, platform, userId));
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
  return { ...req, votes: votesOf(req) };
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
  STATUS, add, list, setStatus, canRequest, queue, queuePosition,
  pendingForUser, stats, votesOf, normTitle,
};
