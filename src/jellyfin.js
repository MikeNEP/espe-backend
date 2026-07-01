// Conector con Jellyfin para habilitar/deshabilitar cuentas (FASE PRO).
// Este es el "candado real": si la suscripción vence, se deshabilita la
// cuenta en Jellyfin y el usuario no puede ver nada, ni con un APK modificado.
//
// Requiere en el entorno:
//   JELLYFIN_URL      ej: http://localhost:8096
//   JELLYFIN_API_KEY  una API key de administrador de Jellyfin
const JELLYFIN_URL = (process.env.JELLYFIN_URL || '').replace(/\/$/, '');
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';

function configured() {
  return Boolean(JELLYFIN_URL && JELLYFIN_API_KEY);
}

function headers() {
  return {
    Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}"`,
    'Content-Type': 'application/json',
  };
}

// Busca el Id interno de Jellyfin a partir del nombre de usuario.
async function findUserId(username) {
  const res = await fetch(`${JELLYFIN_URL}/Users`, { headers: headers() });
  if (!res.ok) throw new Error(`Jellyfin /Users devolvió ${res.status}`);
  const users = await res.json();
  const u = users.find(
    (x) => (x.Name || '').toLowerCase() === username.toLowerCase(),
  );
  return u ? u.Id : null;
}

// Habilita/deshabilita la cuenta y fija el máximo de pantallas simultáneas.
async function setDisabled(username, disabled, maxSessions) {
  if (!configured()) throw new Error('Jellyfin no está configurado');
  const userId = await findUserId(username);
  if (!userId) throw new Error(`Usuario "${username}" no existe en Jellyfin`);

  const userRes = await fetch(`${JELLYFIN_URL}/Users/${userId}`, { headers: headers() });
  if (!userRes.ok) throw new Error(`No se pudo leer el usuario (${userRes.status})`);
  const user = await userRes.json();
  const policy = user.Policy || {};
  policy.IsDisabled = disabled;
  // Máximo de reproducciones simultáneas (0 = ilimitado en Jellyfin)
  if (typeof maxSessions === 'number' && maxSessions > 0) {
    policy.MaxActiveSessions = maxSessions;
  }

  const res = await fetch(`${JELLYFIN_URL}/Users/${userId}/Policy`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(policy),
  });
  if (!res.ok) throw new Error(`No se pudo actualizar la policy (${res.status})`);
  return true;
}

// Crea un usuario nuevo en Jellyfin con nombre y contraseña.
async function createUser(username, password) {
  if (!configured()) throw new Error('Jellyfin no está configurado');
  const existing = await findUserId(username);
  if (existing) throw new Error(`El usuario "${username}" ya existe en Jellyfin`);
  const res = await fetch(`${JELLYFIN_URL}/Users/New`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ Name: username, Password: password || '' }),
  });
  if (!res.ok) throw new Error(`No se pudo crear el usuario (${res.status})`);
  return res.json();
}

module.exports = { configured, setDisabled, findUserId, createUser };
