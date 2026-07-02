// Base de notificaciones (sin dependencias, usa fetch nativo de Node 18+).
//
// Proveedores soportados (se activan por .env, se pueden combinar con comas):
//   NOTIFY_PROVIDER=console            -> imprime en consola (por defecto)
//   NOTIFY_PROVIDER=telegram           -> avisos de admin por bot de Telegram
//   NOTIFY_PROVIDER=webhook            -> POST genérico a NOTIFY_WEBHOOK_URL
//   NOTIFY_PROVIDER=whatsapp           -> WhatsApp Cloud API (mensajes al usuario)
//
// Dos destinos:
//   notifyAdmin(text)      -> a vos (Telegram / webhook / consola)
//   notifyUser(sub, text)  -> al suscriptor (WhatsApp Cloud API si está configurado;
//                             si no, cae al admin con el link wa.me listo para enviar)
//
// Está pensado como BASE: los proveedores son funciones simples y podés
// agregar el tuyo (email, otro gateway de WhatsApp, etc.) en `PROVIDERS`.

const logger = require('./logger');

const PROVIDERS = (process.env.NOTIFY_PROVIDER || 'console')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || '';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';

const has = (p) => PROVIDERS.includes(p);
const onlyDigits = (s) => (s || '').replace(/[^0-9]/g, '');

async function postJson(url, body, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ---- Proveedores individuales --------------------------------------------
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await postJson(url, { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true });
  return res.ok;
}

async function sendGenericWebhook(payload) {
  if (!NOTIFY_WEBHOOK_URL) return false;
  const res = await postJson(NOTIFY_WEBHOOK_URL, payload);
  return res.ok;
}

async function sendWhatsApp(phone, text) {
  const to = onlyDigits(phone);
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID || !to) return false;
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;
  const res = await postJson(
    url,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  );
  return res.ok;
}

// ---- API pública ----------------------------------------------------------
// Aviso para el administrador (a vos).
async function notifyAdmin(text, meta = {}) {
  const results = {};
  try {
    if (has('console') || PROVIDERS.length === 0) {
      console.log('[NOTIFY:admin]', text);
      results.console = true;
    }
    if (has('telegram')) results.telegram = await sendTelegram(text);
    if (has('webhook')) results.webhook = await sendGenericWebhook({ kind: 'admin', text, ...meta });
  } catch (e) {
    logger.audit('notify.error', { ok: false, target: 'admin', error: e.message });
  }
  return results;
}

// Aviso para el suscriptor. Si no hay canal directo (WhatsApp Cloud),
// cae a avisar al admin con el link wa.me listo para enviar manualmente.
async function notifyUser(sub, text, meta = {}) {
  const results = {};
  let delivered = false;
  try {
    if (has('whatsapp') && sub && sub.phone) {
      results.whatsapp = await sendWhatsApp(sub.phone, text);
      delivered = delivered || results.whatsapp;
    }
    if (has('webhook')) {
      results.webhook = await sendGenericWebhook({
        kind: 'user', username: sub && sub.username, phone: sub && sub.phone, text, ...meta,
      });
      delivered = delivered || results.webhook;
    }
    // Fallback: si no se pudo entregar directo, avisamos al admin.
    if (!delivered) {
      const wa = sub && sub.phone ? ` (wa.me/${onlyDigits(sub.phone)})` : '';
      await notifyAdmin(`Recordar a ${sub ? sub.username : '?'}: ${text}${wa}`, meta);
      results.fallbackAdmin = true;
    }
  } catch (e) {
    logger.audit('notify.error', { ok: false, target: 'user', error: e.message });
  }
  return results;
}

function status() {
  return {
    providers: PROVIDERS,
    telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    webhook: Boolean(NOTIFY_WEBHOOK_URL),
    whatsapp: Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_ID),
  };
}

module.exports = { notifyAdmin, notifyUser, status };
