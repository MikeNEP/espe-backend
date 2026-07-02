// Configuración del negocio (moneda, precios, planes y recordatorios).
// Se guarda en data/settings.json y se edita desde el panel.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  business: 'ESPE Player',
  currency: '$',
  prices: { mensual: 0, trimestral: 0, anual: 0 },
  // Días que dura cada plan (se usan para renovar y para Mercado Pago).
  planDays: { mensual: 30, trimestral: 90, anual: 365 },
  // A cuántos días del vencimiento se avisa al suscriptor.
  reminderDays: [7, 3, 1],
  // Bots de pedidos de películas/series (Telegram/WhatsApp).
  requests: {
    enabled: true,       // aceptar pedidos
    prefix: '!',         // prefijo de comandos (ej: !pedir)
    windowDays: 7,       // ventana del límite
    maxPerWindow: 1,     // pedidos permitidos por ventana y usuario
  },
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2));
}

function get() {
  ensure();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      ...DEFAULTS,
      ...data,
      prices: { ...DEFAULTS.prices, ...(data.prices || {}) },
      planDays: { ...DEFAULTS.planDays, ...(data.planDays || {}) },
      reminderDays: Array.isArray(data.reminderDays) ? data.reminderDays : DEFAULTS.reminderDays,
      requests: { ...DEFAULTS.requests, ...(data.requests || {}) },
    };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const cur = get();
  const next = { ...cur, ...patch };
  if (patch.prices) next.prices = { ...cur.prices, ...patch.prices };
  if (patch.planDays) next.planDays = { ...cur.planDays, ...patch.planDays };
  if (patch.reminderDays) {
    next.reminderDays = (Array.isArray(patch.reminderDays) ? patch.reminderDays : [])
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => b - a);
  }
  if (patch.requests) next.requests = { ...cur.requests, ...patch.requests };
  ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  return next;
}

// Días que dura un plan (con fallback a 30).
function daysForPlan(plan) {
  const cfg = get();
  return cfg.planDays[plan] || cfg.planDays.mensual || 30;
}

module.exports = { get, save, daysForPlan };
