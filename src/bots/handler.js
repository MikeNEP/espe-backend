// Lógica compartida de los bots de pedidos (Telegram y WhatsApp).
// Recibe un mensaje ya normalizado y devuelve el texto de respuesta.
// No sabe de qué plataforma viene: eso lo maneja cada bot.
const requests = require('../requests');
const settings = require('../settings');
const notifier = require('../notifier');
const logger = require('../logger');

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
    `🎬 *${biz}* — Pedidos\n\n` +
    `• ${p}pedir <título> — pide una película o serie\n` +
    `• ${p}cola — mira tu pedido y la cola\n` +
    `• ${p}ayuda — muestra esta ayuda\n\n` +
    `Puedes pedir ${cfg.requests.maxPerWindow} título(s) cada ${cfg.requests.windowDays} días.`
  );
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

  if (parsed.cmd === 'cola' || parsed.cmd === 'estado') {
    const mine = requests.pendingForUser(message.platform, message.userId);
    const totalPend = requests.stats().pendiente;
    if (mine.length === 0) {
      return { reply: `No tienes pedidos pendientes. Hay ${totalPend} en la cola.\nUsa ${prefix}pedir <título> para pedir uno.` };
    }
    const lines = mine.map((r) => `• "${r.title}" — puesto ${requests.queuePosition(r.id)} de ${totalPend}`);
    return { reply: `Tus pedidos pendientes:\n${lines.join('\n')}` };
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

module.exports = { handleMessage, parse, helpText };
