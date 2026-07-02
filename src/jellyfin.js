// Conector con Jellyfin para habilitar/deshabilitar cuentas (FASE PRO).
// Este es el "candado real": si la suscripción vence, se deshabilita la
// cuenta en Jellyfin y el usuario no puede ver nada, ni con un APK modificado.
//
// Requiere en el entorno:
//   JELLYFIN_URL      ej: http://localhost:8096
//   JELLYFIN_API_KEY  una API key de administrador de Jellyfin
const JELLYFIN_URL = (process.env.JELLYFIN_URL || '').replace(/\/$/, '');
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';
const TIMEOUT_MS = parseInt(process.env.JELLYFIN_TIMEOUT_MS, 10) || 10000;
const MAX_RETRIES = parseInt(process.env.JELLYFIN_RETRIES, 10) || 2;

function configured() {
  return Boolean(JELLYFIN_URL && JELLYFIN_API_KEY);
}

function headers() {
  return {
    Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}"`,
    'Content-Type': 'application/json',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch con timeout y reintentos con backoff exponencial.
// Reintenta ante errores de red y respuestas 5xx (problemas transitorios).
async function jfFetch(pathAndQuery, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${JELLYFIN_URL}${pathAndQuery}`, {
        ...options,
        headers: { ...headers(), ...(options.headers || {}) },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(300 * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await sleep(300 * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastErr || new Error('Jellyfin: fallo de red');
}

// Busca el Id interno de Jellyfin a partir del nombre de usuario.
async function findUserId(username) {
  const res = await jfFetch('/Users');
  if (!res.ok) throw new Error(`Jellyfin /Users devolvió ${res.status}`);
  const users = await res.json();
  const u = users.find((x) => (x.Name || '').toLowerCase() === username.toLowerCase());
  return u ? u.Id : null;
}

// Habilita/deshabilita la cuenta y fija el máximo de pantallas simultáneas.
async function setDisabled(username, disabled, maxSessions) {
  if (!configured()) throw new Error('Jellyfin no está configurado');
  const userId = await findUserId(username);
  if (!userId) throw new Error(`Usuario "${username}" no existe en Jellyfin`);

  const userRes = await jfFetch(`/Users/${userId}`);
  if (!userRes.ok) throw new Error(`No se pudo leer el usuario (${userRes.status})`);
  const user = await userRes.json();
  const policy = user.Policy || {};
  policy.IsDisabled = disabled;
  // Máximo de reproducciones simultáneas (0 = ilimitado en Jellyfin)
  if (typeof maxSessions === 'number' && maxSessions > 0) {
    policy.MaxActiveSessions = maxSessions;
  }

  const res = await jfFetch(`/Users/${userId}/Policy`, {
    method: 'POST',
    body: JSON.stringify(policy),
  });
  if (!res.ok) throw new Error(`No se pudo actualizar la policy (${res.status})`);
  return true;
}

// Fija la contraseña de un usuario existente (paso separado, compatible con
// versiones de Jellyfin que no aceptan la contraseña al crear).
async function setPassword(userId, newPassword) {
  const res = await jfFetch(`/Users/${userId}/Password`, {
    method: 'POST',
    body: JSON.stringify({ NewPw: newPassword, ResetPassword: false }),
  });
  if (!res.ok) throw new Error(`No se pudo fijar la contraseña (${res.status})`);
  return true;
}

// Crea un usuario nuevo en Jellyfin con nombre y contraseña.
async function createUser(username, password) {
  if (!configured()) throw new Error('Jellyfin no está configurado');
  const existing = await findUserId(username);
  if (existing) throw new Error(`El usuario "${username}" ya existe en Jellyfin`);
  const res = await jfFetch('/Users/New', {
    method: 'POST',
    body: JSON.stringify({ Name: username, Password: password || '' }),
  });
  if (!res.ok) throw new Error(`No se pudo crear el usuario (${res.status})`);
  const created = await res.json();
  // Segundo paso: algunas versiones ignoran Password en /Users/New.
  if (password && created && created.Id) {
    try { await setPassword(created.Id, password); } catch (e) { /* la cuenta ya existe */ }
  }
  return created;
}

// Elige un userId para consultar la biblioteca (Jellyfin lo requiere).
// Usa JELLYFIN_CATALOG_USER si está definido; si no, el primer usuario.
async function pickUserId() {
  const preferred = process.env.JELLYFIN_CATALOG_USER;
  if (preferred) {
    const id = await findUserId(preferred);
    if (id) return id;
  }
  const res = await jfFetch('/Users');
  if (!res.ok) throw new Error(`Jellyfin /Users devolvió ${res.status}`);
  const users = await res.json();
  return users[0] ? users[0].Id : null;
}

async function countItems(userId, type) {
  const res = await jfFetch(
    `/Items?userId=${userId}&Recursive=true&IncludeItemTypes=${type}&Limit=0&EnableTotalRecordCount=true`,
  );
  if (!res.ok) throw new Error(`Jellyfin /Items devolvió ${res.status}`);
  const data = await res.json();
  return data.TotalRecordCount || 0;
}

async function latestItems(userId, limit = 8) {
  const res = await jfFetch(
    `/Items?userId=${userId}&Recursive=true&IncludeItemTypes=Movie,Series&SortBy=DateCreated&SortOrder=Descending&Limit=${limit}&Fields=ProductionYear`,
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.Items || []).map((i) => ({ name: i.Name, year: i.ProductionYear, type: i.Type }));
}

// Resumen del catálogo: cantidad de películas/series y los últimos agregados.
async function getCatalogSummary() {
  if (!configured()) throw new Error('Jellyfin no está configurado');
  const userId = await pickUserId();
  if (!userId) throw new Error('no hay usuarios en Jellyfin');
  const [movies, series, latest] = await Promise.all([
    countItems(userId, 'Movie'),
    countItems(userId, 'Series'),
    latestItems(userId, 8),
  ]);
  return { movies, series, latest };
}

module.exports = { configured, setDisabled, findUserId, createUser, setPassword, getCatalogSummary };
