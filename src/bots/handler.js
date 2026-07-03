// Lógica compartida de los bots de pedidos (Telegram y WhatsApp).
// Recibe un mensaje ya normalizado y devuelve el texto de respuesta.
// No sabe de qué plataforma viene: eso lo maneja cada bot.
const requests = require('../requests');
const settings = require('../settings');
const notifier = require('../notifier');
const logger = require('../logger');
const jellyfin = require('../jellyfin');

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

// Separa "!pedir Interestelar" -> { cmd: 'pedir', arg: 'Interestelar' }
function parse(text, prefix) {
  const t = (text || '').trim();
  if (!t.startsWith(prefix)) return null;
  const rest = t.slice(prefix.length).trim();
  const sp = rest.indexOf(' ');
  const cmd = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? '' : rest.slice(sp + 1).trim();
  return { cmd, arg };
}

function helpText(cfg) {
  const p = cfg.requests.prefix;
  const biz = cfg.business || 'ESPE Player';
  return (
    `🎬 *${biz}*\n\n` +
    `• ${p}pedir <título> — pide una película o serie\n` +
    `• ${p}recomendaciones — mira todo lo disponible (página web)\n` +
    `• ${p}nuevos — los últimos títulos agregados\n` +
    `• ${p}ayuda — muestra esta ayuda\n\n` +
    `Puedes pedir ${cfg.requests.maxPerWindow} título(s) cada ${cfg.requests.windowDays} días.`
  );
}

// Link por defecto para !recomendaciones si no se configura otro.
// JustWatch Ecuador: estrenos y catálogo mundial en español, con sinopsis y dónde ver.
const DEFAULT_RECOMMENDATIONS_URL = 'https://www.justwatch.com/ec';

// Link de la página de recomendaciones. Prioridad:
//   1) el que se ponga en el panel (Configuración → Link de recomendaciones)
//   2) la variable de entorno RECOMMENDATIONS_URL
//   3) el link por defecto (JustWatch Ecuador)
function recommendationsLink(cfg) {
  if (cfg.recommendationsUrl) return cfg.recommendationsUrl;
  if (process.env.RECOMMENDATIONS_URL) return process.env.RECOMMENDATIONS_URL;
  return DEFAULT_RECOMMENDATIONS_URL;
}

// Mensaje de los últimos agregados (comando !nuevos).
async function nuevosText(cfg) {
  const biz = cfg.business || 'ESPE Player';
  const p = cfg.requests.prefix;
  if (!jellyfin.configured()) return `Las novedades no están disponibles por el momento.`;
  try {
    const latest = await jellyfin.getLatest(10);
    if (!latest.length) return `Aún no hay novedades para mostrar.`;
    const items = latest.map((i) => `• ${i.name}${i.year ? ` (${i.year})` : ''}`).join('\n');
    return `🆕 *Últimos agregados a ${biz}:*\n${items}\n\nPídelos con ${p}pedir <título>.`;
  } catch (e) {
    logger.audit('catalog.error', { ok: false, error: e.message });
    return `No pude consultar las novedades ahora mismo. Intenta más tarde.`;
  }
}

// message: { platform, userId, userName, text }
// Devuelve { reply } o { reply: null } si no hay que responder.
async function handleMessage(message) {
  const cfg = settings.get();
  const prefix = cfg.requests.prefix || '!';
  const parsed = parse(message.text, prefix);
  if (!parsed) return { reply: null }; // no es un comando: lo ignoramos

  const biz = cfg.business || 'ESPE Player';

  if (parsed.cmd === 'ayuda' || parsed.cmd === 'help' || parsed.cmd === 'start') {
    return { reply: helpText(cfg) };
  }

  if (parsed.cmd === 'recomendaciones' || parsed.cmd === 'recomendacion' || parsed.cmd === 'recomienda') {
    const link = recommendationsLink(cfg);
    if (!link) {
      return { reply: 'La página de recomendaciones aún no está disponible. Pronto la tendrás 🙂' };
    }
    return {
      reply:
        `🍿 ¿No sabes qué pedir? Mira todo lo que hay en ${biz}:\n${link}\n\n` +
        `Cuando elijas, pídelo con ${prefix}pedir <título>.`,
    };
  }

  if (parsed.cmd === 'nuevos' || parsed.cmd === 'estrenos' || parsed.cmd === 'recientes') {
    return { reply: await nuevosText(cfg) };
  }

  if (parsed.cmd === 'pedir') {
    if (!cfg.requests.enabled) {
      return { reply: 'Los pedidos están desactivados por el momento. Intenta más tarde.' };
    }
    if (!parsed.arg) {
      return { reply: `Escribe el título después del comando.\nEjemplo: ${prefix}pedir Interestelar` };
    }
    const gate = requests.canRequest(
      message.platform, message.userId, cfg.requests.windowDays, cfg.requests.maxPerWindow,
    );
    if (!gate.ok) {
      return {
        reply:
          `Ya usaste tu pedido de este período 🙏\n` +
          `Podrás pedir de nuevo el ${fmtDate(gate.nextAt)}.`,
      };
    }
    const { request } = requests.add({
      platform: message.platform,
      userId: message.userId,
      userName: message.userName,
      title: parsed.arg,
    });
    logger.audit('request.new', { platform: message.platform, user: message.userName || message.userId, title: request.title });
    // Avisar al admin del nuevo pedido.
    notifier
      .notifyAdmin(`🎬 Nuevo pedido (${message.platform}) de ${message.userName || message.userId}: "${request.title}"`)
      .catch(() => {});
    return {
      reply: `✅ ¡Pedido recibido!\n"${request.title}"\nTe avisaremos cuando esté disponible en ${biz}.`,
    };
  }

  // Comando desconocido: mostramos ayuda breve.
  return { reply: `No reconozco ese comando. Escribe ${prefix}ayuda para ver las opciones.` };
}

module.exports = { handleMessage, parse, helpText, nuevosText, recommendationsLink };
