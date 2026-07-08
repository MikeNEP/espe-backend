// Registro de uso por usuario para detectar cuentas compartidas (anti-abuso).
// Guarda, por suscriptor, las IPs/dispositivos observados en las sesiones de
// Jellyfin a lo largo del tiempo. Con eso podemos alertar cuando una misma
// cuenta se usa desde muchas ubicaciones distintas (señal de que la comparten
// más allá del límite de pantallas).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'usage.json');
const MAX_ENTRIES_PER_USER = 400; // tope para que el archivo no crezca sin fin
const RETENTION_DAYS = parseInt(process.env.USAGE_RETENTION_DAYS, 10) || 30;

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ users: {} }, null, 2));
}

function load() {
  ensure();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!data.users || typeof data.users !== 'object') data.users = {};
    return data;
  } catch {
    return { users: {} };
  }
}

function save(data) {
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE); // escritura atómica
}

// Normaliza el endpoint remoto a una IP "limpia" (sin puerto).
// Maneja IPv4 (1.2.3.4:port), IPv6 ([::1]:port) e IPv4-mapped (::ffff:1.2.3.4).
function cleanIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim();
  // ::ffff:1.2.3.4  -> 1.2.3.4
  const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/i);
  if (mapped) return mapped[1];
  // [ipv6]:port -> ipv6
  const bracket = ip.match(/^\[(.+)\](?::\d+)?$/);
  if (bracket) return bracket[1];
  // ipv4:port -> ipv4
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) return ip.split(':')[0];
  return ip;
}

// Registra un lote de sesiones (las que devuelve jellyfin.getSessions()).
function record(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return false;
  const data = load();
  const now = Date.now();
  for (const s of sessions) {
    const user = (s.userName || '').toLowerCase();
    const ip = cleanIp(s.remoteEndPoint);
    if (!user || !ip) continue;
    if (!Array.isArray(data.users[user])) data.users[user] = [];
    const arr = data.users[user];
    const key = ip + '|' + (s.deviceId || s.deviceName || '');
    const found = arr.find((e) => e.key === key);
    if (found) {
      found.at = now;
      found.hits = (found.hits || 1) + 1;
      if (s.deviceName) found.device = s.deviceName;
      if (s.client) found.client = s.client;
    } else {
      arr.push({ key, ip, device: s.deviceName || '', client: s.client || '', at: now, hits: 1 });
    }
    if (arr.length > MAX_ENTRIES_PER_USER) data.users[user] = arr.slice(-MAX_ENTRIES_PER_USER);
  }
  prune(data, now);
  save(data);
  return true;
}

// Elimina registros más viejos que la retención.
function prune(data, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86400000;
  for (const user of Object.keys(data.users)) {
    data.users[user] = (data.users[user] || []).filter((e) => e.at >= cutoff);
    if (data.users[user].length === 0) delete data.users[user];
  }
}

// Reporte de IPs distintas por usuario dentro de una ventana (en horas).
function report(windowHours = 24) {
  const data = load();
  const cutoff = Date.now() - windowHours * 3600000;
  const out = [];
  for (const [user, arr] of Object.entries(data.users)) {
    const recent = (arr || []).filter((e) => e.at >= cutoff);
    if (recent.length === 0) continue;
    const ipMap = new Map();
    for (const e of recent) {
      const cur = ipMap.get(e.ip) || { ip: e.ip, lastSeen: 0, devices: new Set() };
      cur.lastSeen = Math.max(cur.lastSeen, e.at);
      if (e.device) cur.devices.add(e.device);
      ipMap.set(e.ip, cur);
    }
    const ips = [...ipMap.values()]
      .map((x) => ({ ip: x.ip, lastSeen: new Date(x.lastSeen).toISOString(), devices: [...x.devices] }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    out.push({
      username: user,
      distinctIps: ips.length,
      lastSeen: ips[0] ? ips[0].lastSeen : null,
      ips,
    });
  }
  out.sort((a, b) => b.distinctIps - a.distinctIps);
  return out;
}

// Usuarios que superan el máximo de IPs distintas permitido en la ventana.
function flagged(maxIps = 3, windowHours = 24) {
  return report(windowHours).filter((r) => r.distinctIps > maxIps);
}

module.exports = { record, report, flagged, cleanIp };
