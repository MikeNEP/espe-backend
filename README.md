# ESPE Player — Backend de suscripciones

Servicio mínimo (Node.js, sin dependencias) que lleva el registro de **quién tiene
una suscripción activa** y expone una API para que la app ESPE Player consulte el
estado tras el login.

## ¿Qué hace?

- Guarda los suscriptores en `data/subscribers.json` (tu "plantilla", legible y editable).
- Calcula si una suscripción está **activa** o **vencida** según la fecha `expires_at`.
- Expone una API para consultar el estado y para administrar (otorgar/revocar) suscripciones.
- (Opcional, Fase Pro) Habilita/deshabilita la cuenta en **Jellyfin** según el pago.

## Configuración (.env)

Copia `.env.example` a `.env` y edítalo con tus datos (clave admin, Jellyfin, etc.).
El backend lee ese archivo automáticamente.

## Panel de administración web 💜

Una vez corriendo, abre en el navegador:

```
http://localhost:8080/admin
```

Ingresas tu `ADMIN_KEY` y desde ahí puedes: ver suscriptores, agregar/renovar y
revocar suscripciones — sin escribir comandos.

## Cómo correrlo

### En Windows (lo más fácil)
1. Edita el archivo `.env` con tus datos.
2. Doble clic en **`start.bat`**.
3. Abre `http://localhost:8080/admin`.

### Opción A — Node directo
```bash
cd espe-backend
ADMIN_KEY="tu-clave-secreta" npm start
# Escucha en http://localhost:8080
```

### Opción B — Docker (recomendado si ya usas Docker para Jellyfin)
```bash
cd espe-backend
docker compose up -d --build
```

## La "plantilla" de suscriptores

Es el archivo `data/subscribers.json`. Cada suscriptor luce así:
```json
{
  "username": "juan",
  "plan": "mensual",
  "expires_at": "2026-07-30T00:00:00.000Z",
  "created_at": "2026-06-30T00:00:00.000Z",
  "updated_at": "2026-06-30T00:00:00.000Z"
}
```
Una suscripción está **activa** mientras `expires_at` esté en el futuro.

## API

### Consulta de estado (la usa la app ESPE Player)
```
GET /api/v1/status?username=juan
```
Respuesta:
```json
{ "username": "juan", "active": true, "status": "activo", "plan": "mensual", "expires_at": "2026-07-30T...", "days_left": 30 }
```

### Administración (requiere cabecera `x-admin-key`)
```
GET  /api/v1/admin/subscribers           # lista todos (la plantilla)
POST /api/v1/admin/grant                 # otorga/extiende: { "username":"juan", "days":30, "plan":"mensual" }
POST /api/v1/admin/revoke                # revoca: { "username":"juan" }
```

Ejemplos con `curl`:
```bash
# Dar 30 días a "juan"
curl -X POST http://localhost:8080/api/v1/admin/grant \
  -H "x-admin-key: tu-clave-secreta" -H "Content-Type: application/json" \
  -d '{"username":"juan","days":30}'

# Ver la lista de suscriptores
curl http://localhost:8080/api/v1/admin/subscribers -H "x-admin-key: tu-clave-secreta"

# Consultar estado (como lo haría la app)
curl "http://localhost:8080/api/v1/status?username=juan"
```

## Fases del proyecto

- **MVP (este código):** activas/extiendes suscripciones a mano con `grant`. La app consulta el estado y bloquea si está vencido.
- **Fase Pro (siguiente):**
  1. **Jellyfin:** configura `JELLYFIN_URL` y `JELLYFIN_API_KEY` para que el backend **habilite/deshabilite** la cuenta automáticamente (el candado real).
  2. **Mercado Pago:** webhook que al recibir un pago aprobado llama a `grant` automáticamente.

## Seguridad

- La verdad vive en el servidor (nunca en la app).
- El bloqueo real es deshabilitar la cuenta de Jellyfin: así ni un APK modificado puede ver el contenido.
- Cambia `ADMIN_KEY` por una clave larga y secreta. No la compartas.
