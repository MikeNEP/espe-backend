// ESPE Player - Backend de suscripciones (MVP)
// Node.js puro, sin dependencias. Corre con: node src/server.js
require('./loadEnv'); // carga variables desde el archivo .env si existe
const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const { URL } = require('url');
const store = require('./store');
const jellyfin = require('./jellyfin');

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'cambia-esta-clave-admin';
const APP_KEY = process.env.APP_KEY || ''; // opcional: clave que envía la app

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function daysLeft(expiresAt) {
  if (!expiresAt) return 0;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// Convierte un suscriptor en la respuesta pública de estado.
function statusFor(sub) {
  const active = Boolean(sub && sub.expires_at && new Date(sub.expires_at).getTime() > Date.now());
  return {
    username: sub ? sub.username : null,
    active,
    status: active ? 'activo' : sub ? 'vencido' : 'inexistente',
    plan: sub ? sub.plan : null,
    expires_at: sub ? sub.expires_at : null,
    days_left: sub ? daysLeft(sub.expires_at) : 0,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  // CORS básico
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-app-key');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Health check
  if (method === 'GET' && path === '/') {
    return json(res, 200, { service: 'espe-backend', ok: true, jellyfin: jellyfin.configured() });
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

  // === Estado de suscripción (lo consulta la app ESPE Player tras el login) ===
  // GET /api/v1/status?username=juan
  if (method === 'GET' && path === '/api/v1/status') {
    if (APP_KEY && req.headers['x-app-key'] !== APP_KEY) {
      return json(res, 401, { error: 'app key inválida' });
    }
    const username = (url.searchParams.get('username') || '').trim().toLowerCase();
    if (!username) return json(res, 400, { error: 'falta el parámetro username' });
    return json(res, 200, statusFor(store.getByUsername(username)));
  }

  // === Rutas de administración (requieren cabecera x-admin-key) ===
  if (path.startsWith('/api/v1/admin/')) {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) {
      return json(res, 401, { error: 'admin key inválida' });
    }

    // Listar todos los suscriptores (la "plantilla")
    if (method === 'GET' && path === '/api/v1/admin/subscribers') {
      return json(res, 200, { subscribers: store.list().map(statusFor) });
    }

    // Otorgar/extender suscripción: { "username": "juan", "days": 30, "plan": "mensual" }
    if (method === 'POST' && path === '/api/v1/admin/grant') {
      const body = await readBody(req);
      const username = (body.username || '').trim().toLowerCase();
      const days = parseInt(body.days, 10);
      if (!username || !days || days <= 0) {
        return json(res, 400, { error: 'username y days (>0) son requeridos' });
      }
      const sub = store.grant(username, days, body.plan);
      // Si Jellyfin está configurado, habilitamos la cuenta al pagar.
      if (jellyfin.configured()) {
        try { await jellyfin.setDisabled(username, false); } catch (e) { /* log */ }
      }
      return json(res, 200, statusFor(sub));
    }

    // Revocar suscripción: { "username": "juan" }
    if (method === 'POST' && path === '/api/v1/admin/revoke') {
      const body = await readBody(req);
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return json(res, 400, { error: 'username requerido' });
      const sub = store.revoke(username);
      if (!sub) return json(res, 404, { error: 'el usuario no existe' });
      if (jellyfin.configured()) {
        try { await jellyfin.setDisabled(username, true); } catch (e) { /* log */ }
      }
      return json(res, 200, statusFor(sub));
    }

    return json(res, 404, { error: 'ruta de admin no encontrada' });
  }

  json(res, 404, { error: 'no encontrado' });
});

// Tarea periódica (cada 12h): deshabilita en Jellyfin las cuentas vencidas.
// Solo actúa si Jellyfin está configurado. Es la red de seguridad del "candado".
function syncExpired() {
  if (!jellyfin.configured()) return;
  for (const sub of store.list()) {
    const expired = !sub.expires_at || new Date(sub.expires_at).getTime() <= Date.now();
    jellyfin.setDisabled(sub.username, expired).catch(() => {});
  }
}
setInterval(syncExpired, 12 * 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`espe-backend escuchando en el puerto ${PORT}`);
  console.log(`Jellyfin ${jellyfin.configured() ? 'CONFIGURADO' : 'no configurado (modo MVP)'}`);
});
