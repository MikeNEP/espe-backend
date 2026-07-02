// Bot de Telegram por long polling (sin dependencias, fetch nativo).
// No necesita URL pública: consulta getUpdates en un bucle. Ideal para VPS/hogar.
// Reusa TELEGRAM_BOT_TOKEN (el mismo bot que envía avisos de admin).
const handler = require('./handler');
const logger = require('../logger');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ENABLED = String(process.env.TELEGRAM_BOT_POLLING || 'false').toLowerCase() === 'true';

let offset = 0;
let running = false;

const api = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

async function call(method, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(api(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function sendMessage(chatId, text) {
  try {
    await call('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }, 10000);
    return true;
  } catch {
    return false;
  }
}

async function processUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const from = msg.from || {};
  const userName = from.username ? '@' + from.username : [from.first_name, from.last_name].filter(Boolean).join(' ');
  const result = await handler.handleMessage({
    platform: 'telegram',
    userId: from.id,
    userName: userName || String(from.id),
    text: msg.text,
  });
  if (result.reply) await sendMessage(msg.chat.id, result.reply);
}

async function loop() {
  while (running) {
    try {
      const data = await call('getUpdates', { offset, timeout: 50 }, 60000);
      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          try { await processUpdate(update); } catch (e) { logger.audit('telegram.process', { ok: false, error: e.message }); }
        }
      }
    } catch (e) {
      // Sin red o error transitorio: esperamos un poco y reintentamos (no crashea).
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function start() {
  if (!ENABLED || !TOKEN) return false;
  if (running) return true;
  running = true;
  loop();
  logger.audit('telegram.start', { ok: true });
  console.log('Bot de Telegram: long polling ACTIVO');
  return true;
}

function stop() { running = false; }

module.exports = { start, stop, sendMessage, enabled: () => ENABLED && Boolean(TOKEN) };
