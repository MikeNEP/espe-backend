// Configuración del negocio (moneda y precios por plan).
// Se guarda en data/settings.json y se edita desde el panel.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  currency: '$',
  prices: { mensual: 0, trimestral: 0, anual: 0 },
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2));
}

function get() {
  ensure();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...data, prices: { ...DEFAULTS.prices, ...(data.prices || {}) } };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const cur = get();
  const next = { ...cur, ...patch };
  if (patch.prices) next.prices = { ...cur.prices, ...patch.prices };
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { get, save };
