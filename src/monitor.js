// Monitor de Jellyfin (sin dependencias).
// Hace ping periódico al servidor y, si deja de responder, avisa al admin por
// las notificaciones configuradas (Telegram/webhook/consola). Cuando vuelve, avisa también.
const jellyfin = require('./jellyfin');
const notifier = require('./notifier');
const logger = require('./logger');

const ENABLED = String(process.env.JELLYFIN_MONITOR || 'true').toLowerCase() === 'true';
const INTERVAL_MIN = parseInt(process.env.MONITOR_INTERVAL_MIN, 10) || 5;
const FAIL_THRESHOLD = parseInt(process.env.MONITOR_FAIL_THRESHOLD, 10) || 2;

const state = { up: true, fails: 0, notifiedDown: false, lastCheck: null };

async function tick() {
  if (!jellyfin.configured()) return;
  const ok = await jellyfin.ping();
  state.lastCheck = new Date().toISOString();

  if (ok) {
    if (state.notifiedDown) {
      await notifier.notifyAdmin('✅ Jellyfin volvió a responder. El servicio está operativo de nuevo.');
      logger.audit('monitor.up', { ok: true });
    }
    state.up = true;
    state.fails = 0;
    state.notifiedDown = false;
  } else {
    state.fails += 1;
    state.up = false;
    // Avisa una sola vez al superar el umbral (evita spam).
    if (state.fails >= FAIL_THRESHOLD && !state.notifiedDown) {
      await notifier.notifyAdmin(
        `⚠️ *Jellyfin no responde* (${state.fails} intentos fallidos). Revisa el servidor.`,
      );
      logger.audit('monitor.down', { ok: false, fails: state.fails });
      state.notifiedDown = true;
    }
  }
}

function schedule() {
  if (!ENABLED) return null;
  const t = setInterval(() => tick().catch(() => {}), INTERVAL_MIN * 60 * 1000);
  t.unref?.();
  // Primer chequeo a los 30s de arrancar (da tiempo a que todo levante).
  setTimeout(() => tick().catch(() => {}), 30 * 1000).unref?.();
  return t;
}

function status() {
  return { enabled: ENABLED, up: state.up, fails: state.fails, lastCheck: state.lastCheck };
}

module.exports = { schedule, tick, status };
