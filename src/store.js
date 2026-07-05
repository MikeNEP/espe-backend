// Almacén de suscriptores en un archivo JSON (la "plantilla").
// Guarda: usuario, teléfono, plan, vencimiento, baneo e historial de pagos.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'subscribers.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json'); // idempotencia de pagos

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ subscribers: [] }, null, 2));
}

// --- Helpers de fecha robustos (evitan NaN con datos corruptos) -----------
function toMs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// ¿La suscripción da acceso efectivo? (vigente y no baneada)
function isActive(sub) {
  if (!sub) return false;
  return toMs(sub.expires_at) > Date.now() && !sub.banned;
}

// ¿Está vigente la fecha, sin importar el baneo?
function isCurrent(sub) {
  return Boolean(sub) && toMs(sub.expires_at) > Date.now();
}

// Horas restantes (para pruebas de corta duración).
function hoursLeft(sub) {
  if (!sub) return 0;
  const ms = toMs(sub.expires_at) - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 3600000);
}

// ¿Es una prueba gratis?
function isTrial(sub) {
  return Boolean(sub) && sub.plan === 'prueba';
}

function load() {
  ensure();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(data.subscribers)) data.subscribers = [];
    // Normaliza registros antiguos para que tengan todos los campos.
    for (const s of data.subscribers) {
      if (s.phone == null) s.phone = '';
      if (s.banned == null) s.banned = false;
      if (s.screens == null) s.screens = 2;
      if (!Array.isArray(s.history)) s.history = [];
      // Umbrales de recordatorio ya enviados en el ciclo actual (se resetea al renovar).
      if (!Array.isArray(s.notified_thresholds)) s.notified_thresholds = [];
    }
    return data;
  } catch (e) {
    return { subscribers: [] };
  }
}

// Hook opcional que se ejecuta antes de sobrescribir el archivo (para backups).
let beforeSaveHook = null;
function setBeforeSaveHook(fn) {
  beforeSaveHook = typeof fn === 'function' ? fn : null;
}

function save(data) {
  ensure();
  if (beforeSaveHook) {
    try { beforeSaveHook(); } catch { /* no bloquear el guardado por un backup */ }
  }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE); // escritura atómica
}

function list() { return load().subscribers; }
function getByUsername(username) { return load().subscribers.find((s) => s.username === username) || null; }

// Núcleo: otorga/extiende acceso por una duración en milisegundos.
// `action` distingue un pago normal de una prueba en el historial.
function applyGrant(username, durationMs, plan, opts = {}, action = 'pago', extra = {}) {
  const data = load();
  let sub = data.subscribers.find((s) => s.username === username);
  const now = new Date();
  const stillActive = sub && toMs(sub.expires_at) > now.getTime();
  const base = stillActive ? new Date(sub.expires_at) : now;
  const expires = new Date(base.getTime() + durationMs);

  if (!sub) {
    sub = {
      username, plan: plan || 'mensual', phone: opts.phone || '', banned: false,
      screens: opts.screens || 2,
      expires_at: expires.toISOString(), created_at: now.toISOString(), updated_at: now.toISOString(),
      history: [], notified_thresholds: [],
    };
    data.subscribers.push(sub);
  } else {
    sub.plan = plan || sub.plan || 'mensual';
    sub.expires_at = expires.toISOString();
    sub.updated_at = now.toISOString();
    if (opts.phone) sub.phone = opts.phone;
    if (opts.screens) sub.screens = opts.screens;
  }
  sub.history = sub.history || [];
  sub.history.push({
    date: now.toISOString(), action, plan: sub.plan,
    amount: opts.amount || 0, source: opts.source || 'manual', ...extra,
  });
  // Al renovar se limpian los recordatorios ya enviados: podrá volver a avisar.
  sub.notified_thresholds = [];
  save(data);
  return sub;
}

// Otorga/extiende una suscripción por días y registra el pago en el historial.
function grant(username, days, plan, opts = {}) {
  return applyGrant(username, days * 86400000, plan, opts, 'pago', { days });
}

// Otorga una PRUEBA GRATIS por horas (plan 'prueba').
function grantHours(username, hours, opts = {}) {
  return applyGrant(username, hours * 3600000, 'prueba', opts, 'prueba', { hours });
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

function setScreens(username, screens) {
  const data = load();
  const sub = data.subscribers.find((s) => s.username === username);
  if (!sub) return null;
  sub.screens = Math.max(1, parseInt(screens, 10) || 2);
  sub.updated_at = new Date().toISOString();
  save(data);
  return sub;
}

// Marca que ya se envió el recordatorio del umbral `threshold` (días) al usuario.
function markThresholdNotified(username, threshold) {
  const data = load();
  const sub = data.subscribers.find((s) => s.username === username);
  if (!sub) return null;
  if (!Array.isArray(sub.notified_thresholds)) sub.notified_thresholds = [];
  if (!sub.notified_thresholds.includes(threshold)) {
    sub.notified_thresholds.push(threshold);
    save(data);
  }
  return sub;
}

// --- Idempotencia de pagos (para no procesar dos veces el mismo pago) ------
function loadPayments() {
  try { return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8')); } catch { return { ids: {} }; }
}
function hasProcessedPayment(id) {
  if (!id) return false;
  return Boolean(loadPayments().ids[String(id)]);
}
function markPaymentProcessed(id, meta = {}) {
  ensure();
  const data = loadPayments();
  data.ids[String(id)] = { at: new Date().toISOString(), ...meta };
  const tmp = PAYMENTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, PAYMENTS_FILE);
}

module.exports = {
  list, getByUsername, grant, grantHours, revoke, setBanned, setPhone, setScreens,
  isActive, isCurrent, isTrial, hoursLeft, toMs, markThresholdNotified,
  hasProcessedPayment, markPaymentProcessed, setBeforeSaveHook,
};
