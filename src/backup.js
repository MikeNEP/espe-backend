// Backups automáticos rotativos de los archivos de datos (sin dependencias).
// Copia subscribers.json / settings.json a data/backups/ con fecha y hora,
// y elimina los más viejos según la retención configurada.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS, 10) || 14;
const FILES = ['subscribers.json', 'settings.json'];

function ensure() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Crea una copia de los archivos de datos existentes. `reason` queda en el nombre.
function backupNow(reason = 'auto') {
  ensure();
  const done = [];
  for (const name of FILES) {
    const src = path.join(DATA_DIR, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(BACKUP_DIR, `${name}.${stamp()}.${reason}.bak`);
    try {
      fs.copyFileSync(src, dest);
      done.push(dest);
    } catch (e) {
      /* ignora fallos puntuales de copia */
    }
  }
  cleanup();
  return done;
}

// Borra backups más viejos que KEEP_DAYS.
function cleanup() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    const full = path.join(BACKUP_DIR, f);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      /* ignora */
    }
  }
}

// Programa un backup diario. Devuelve el timer (unref para no bloquear salida).
function scheduleDaily() {
  const t = setInterval(() => backupNow('daily'), 24 * 60 * 60 * 1000);
  t.unref?.();
  return t;
}

function list() {
  ensure();
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

module.exports = { backupNow, scheduleDaily, cleanup, list };
