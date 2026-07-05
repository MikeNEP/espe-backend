// ESPE Player - Backend de suscripciones
// Node.js puro, sin dependencias. Corre con: node src/server.js
require('./loadEnv'); // carga variables desde el archivo .env si existe
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const nodePath = require('path');
const { URL } = require('url');
const store = require('./store');
const jellyfin = require('./jellyfin');
const settings = require('./settings');
const security = require('./security');
const logger = require('./logger');
const backup = require('./backup');
const notifier = require('./notifier');
const reminders = require('./reminders');
const mercadopago = require('./mercadopago');
const requests = require('./requests');
const telegramBot = require('./bots/telegram');
const whatsappBot = require('./bots/whatsapp');
const monitor = require('./monitor');

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'cambia-esta-clave-admin';
const APP_KEY = process.env.APP_KEY || ''; // opcional: clave que envía la app
const APP_HMAC_SECRET = process.env.APP_HMAC_SECRET || ''; // opcional: firma la respuesta
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES, 10) || 64 * 1024; // 64 KB

// Caché en memoria del catálogo (para la página pública de recomendaciones).
const CATALOG_TTL_MS = parseInt(process.env.CATALOG_TTL_MS, 10) || 10 * 60 * 1000; // 10 min
let catalogCache = { data: null, at: 0 };

// Último estado (habilitado/deshabilitado) aplicado en Jellyfin por usuario,
// para que el sweep periódico solo actúe cuando algo cambia.
const appliedEnabled = new Map();

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function daysLeft(expiresAt) {
  const ms = store.toMs(expiresAt) - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// --- Vistas -----------------------------------------------------------------
// Vista ADMIN: incluye todo (teléfono, historial, pantallas, baneo).
function adminView(sub) {
  const subActive = store.isCurrent(sub);
  const banned = Boolean(sub && sub.banned);
  return {
    username: sub ? sub.username : null,
    active: subActive && !banned,
    subActive,
    banned,
    status: !sub ? 'inexistente' : banned ? 'baneado' : subActive ? 'activo' : 'vencido',
    plan: sub ? sub.plan : null,
    is_trial: store.isTrial(sub),
    phone: sub ? sub.phone || '' : '',
    screens: sub ? sub.screens || 2 : 2,
    expires_at: sub ? sub.expires_at : null,
    days_left: sub ? daysLeft(sub.expires_at) : 0,
    hours_left: sub ? store.hoursLeft(sub) : 0,
    history: sub ? sub.history || [] : [],
  };
}

// Vista PÚBLICA (la que consume la app): SOLO lo necesario.
// No expone teléfono, historial ni datos internos.
function publicView(sub) {
  const subActive = store.isCurrent(sub);
  const banned = Boolean(sub && sub.banned);
  const active = subActive && !banned;
  const status = !sub ? 'inexistente' : banned ? 'baneado' : subActive ? 'activo' : 'vencido';
  const dleft = sub ? daysLeft(sub.expires_at) : 0;
  const biz = settings.get().business || 'ESPE Player';
  const messages = {
    activo: dleft <= 7 ? `Tu suscripción vence en ${dleft} día(s).` : 'Suscripción activa.',
    vencido: `Tu suscripción a ${biz} venció. Renueva para seguir viendo.`,
    baneado: 'Tu cuenta está suspendida. Contacta al administrador.',
    inexistente: 'No encontramos una suscripción para este usuario.',
  };
  const payload = {
    username: sub ? sub.username : null,
    active,
    status,
    plan: sub ? sub.plan : null,
    expires_at: sub ? sub.expires_at : null,
    days_left: dleft,
    message: messages[status],
    business: biz,
  };
  // Firma HMAC opcional: la app puede verificar que la respuesta es auténtica.
  if (APP_HMAC_SECRET) {
    const ts = Date.now();
    const canonical = `${payload.username || ''}|${active}|${payload.expires_at || ''}|${ts}`;
    payload.ts = ts;
    payload.signature = crypto.createHmac('sha256', APP_HMAC_SECRET).update(canonical).digest('hex');
  }
  return payload;
}

// Sincroniza la cuenta en Jellyfin según el acceso efectivo del suscriptor.
async function syncJellyfin(sub) {
  if (!jellyfin.configured() || !sub) return;
  const enabled = store.isActive(sub);
  const screens = parseInt(sub.screens, 10) || 2;
  try {
    await jellyfin.setDisabled(sub.username, !enabled, screens);
    appliedEnabled.set(sub.username, enabled);
  } catch (e) {
    logger.audit('jellyfin.sync', { ok: false, username: sub.username, error: e.message });
  }
}

// Avisa del cambio de estado a TODOS los que pidieron/votaron ese título.
async function notifyRequestUser(reqItem) {
  const biz = settings.get().business || 'ESPE Player';
  const t = reqItem.title;
  const msgs = {
    aprobado: `👍 Tu pedido "${t}" fue aprobado. Lo agregaremos pronto a ${biz}.`,
    cumplido: `🎉 ¡Listo! "${t}" ya está disponible en ${biz}. ¡Disfrútalo!`,
    rechazado: `😕 Tu pedido "${t}" no pudo aceptarse${reqItem.note ? ': ' + reqItem.note : '.'}`,
  };
  const text = msgs[reqItem.status];
  if (!text) return;
  // Lista de destinatarios: los votantes, o el creador si no hay votantes.
  const targets = Array.isArray(reqItem.voters) && reqItem.voters.length
    ? reqItem.voters
    : [{ platform: reqItem.platform, userId: reqItem.userId }];
  for (const tg of targets) {
    try {
      if (tg.platform === 'telegram' && telegramBot.enabled()) await telegramBot.sendMessage(tg.userId, text);
      else if (tg.platform === 'whatsapp' && whatsappBot.enabled()) await whatsappBot.sendMessage(tg.userId, text);
    } catch (e) { /* seguir con el resto */ }
  }
}

// Lee el body con límite de tamaño (evita abusos de memoria).
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        return resolve({ __tooLarge: true });
      }
      b += c;
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
    req.on('error', () => { if (!aborted) resolve({}); });
  });
}

