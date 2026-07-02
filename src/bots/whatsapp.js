// Bot de WhatsApp por webhook (WhatsApp Cloud API, sin dependencias).
// Los mensajes entrantes llegan a POST /api/v1/webhook/whatsapp.
// Verificación inicial del webhook por GET (hub.challenge) y firma de cada
// evento con X-Hub-Signature-256 usando WHATSAPP_APP_SECRET.
const crypto = require('crypto');
const handler = require('./handler');
const logger = require('../logger');

const TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

function enabled() {
  return Boolean(TOKEN && PHONE_ID);
}

// Verificación del webhook (Meta hace un GET con estos parámetros al configurarlo).
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

// Verifica la firma X-Hub-Signature-256 del cuerpo crudo.
function verifySignature(rawBody, signatureHeader) {
  if (!APP_SECRET) return { ok: true, skipped: true }; // sin secreto: no se puede verificar
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody || '').digest('hex');
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader || ''));
    return { ok };
  } catch {
    return { ok: false };
  }
}

async function sendMessage(to, text) {
  if (!enabled()) return false;
  const digits = String(to).replace(/[^0-9]/g, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: text } }),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Procesa el body del webhook (ya parseado) y responde a cada mensaje.
async function handleWebhook(body) {
  const results = [];
  try {
    const entries = body.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];
        for (const msg of value.messages || []) {
          if (msg.type !== 'text') continue;
          const from = msg.from; // número del usuario
          const profileName = (contacts.find((c) => c.wa_id === from) || {}).profile?.name || '';
          const result = await handler.handleMessage({
            platform: 'whatsapp',
            userId: from,
            userName: profileName || from,
            text: msg.text && msg.text.body,
          });
          if (result.reply) {
            await sendMessage(from, result.reply);
            results.push({ from, replied: true });
          }
        }
      }
    }
  } catch (e) {
    logger.audit('whatsapp.process', { ok: false, error: e.message });
  }
  return results;
}

module.exports = { enabled, verifyWebhook, verifySignature, handleWebhook, sendMessage };
