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
    `• ${p}catalogo — mira qué hay disponible\n` +
    `• ${p}ayuda — muestra esta ayuda\n\n` +
    `Puedes pedir ${cfg.requests.maxPerWindow} título(s) cada ${cfg.requests.windowDays} días.`
  );
}

// Construye el mensaje del catálogo con datos de Jellyfin (si está configurado).
async function catalogText(cfg) {
  const biz = cfg.business || 'ESPE Player';
  const link = cfg.catalogUrl || process.env.CATALOG_URL || '';
  let body = `🎬 *Catálogo de ${biz}*\n`;
  try {
    if (jellyfin.configured()) {
      const c = await jellyfin.getCatalogSummary();
      body += `\n🎞️ Películas: ${c.movies}\n📺 Series: ${c.series}\n`;
      if (c.latest && c.latest.length) {
        const items = c.latest
          .map((i) => `• ${i.name}${i.year ? ` (${i.year})` : ''}`)
          .join('\n');
        body += `\n🆕 Últimos agregados:\n${items}\n`;
      }
    } else if (!link) {
      return `El catálogo no está disponible por el momento.`;
    }
  } catch (e) {
    logger.audit('catalog.error', { ok: false, error: e.message });
    if (!link) return `No pude consultar el catálogo ahora mismo. Intenta más tarde.`;
  }
  if (link) body += `\n👉 Explóralo aquí: ${link}`;
  const p = cfg.requests.prefix;
  body += `\n\nPide lo que quieras con ${p}pedir <título>.`;
  return body;
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

  if (parsed.cmd === 'catalogo' || parsed.cmd === 'catálogo' || parsed.cmd === 'catalog') {
    return { reply: await catalogText(cfg) };
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
    const { request, position } = requests.add({
      platform: message.platform,
      userId: message.userId,
      userName: message.userName,
      title: parsed.arg,
    });
    logger.audit('request.new', { platform: message.platform, user: message.userName || message.userId, title: request.title });
    // Avisar al admin del nuevo pedido.
    notifier
      .notifyAdmin(`🎬 Nuevo pedido (${message.platform}) de ${message.userName || message.userId}: "${request.title}" — puesto ${position} en la cola.`)
      .catch(() => {});
    return {
      reply:
        `✅ ¡Pedido recibido!\n"${request.title}"\n` +
        `Estás en el puesto ${position} de la cola. Te avisaremos cuando esté disponible en ${biz}.`,
    };
  }

  // Comando desconocido: mostramos ayuda breve.
  return { reply: `No reconozco ese comando. Escribe ${prefix}ayuda para ver las opciones.` };
}

module.exports = { handleMessage, parse, helpText, catalogText };
