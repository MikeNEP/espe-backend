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

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'cambia-esta-clave-admin';
const APP_KEY = process.env.APP_KEY || ''; // opcional: clave que envía la app
const APP_HMAC_SECRET = process.env.APP_HMAC_SECRET || ''; // opcional: firma la respuesta
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES, 10) || 64 * 1024; // 64 KB

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
    phone: sub ? sub.phone || '' : '',
    screens: sub ? sub.screens || 2 : 2,
    expires_at: sub ? sub.expires_at : null,
    days_left: sub ? daysLeft(sub.expires_at) : 0,
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
  } catch (e) {
    logger.audit('jellyfin.sync', { ok: false, username: sub.username, error: e.message });
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
function syncExpired() {
  if (!jellyfin.configured()) return;
  for (const sub of store.list()) {
    const enabled = store.isActive(sub);
    const screens = parseInt(sub.screens, 10) || 2;
    jellyfin.setDisabled(sub.username, !enabled, screens).catch((e) =>
      logger.audit('jellyfin.sync', { ok: false, username: sub.username, error: e.message }),
    );
  }
}

// --- Arranque ---------------------------------------------------------------
// Backup automático antes de cada escritura de suscriptores + backup diario.
store.setBeforeSaveHook(() => backup.backupNow('presave'));
backup.scheduleDaily();
reminders.schedule(6); // recordatorios cada 6h
setInterval(syncExpired, 12 * 60 * 60 * 1000);

// Aviso si la clave admin quedó por defecto (riesgo de seguridad).
if (ADMIN_KEY === 'cambia-esta-clave-admin') {
  console.warn('⚠️  ADMIN_KEY está en su valor por defecto. ¡Cámbiala en .env!');
}

server.listen(PORT, () => {
  console.log(`espe-backend escuchando en el puerto ${PORT}`);
  console.log(`Jellyfin ${jellyfin.configured() ? 'CONFIGURADO' : 'no configurado (modo MVP)'}`);
  console.log(`Mercado Pago ${mercadopago.configured() ? 'CONFIGURADO' : 'no configurado'}`);
  console.log(`Notificaciones: ${notifier.status().providers.join(', ') || 'console'}`);
});

module.exports = server;
