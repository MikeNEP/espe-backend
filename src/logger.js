// Log de auditoría (sin dependencias).
// Escribe eventos en data/audit.log (formato JSON por línea, JSONL) y en consola.
// Sirve para saber quién/cuándo hizo cada acción admin y para depurar webhooks.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'audit.log');
const MAX_BYTES = parseInt(process.env.AUDIT_MAX_BYTES, 10) || 5 * 1024 * 1024; // 5 MB

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Rota el archivo si supera el tamaño máximo (guarda un .1 anterior).
function rotateIfNeeded() {
  try {
    const st = fs.statSync(FILE);
    if (st.size > MAX_BYTES) {
      fs.renameSync(FILE, FILE + '.1');
    }
  } catch {
    /* no existe todavía */
  }
}

// Registra un evento. `action` es una etiqueta corta; `details` un objeto libre.
function audit(action, details = {}) {
  ensure();
  rotateIfNeeded();
  const entry = { ts: new Date().toISOString(), action, ...details };
  try {
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    // No debe tumbar el servidor por un fallo de log.
  }
  const tag = details.ok === false ? 'WARN' : 'INFO';
  console.log(`[${tag}] ${action}`, JSON.stringify(details));
  return entry;
}

// Devuelve las últimas N líneas del log (para el panel).
function tail(limit = 200) {
  ensure();
  let content = '';
  try {
    content = fs.readFileSync(FILE, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    })
    .reverse();
}

module.exports = { audit, tail };
