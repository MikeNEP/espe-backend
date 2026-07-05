// Recordatorios de vencimiento (sin dependencias).
// Revisa periódicamente los suscriptores y avisa cuando faltan pocos días,
// sin reenviar el mismo umbral dos veces (se guarda en el suscriptor y se
// resetea al renovar). También manda un resumen al admin.
const store = require('./store');
const settings = require('./settings');
const notifier = require('./notifier');
const logger = require('./logger');

function daysLeft(expiresAt) {
  const ms = store.toMs(expiresAt) - Date.now();
  return Math.ceil(ms / 86400000);
}

function messageFor(sub, dleft) {
  const biz = settings.get().business || 'ESPE Player';
  if (dleft <= 0) {
    return `Hola ${sub.username}, tu suscripción a ${biz} venció. Renueva para seguir viendo el contenido. ¡Gracias!`;
  }
  const dias = dleft === 1 ? '1 día' : `${dleft} días`;
  return `Hola ${sub.username}, tu suscripción a ${biz} vence en ${dias}. Renueva para no perder el acceso. ¡Gracias!`;
}

// Ejecuta un ciclo de recordatorios. Devuelve un resumen de lo enviado.
async function runOnce() {
  const cfg = settings.get();
  const thresholds = (cfg.reminderDays || [7, 3, 1]).slice().sort((a, b) => b - a);
  const sent = [];

  for (const sub of store.list()) {
    if (sub.banned) continue;
    if (!store.isCurrent(sub)) continue; // ya venció: lo maneja el sync de Jellyfin
    const dleft = daysLeft(sub.expires_at);
    // El umbral más alto que ya se cumplió y todavía no fue avisado.
    const hit = thresholds.find(
      (t) => dleft <= t && !(sub.notified_thresholds || []).includes(t),
    );
    if (hit == null) continue;

    const text = messageFor(sub, dleft);
    await notifier.notifyUser(sub, text, { reason: 'reminder', daysLeft: dleft, threshold: hit });
    store.markThresholdNotified(sub.username, hit);
    sent.push({ username: sub.username, daysLeft: dleft, threshold: hit });
  }

  if (sent.length > 0) {
    logger.audit('reminders.sent', { count: sent.length, sent });
    const lines = sent.map((s) => `• ${s.username}: ${s.daysLeft}d`).join('\n');
    await notifier.notifyAdmin(`Recordatorios enviados (${sent.length}):\n${lines}`);
  }
  return { sent };
}

// Programa la corrida periódica (por defecto cada 6h).
function schedule(intervalHours = 6) {
  const t = setInterval(() => {
    runOnce().catch((e) => logger.audit('reminders.error', { ok: false, error: e.message }));
  }, intervalHours * 60 * 60 * 1000);
  t.unref?.();
  return t;
}

module.exports = { runOnce, schedule };