// Lee el body como texto crudo (para verificar firmas de webhooks).
function readRaw(req) {
  return new Promise((resolve) => {
    let b = '';
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { done = true; return resolve(b); }
      b += c;
    });
    req.on('end', () => { if (!done) { done = true; resolve(b); } });
    req.on('error', () => { if (!done) { done = true; resolve(b); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;
  const ip = security.clientIp(req);

  security.applyCors(req, res);
  security.applySecurityHeaders(res);
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Health check
  if (method === 'GET' && (path === '/' || path === '/health')) {
    return json(res, 200, {
      service: 'espe-backend',
      ok: true,
      jellyfin: jellyfin.configured(),
      mercadopago: mercadopago.configured(),
      notifications: notifier.status(),
      bots: { telegram: telegramBot.enabled(), whatsapp: whatsappBot.enabled() },
      monitor: monitor.status(),
    });
  }

  // Panel de administración web (interfaz bonita)
  if (method === 'GET' && (path === '/admin' || path === '/admin/')) {
    try {
      const html = fs.readFileSync(nodePath.join(__dirname, '..', 'public', 'admin.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      return json(res, 500, { error: 'no se pudo cargar el panel de administración' });
    }
  }

  // Página pública de catálogo/recomendaciones (para el comando !recomendaciones)
  if (method === 'GET' && (path === '/catalogo' || path === '/catalogo/' || path === '/recomendaciones')) {
    try {
      const html = fs.readFileSync(nodePath.join(__dirname, '..', 'public', 'catalog.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      return json(res, 500, { error: 'no se pudo cargar el catálogo' });
    }
  }

  // API pública del catálogo (con caché en memoria para no saturar Jellyfin)
  if (method === 'GET' && path === '/api/v1/public/catalog') {
    const rl = security.rateLimit(`cat:${ip}`, 60, 60 * 1000);
    if (!rl.allowed) return json(res, 429, { error: 'demasiadas solicitudes' });
    if (!jellyfin.configured()) {
      return json(res, 200, { business: settings.get().business, movies: [], series: [], available: false });
    }
    const now = Date.now();
    if (catalogCache.data && now - catalogCache.at < CATALOG_TTL_MS) {
      return json(res, 200, catalogCache.data);
    }
    try {
      const cat = await jellyfin.getFullCatalog();
      const data = { business: settings.get().business, available: true, ...cat };
      catalogCache = { data, at: now };
      return json(res, 200, data);
    } catch (e) {
      logger.audit('catalog.error', { ok: false, error: e.message });
      if (catalogCache.data) return json(res, 200, catalogCache.data); // sirve lo último bueno
      return json(res, 502, { error: 'no se pudo leer el catálogo', available: false });
    }
  }

  // Proxy de pósters (evita exponer la API key de Jellyfin en el navegador)
  if (method === 'GET' && path.startsWith('/catalogo/img/')) {
    const id = path.slice('/catalogo/img/'.length);
    if (!/^[a-f0-9]{16,40}$/i.test(id)) return json(res, 400, { error: 'id inválido' });
    try {
      const img = await jellyfin.fetchImage(id);
      if (!img) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=86400' });
      return res.end(img.buf);
    } catch (e) {
      res.writeHead(502);
      return res.end();
    }
  }

  // === Webhook de Mercado Pago (público, verificado por firma) ===
  if (method === 'POST' && path === '/api/v1/webhook/mercadopago') {
    const rl = security.rateLimit(`mp:${ip}`, 60, 60 * 1000); // 60/min por IP
    if (!rl.allowed) return json(res, 429, { error: 'demasiadas solicitudes' });
    const raw = await readRaw(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const query = Object.fromEntries(url.searchParams.entries());
    const result = await mercadopago.handleNotification({ req, body, query });
    const { httpStatus, ...rest } = result;
    return json(res, httpStatus || 200, rest);
  }

  // === Webhook de WhatsApp (bot de pedidos) ===
  // GET: verificación del webhook (Meta). POST: mensajes entrantes.
  if (path === '/api/v1/webhook/whatsapp') {
    if (method === 'GET') {
      const query = Object.fromEntries(url.searchParams.entries());
      const v = whatsappBot.verifyWebhook(query);
      if (v.ok) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(String(v.challenge || ''));
      }
      return json(res, 403, { error: 'verificación fallida' });
    }
    if (method === 'POST') {
      const rl = security.rateLimit(`wa:${ip}`, 120, 60 * 1000);
      if (!rl.allowed) return json(res, 429, { error: 'demasiadas solicitudes' });
      const raw = await readRaw(req);
      const sig = whatsappBot.verifySignature(raw, req.headers['x-hub-signature-256']);
      if (!sig.ok) {
        logger.audit('whatsapp.webhook', { ok: false, reason: 'firma inválida' });
        return json(res, 401, { error: 'firma inválida' });
      }
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      // Respondemos 200 rápido y procesamos (Meta reintenta si tardamos).
      json(res, 200, { received: true });
      whatsappBot.handleWebhook(body).catch((e) => logger.audit('whatsapp.webhook', { ok: false, error: e.message }));
      return;
    }
  }

  // === Estado de suscripción (lo consulta la app ESPE Player tras el login) ===
  // GET /api/v1/status?username=juan   (alias: /api/v1/app/status)
  if (method === 'GET' && (path === '/api/v1/status' || path === '/api/v1/app/status')) {
    const rl = security.rateLimit(`status:${ip}`, 120, 60 * 1000); // 120/min por IP
    if (!rl.allowed) return json(res, 429, { error: 'demasiadas solicitudes' });
    if (APP_KEY && !security.safeCompare(req.headers['x-app-key'], APP_KEY)) {
      return json(res, 401, { error: 'app key inválida' });
    }
    const username = (url.searchParams.get('username') || '').trim().toLowerCase();
    if (!username) return json(res, 400, { error: 'falta el parámetro username' });
    return json(res, 200, publicView(store.getByUsername(username)));
  }

  // === Rutas de administración (requieren cabecera x-admin-key) ===
  if (path.startsWith('/api/v1/admin/')) {
    // Guarda general (anti-DoS): límite generoso para uso legítimo del panel.
    const overall = security.rateLimit(`admin_all:${ip}`, 240, 60 * 1000);
    if (!overall.allowed) {
      res.setHeader('Retry-After', Math.ceil(overall.retryAfterMs / 1000));
      return json(res, 429, { error: 'demasiadas solicitudes, espera un momento' });
    }
    // Verificación de clave en tiempo constante (anti timing attack).
    if (!security.safeCompare(req.headers['x-admin-key'], ADMIN_KEY)) {
      // Anti fuerza-bruta: solo los intentos FALLIDOS se limitan (10/min por IP).
      const fails = security.rateLimit(`admin_fail:${ip}`, 10, 60 * 1000);
      logger.audit('admin.auth_fail', { ok: false, ip, path });
      if (!fails.allowed) {
        res.setHeader('Retry-After', Math.ceil(fails.retryAfterMs / 1000));
        return json(res, 429, { error: 'demasiados intentos fallidos, espera un momento' });
      }
      return json(res, 401, { error: 'admin key inválida' });
    }

    // Listar todos los suscriptores (la "plantilla")
    if (method === 'GET' && path === '/api/v1/admin/subscribers') {
      return json(res, 200, { subscribers: store.list().map(adminView) });
    }

    // Configuración del negocio (moneda + precios + planes + recordatorios)
    if (method === 'GET' && path === '/api/v1/admin/settings') {
      return json(res, 200, settings.get());
    }
    if (method === 'POST' && path === '/api/v1/admin/settings') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const patch = {};
      if (typeof body.business === 'string' && body.business.trim()) patch.business = body.business.trim();
      if (typeof body.currency === 'string' && body.currency.trim()) patch.currency = body.currency.trim();
      if (typeof body.recommendationsUrl === 'string') patch.recommendationsUrl = body.recommendationsUrl.trim();
      if (body.prices && typeof body.prices === 'object') {
        patch.prices = {};
        for (const k of ['mensual', 'trimestral', 'anual']) {
          if (body.prices[k] != null) patch.prices[k] = Number(body.prices[k]) || 0;
        }
      }
      if (body.planDays && typeof body.planDays === 'object') {
        patch.planDays = {};
        for (const k of ['mensual', 'trimestral', 'anual']) {
          if (body.planDays[k] != null) patch.planDays[k] = parseInt(body.planDays[k], 10) || 0;
        }
      }
      if (Array.isArray(body.reminderDays)) patch.reminderDays = body.reminderDays;
      if (body.trialHours != null) patch.trialHours = Math.max(1, parseInt(body.trialHours, 10) || 2);
      if (body.requests && typeof body.requests === 'object') {
        patch.requests = {};
        if (body.requests.enabled != null) patch.requests.enabled = Boolean(body.requests.enabled);
        if (typeof body.requests.prefix === 'string' && body.requests.prefix.trim()) patch.requests.prefix = body.requests.prefix.trim().slice(0, 3);
        if (body.requests.windowDays != null) patch.requests.windowDays = Math.max(1, parseInt(body.requests.windowDays, 10) || 7);
        if (body.requests.maxPerWindow != null) patch.requests.maxPerWindow = Math.max(1, parseInt(body.requests.maxPerWindow, 10) || 1);
      }
      const saved = settings.save(patch);
      logger.audit('settings.update', { ip, patch });
      return json(res, 200, saved);
    }

    // Log de auditoría (últimas N líneas)
    if (method === 'GET' && path === '/api/v1/admin/audit') {
      const limit = Math.min(1000, parseInt(url.searchParams.get('limit'), 10) || 200);
      return json(res, 200, { entries: logger.tail(limit) });
    }

    // Backups: listar / crear ahora
    if (method === 'GET' && path === '/api/v1/admin/backups') {
      return json(res, 200, { backups: backup.list() });
    }
    if (method === 'POST' && path === '/api/v1/admin/backups') {
      const done = backup.backupNow('manual');
      logger.audit('backup.manual', { ip, count: done.length });
      return json(res, 200, { created: done.length, backups: backup.list() });
    }

    // Notificaciones: estado / prueba / correr recordatorios ahora
    if (method === 'GET' && path === '/api/v1/admin/notify/status') {
      return json(res, 200, notifier.status());
    }
    if (method === 'POST' && path === '/api/v1/admin/notify/test') {
      const r = await notifier.notifyAdmin('🔔 Prueba de notificación desde ESPE Player backend.');
      logger.audit('notify.test', { ip, result: r });
      return json(res, 200, { sent: r });
    }
    if (method === 'POST' && path === '/api/v1/admin/reminders/run') {
      const r = await reminders.runOnce();
      return json(res, 200, r);
    }

    // Estado de los bots de pedidos
    if (method === 'GET' && path === '/api/v1/admin/bots/status') {
      return json(res, 200, {
        telegram: telegramBot.enabled(),
        whatsapp: whatsappBot.enabled(),
        config: settings.get().requests,
      });
    }

    // Pedidos de películas/series (bot)
    if (method === 'GET' && path === '/api/v1/admin/requests') {
      const status = url.searchParams.get('status') || undefined;
      const platform = url.searchParams.get('platform') || undefined;
      return json(res, 200, { requests: requests.list({ status, platform }), stats: requests.stats() });
    }
    // Cambiar estado de un pedido (aprobar/rechazar/cumplido) y avisar al usuario
    if (method === 'POST' && path === '/api/v1/admin/requests/status') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const id = (body.id || '').trim();
      const status = (body.status || '').trim();
      if (!id || !requests.STATUS.includes(status)) {
        return json(res, 400, { error: 'id y status válidos son requeridos' });
      }
      const updated = requests.setStatus(id, status, body.note);
      if (!updated) return json(res, 404, { error: 'pedido no encontrado' });
      logger.audit('request.status', { ip, id, status });
      // Notificar al usuario del cambio (por su misma plataforma).
      notifyRequestUser(updated).catch(() => {});
      return json(res, 200, updated);
    }

    // Crear cuenta en Jellyfin + suscripción en un paso
    if (method === 'POST' && path === '/api/v1/admin/create') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const username = (body.username || '').trim().toLowerCase();
      const days = parseInt(body.days, 10) || 30;
      const plan = body.plan || 'mensual';
      if (!username) return json(res, 400, { error: 'username requerido' });
      if (!/^[a-z0-9._-]{1,64}$/.test(username)) {
        return json(res, 400, { error: 'username inválido (usa letras, números, . _ -)' });
      }

      if (jellyfin.configured()) {
        try {
          await jellyfin.createUser(username, body.password || '');
        } catch (e) {
          return json(res, 400, { error: 'Jellyfin: ' + e.message });
        }
      }
      let amount = Number(body.amount);
      if (!amount) amount = Number(settings.get().prices[plan]) || 0;
      const screens = parseInt(body.screens, 10) || 2;
      const sub = store.grant(username, days, plan, { phone: body.phone, amount, screens, source: 'manual' });
      await syncJellyfin(sub);
      logger.audit('admin.create', { ip, username, days, plan });
      return json(res, 200, adminView(sub));
    }

    // Otorgar una PRUEBA GRATIS por horas (con creación opcional en Jellyfin)
    if (method === 'POST' && path === '/api/v1/admin/trial') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const username = (body.username || '').trim().toLowerCase();
      const hours = parseInt(body.hours, 10) || settings.get().trialHours || 2;
      if (!username) return json(res, 400, { error: 'username requerido' });
      if (!/^[a-z0-9._-]{1,64}$/.test(username)) {
        return json(res, 400, { error: 'username inválido (usa letras, números, . _ -)' });
      }
      if (hours <= 0 || hours > 720) {
        return json(res, 400, { error: 'las horas deben estar entre 1 y 720' });
      }
      if (body.create && jellyfin.configured()) {
        try {
          await jellyfin.createUser(username, body.password || '');
        } catch (e) {
          return json(res, 400, { error: 'Jellyfin: ' + e.message });
        }
      }
      const screens = parseInt(body.screens, 10) || 2;
      const sub = store.grantHours(username, hours, { phone: body.phone, screens, source: 'manual' });
      await syncJellyfin(sub);
      logger.audit('admin.trial', { ip, username, hours });
      return json(res, 200, adminView(sub));
    }

    // Otorgar/extender suscripción
    if (method === 'POST' && path === '/api/v1/admin/grant') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const username = (body.username || '').trim().toLowerCase();
      const days = parseInt(body.days, 10);
      if (!username || !days || days <= 0) {
        return json(res, 400, { error: 'username y days (>0) son requeridos' });
      }
      const plan = body.plan || 'mensual';
      let amount = Number(body.amount);
      if (!amount) amount = Number(settings.get().prices[plan]) || 0;
      const screens = parseInt(body.screens, 10) || 2;
      const sub = store.grant(username, days, plan, { phone: body.phone, amount, screens, source: 'manual' });
      await syncJellyfin(sub);
      logger.audit('admin.grant', { ip, username, days, plan, amount });
      return json(res, 200, adminView(sub));
    }

    // Revocar suscripción
    if (method === 'POST' && path === '/api/v1/admin/revoke') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return json(res, 400, { error: 'username requerido' });
      const sub = store.revoke(username);
      if (!sub) return json(res, 404, { error: 'el usuario no existe' });
      await syncJellyfin(sub);
      logger.audit('admin.revoke', { ip, username });
      return json(res, 200, adminView(sub));
    }

    // Banear / desbanear
    if (method === 'POST' && path === '/api/v1/admin/ban') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return json(res, 400, { error: 'username requerido' });
      const sub = store.setBanned(username, body.banned !== false);
      if (!sub) return json(res, 404, { error: 'el usuario no existe' });
      await syncJellyfin(sub);
      logger.audit('admin.ban', { ip, username, banned: body.banned !== false });
      return json(res, 200, adminView(sub));
    }

    // Actualizar teléfono
    if (method === 'POST' && path === '/api/v1/admin/phone') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return json(res, 400, { error: 'username requerido' });
      const sub = store.setPhone(username, (body.phone || '').trim());
      if (!sub) return json(res, 404, { error: 'el usuario no existe' });
      return json(res, 200, adminView(sub));
    }

    // Actualizar pantallas simultáneas
    if (method === 'POST' && path === '/api/v1/admin/screens') {
      const body = await readBody(req);
      if (body.__tooLarge) return json(res, 413, { error: 'payload demasiado grande' });
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return json(res, 400, { error: 'username requerido' });
      const sub = store.setScreens(username, body.screens);
      if (!sub) return json(res, 404, { error: 'el usuario no existe' });
      await syncJellyfin(sub);
      return json(res, 200, adminView(sub));
    }

    return json(res, 404, { error: 'ruta de admin no encontrada' });
  }

  json(res, 404, { error: 'no encontrado' });
});

