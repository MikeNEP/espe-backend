// Webhook de Mercado Pago (sin dependencias, usa fetch nativo).
//
// Flujo:
//   1) MP envía una notificación (topic "payment") a /api/v1/webhook/mercadopago
//   2) Verificamos la firma (x-signature) con MP_WEBHOOK_SECRET
//   3) Consultamos el pago real a la API de MP con MP_ACCESS_TOKEN
//   4) Si está "approved", resolvemos el usuario (metadata/external_reference)
//      y llamamos a grant() de forma idempotente (no procesa el mismo pago 2 veces)
//
// Convención para saber a quién acreditar (en orden de prioridad):
//   - metadata.username / metadata.plan / metadata.days
//   - external_reference: "username" o "username|plan"  (ej: "juan|mensual")
//
// Requiere en .env:
//   MP_ACCESS_TOKEN    (access token de tu cuenta/app de Mercado Pago)
//   MP_WEBHOOK_SECRET  (clave secreta de la firma, en el panel de MP)
const crypto = require('crypto');
const store = require('./store');
const settings = require('./settings');
const logger = require('./logger');
const notifier = require('./notifier');

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';

function configured() {
  return Boolean(MP_ACCESS_TOKEN);
}

// Verifica la firma del webhook según el esquema de Mercado Pago.
// Manifest: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
function verifySignature(req, dataId) {
  if (!MP_WEBHOOK_SECRET) return { ok: true, skipped: true }; // sin secreto: no se puede verificar
  const sig = req.headers['x-signature'] || '';
  const requestId = req.headers['x-request-id'] || '';
  const parts = {};
  String(sig)
    .split(',')
    .forEach((kv) => {
      const [k, v] = kv.split('=');
      if (k && v) parts[k.trim()] = v.trim();
    });
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return { ok: false, reason: 'firma incompleta' };

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const hmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(v1));
  } catch {
    ok = false;
  }
  return { ok, reason: ok ? undefined : 'firma inválida' };
}

// Consulta el detalle del pago a la API de Mercado Pago.
async function fetchPayment(paymentId) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`MP /payments devolvió ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// Resuelve username + plan + días a partir del pago.
function resolveTarget(payment) {
  const meta = payment.metadata || {};
  let username = (meta.username || '').toString().trim().toLowerCase();
  let plan = (meta.plan || '').toString().trim().toLowerCase();
  let days = parseInt(meta.days, 10) || 0;

  if (!username && payment.external_reference) {
    const [u, p] = String(payment.external_reference).split('|');
    username = (u || '').trim().toLowerCase();
    if (p) plan = p.trim().toLowerCase();
  }
  if (!plan) plan = 'mensual';
  if (!days) days = settings.daysForPlan(plan);
  return { username, plan, days };
}

// Punto de entrada del webhook. `dataId` = id del recurso (pago) notificado.
// Devuelve { status, ... } para responder al webhook.
async function handleNotification({ req, body, query }) {
  if (!configured()) {
    logger.audit('mp.webhook', { ok: false, reason: 'MP_ACCESS_TOKEN no configurado' });
    return { httpStatus: 200, status: 'ignored', reason: 'mp no configurado' };
  }

  // El id del pago llega por query (?data.id=) o en el body.
  const dataId =
    (query && (query['data.id'] || query.id)) ||
    (body && body.data && body.data.id) ||
    (body && body.id);
  const topic = (query && (query.type || query.topic)) || (body && body.type) || '';

  if (topic && topic !== 'payment') {
    return { httpStatus: 200, status: 'ignored', reason: `topic ${topic}` };
  }
  if (!dataId) {
    logger.audit('mp.webhook', { ok: false, reason: 'sin data.id' });
    return { httpStatus: 400, status: 'error', reason: 'falta data.id' };
  }

  const sig = verifySignature(req, dataId);
  if (!sig.ok) {
    logger.audit('mp.webhook', { ok: false, reason: sig.reason, dataId });
    return { httpStatus: 401, status: 'error', reason: sig.reason };
  }

  // Idempotencia: si ya procesamos este pago, respondemos OK sin duplicar.
  if (store.hasProcessedPayment(dataId)) {
    return { httpStatus: 200, status: 'duplicate', dataId };
  }

  let payment;
  try {
    payment = await fetchPayment(dataId);
  } catch (e) {
    logger.audit('mp.webhook', { ok: false, reason: e.message, dataId });
    // 500 hace que MP reintente más tarde (puede ser un problema transitorio).
    return { httpStatus: 500, status: 'error', reason: e.message };
  }

  if (payment.status !== 'approved') {
    logger.audit('mp.payment', { dataId, status: payment.status, ok: true });
    return { httpStatus: 200, status: 'not_approved', paymentStatus: payment.status };
  }

  const { username, plan, days } = resolveTarget(payment);
  if (!username) {
    logger.audit('mp.payment', { ok: false, reason: 'sin username (metadata/external_reference)', dataId });
    await notifier.notifyAdmin(`⚠️ Pago aprobado en MP sin usuario asociado (pago ${dataId}). Revisa manualmente.`);
    // Lo marcamos procesado para no repetir el aviso en cada reintento.
    store.markPaymentProcessed(dataId, { status: 'approved', unresolved: true });
    return { httpStatus: 200, status: 'unresolved' };
  }

  const amount = Number(payment.transaction_amount) || Number(settings.get().prices[plan]) || 0;
  const sub = store.grant(username, days, plan, { amount, source: 'mercadopago' });
  store.markPaymentProcessed(dataId, { username, plan, days, amount, status: 'approved' });
  logger.audit('mp.grant', { username, plan, days, amount, dataId, ok: true });
  await notifier.notifyAdmin(`✅ Pago aprobado: ${username} (+${days}d, ${plan}). Acceso renovado.`);

  return { httpStatus: 200, status: 'ok', username, plan, days, subscriber: sub };
}

module.exports = { configured, handleNotification, verifySignature, fetchPayment };
