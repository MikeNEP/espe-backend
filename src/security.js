// Utilidades de seguridad (sin dependencias):
//  - rate limiting en memoria (anti fuerza-bruta)
//  - comparación de secretos en tiempo constante (anti timing attacks)
//  - obtención de IP del cliente (con soporte de reverse proxy)
//  - cabeceras de seguridad HTTP
const crypto = require('crypto');

const TRUST_PROXY = String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';

// ---- IP del cliente -------------------------------------------------------
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---- Comparación en tiempo constante -------------------------------------
// Evita filtrar la clave por diferencias de tiempo al comparar caracteres.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual exige la misma longitud: hasheamos para igualarlas
  // sin filtrar la longitud real del secreto.
  const ha = crypto.createHash('sha256').update(bufA).digest();
  const hb = crypto.createHash('sha256').update(bufB).digest();
  try {
    return crypto.timingSafeEqual(ha, hb) && bufA.length === bufB.length;
  } catch {
    return false;
  }
}

// ---- Rate limiter en memoria ---------------------------------------------
// Simple, por proceso. Suficiente para un backend de un solo nodo.
const buckets = new Map(); // key -> { count, resetAt }

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  const remaining = Math.max(0, max - b.count);
  return {
    allowed: b.count <= max,
    remaining,
    retryAfterMs: Math.max(0, b.resetAt - now),
  };
}

// Limpia entradas viejas cada 10 minutos para no crecer sin límite.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}, 10 * 60 * 1000).unref?.();

// ---- Cabeceras de seguridad ----------------------------------------------
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // CSP: el panel usa estilos/scripts inline, por eso 'unsafe-inline'.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'",
  );
}

// ---- CORS con lista de orígenes permitidos --------------------------------
// ALLOWED_ORIGINS: coma-separado. '*' (por defecto) permite cualquiera.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-app-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

module.exports = { clientIp, safeCompare, rateLimit, applySecurityHeaders, applyCors };