// Tarea periódica (cada 12h): deshabilita en Jellyfin las cuentas vencidas.
// Es la red de seguridad del "candado".
// Sweep inteligente: recorre a todos y SOLO aplica cambios de estado en Jellyfin
// (así una prueba de pocas horas se deshabilita a tiempo sin recargar el servidor).
function syncSweep(force = false) {
  if (!jellyfin.configured()) return;
  for (const sub of store.list()) {
    const enabled = store.isActive(sub);
    const prev = appliedEnabled.get(sub.username);
    if (!force && prev === enabled) continue; // sin cambios: no tocar Jellyfin
    const screens = parseInt(sub.screens, 10) || 2;
    jellyfin
      .setDisabled(sub.username, !enabled, screens)
      .then(() => appliedEnabled.set(sub.username, enabled))
      .catch((e) => logger.audit('jellyfin.sync', { ok: false, username: sub.username, error: e.message }));
  }
}

// --- Arranque ---------------------------------------------------------------
// Backup automático antes de cada escritura de suscriptores + backup diario.
store.setBeforeSaveHook(() => backup.backupNow('presave'));
backup.scheduleDaily();
reminders.schedule(6); // recordatorios cada 6h
setInterval(() => syncSweep(false), 5 * 60 * 1000); // revisa vencimientos/pruebas cada 5 min
setTimeout(() => syncSweep(true), 3000); // sincronización completa al arrancar
telegramBot.start(); // bot de pedidos por long polling (si está habilitado)
monitor.schedule(); // monitor de caídas de Jellyfin (avisa por Telegram)

// Aviso si la clave admin quedó por defecto (riesgo de seguridad).
if (ADMIN_KEY === 'cambia-esta-clave-admin') {
  console.warn('⚠️  ADMIN_KEY está en su valor por defecto. ¡Cámbiala en .env!');
}

server.listen(PORT, () => {
  console.log(`espe-backend escuchando en el puerto ${PORT}`);
  console.log(`Jellyfin ${jellyfin.configured() ? 'CONFIGURADO' : 'no configurado (modo MVP)'}`);
  console.log(`Mercado Pago ${mercadopago.configured() ? 'CONFIGURADO' : 'no configurado'}`);
  console.log(`Notificaciones: ${notifier.status().providers.join(', ') || 'console'}`);
  console.log(`Bots -> Telegram: ${telegramBot.enabled() ? 'ON' : 'off'} | WhatsApp: ${whatsappBot.enabled() ? 'ON' : 'off'}`);
  console.log(`Monitor de Jellyfin: ${monitor.status().enabled ? 'ON' : 'off'}`);
});

module.exports = server;
