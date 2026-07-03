# ESPE Player — Backend de suscripciones

Servicio en **Node.js sin dependencias** que lleva el registro de **quién tiene una
suscripción activa** y expone una API para que la app ESPE Player consulte el estado
tras el login. El bloqueo real se hace en **Jellyfin** (deshabilitando la cuenta), así
ni un APK modificado puede ver el contenido.

## ¿Qué hace?

- Guarda los suscriptores en `data/subscribers.json` (tu "plantilla", legible y editable).
- Calcula si una suscripción está **activa**, **vencida** o **baneada**.
- Expone una API para consultar el estado (app) y para administrar (panel web).
- Habilita/deshabilita la cuenta en **Jellyfin** según el pago (el candado real).
- **Cobra automático** con el webhook de **Mercado Pago**.
- **Avisa** de vencimientos por Telegram / WhatsApp / webhook.
- **Backups** automáticos + **log de auditoría** + protecciones de seguridad.

## Cómo correrlo

### Windows (lo más fácil)
1. Doble clic en **`start.bat`** (la primera vez crea y abre `.env`).
2. Completa el `.env`, guarda y vuelve a ejecutar `start.bat`.
3. Abre `http://localhost:8080/admin`.

### Node directo
```bash
cd espe-backend
cp .env.example .env   # edita tus valores
npm start              # http://localhost:8080
```

### Docker (recomendado si ya usas Docker para Jellyfin)
```bash
cd espe-backend
docker compose up -d --build
```
El contenedor trae `HEALTHCHECK` y `restart: unless-stopped`.

## Panel de administración 💜

`http://localhost:8080/admin` — ingresa tu `ADMIN_KEY`. Desde ahí:
- **Panel:** KPIs, ingresos/MRR, alertas de vencimiento, alta/renovación/revocación, baneo, historial, CSV.
- **Configuración:** nombre del negocio, moneda, precios y días de recordatorio.
- **Sistema:** estado de notificaciones (enviar prueba, correr recordatorios), backups y log de auditoría.

## Configuración (.env)

Copia `.env.example` a `.env`. Lo esencial es `PORT` y `ADMIN_KEY`; el resto es opcional
y activa funciones (Jellyfin, notificaciones, Mercado Pago). Ver comentarios en el `.env.example`.

Variables destacadas:

| Variable | Para qué |
|---|---|
| `ADMIN_KEY` | Clave del panel/API admin. **Cámbiala.** |
| `APP_KEY` | Si la defines, la app debe enviarla en `x-app-key` para consultar estado. |
| `APP_HMAC_SECRET` | Firma HMAC opcional de la respuesta de estado (la app la verifica). |
| `ALLOWED_ORIGINS` | Orígenes CORS permitidos (coma-separado, `*` por defecto). |
| `TRUST_PROXY` | `true` si corres detrás de Nginx/Caddy (lee IP real). |
| `JELLYFIN_URL` / `JELLYFIN_API_KEY` | Candado real: habilita/deshabilita cuentas. |
| `NOTIFY_PROVIDER` | `console`, `telegram`, `webhook`, `whatsapp` (combinables con comas). |
| `MP_ACCESS_TOKEN` / `MP_WEBHOOK_SECRET` | Cobro automático con Mercado Pago. |

## API

### Estado (la usa la app ESPE Player)
```
GET /api/v1/status?username=juan        (o /api/v1/app/status)
Header opcional: x-app-key: <APP_KEY>
```
Respuesta (solo datos públicos, sin teléfono ni historial):
```json
{
  "username": "juan", "active": true, "status": "activo",
  "plan": "mensual", "expires_at": "2026-07-30T...", "days_left": 30,
  "message": "Suscripción activa.", "business": "ESPE Player",
  "ts": 1710000000000, "signature": "<hmac si APP_HMAC_SECRET está seteada>"
}
```
Ver [APP-INTEGRATION.md](APP-INTEGRATION.md) para el contrato completo y un cliente Kotlin.

### Administración (cabecera `x-admin-key`)
```
GET  /api/v1/admin/subscribers        # lista completa (vista admin)
POST /api/v1/admin/create             # crea usuario Jellyfin + suscripción
POST /api/v1/admin/grant              # otorga/extiende { username, days, plan, phone }
POST /api/v1/admin/revoke             # revoca { username }
POST /api/v1/admin/ban                # banea/desbanea { username, banned }
POST /api/v1/admin/phone              # actualiza teléfono
POST /api/v1/admin/screens            # pantallas simultáneas
GET  /api/v1/admin/settings           # lee configuración
POST /api/v1/admin/settings           # guarda configuración
GET  /api/v1/admin/audit?limit=200    # log de auditoría
GET  /api/v1/admin/backups            # lista backups
POST /api/v1/admin/backups            # crea un backup ahora
GET  /api/v1/admin/notify/status      # estado de notificaciones
POST /api/v1/admin/notify/test        # envía notificación de prueba
POST /api/v1/admin/reminders/run      # corre los recordatorios ahora
```

### Webhook de Mercado Pago (cobro automático)
```
POST /api/v1/webhook/mercadopago
```
- Verifica la firma `x-signature` con `MP_WEBHOOK_SECRET`.
- Consulta el pago real con `MP_ACCESS_TOKEN`; si está `approved`, hace `grant` **idempotente**.
- Para saber a quién acreditar usa (en orden): `metadata.username`/`metadata.plan`/`metadata.days`,
  y si no, `external_reference` con formato `"username"` o `"username|plan"` (ej. `juan|mensual`).

**Configuración en Mercado Pago:** crea una preferencia de pago con
`external_reference = "<usuario>|<plan>"` y registra la URL del webhook apuntando a
`https://TU-DOMINIO/api/v1/webhook/mercadopago`.

## Seguridad y robustez

- **Estado público mínimo:** el endpoint de la app no expone teléfono ni historial.
- **Anti fuerza-bruta:** los intentos con clave admin inválida se limitan por IP; comparación de clave en **tiempo constante**.
- **Backups automáticos:** antes de cada escritura y una copia diaria en `data/backups/` (retención configurable).
- **Log de auditoría** (`data/audit.log`) de cada acción y evento de webhook.
- **Límite de tamaño de body**, validación de `username`, **cabeceras de seguridad** y **CORS** por lista de orígenes.
- **Idempotencia de pagos** para no acreditar dos veces el mismo pago de MP.
- **Jellyfin robusto:** timeouts, reintentos con backoff y contraseña en dos pasos.
- Corre **detrás de un reverse proxy con HTTPS** (Nginx/Caddy). El backend habla HTTP en la red interna.

## Notificaciones (base ampliable)

`NOTIFY_PROVIDER` combina proveedores con comas:
- `console` — imprime en el log (por defecto).
- `telegram` — avisos para el **admin** (requiere `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`).
- `webhook` — POST JSON genérico a `NOTIFY_WEBHOOK_URL`.
- `whatsapp` — mensajes directos al **suscriptor** vía WhatsApp Cloud API (`WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID`).

Si no hay canal directo al usuario, el recordatorio cae al admin con el link `wa.me` listo para enviar.
Los recordatorios se envían a los días configurados en `reminderDays` (por defecto 7, 3 y 1), sin repetir, y se resetean al renovar.

## Bots de pedidos (películas/series)

Los usuarios piden contenido por **Telegram** o **WhatsApp** con un comando, y tú los
gestionas desde el panel (**Pedidos**). Límite configurable: por defecto **1 pedido cada 7 días** por usuario.

### Comandos
- `!pedir <título>` — pide una película o serie (ej. `!pedir Interestelar`). Límite configurable por usuario.
- `!recomendaciones` — envía el link a la **página de catálogo** (en español) donde el usuario ve todo lo disponible hoy.
- `!nuevos` — lista los últimos títulos agregados (desde Jellyfin).
- `!ayuda` — muestra la ayuda.

El prefijo (`!`), la ventana (días) y el máximo por ventana se editan en **Configuración**.

### `!recomendaciones` — qué link envía
Prioridad del link:
1. El que pongas en **Configuración → Link de recomendaciones** (o `RECOMMENDATIONS_URL`).
2. Si está vacío, usa **JustWatch Ecuador** ([justwatch.com/ec](https://www.justwatch.com/ec)) por defecto:
   estrenos y catálogo mundial en español, con sinopsis y dónde ver.

Alternativas típicas para pegar en el panel:
- `https://www.themoviedb.org/?language=es-MX` (base tipo IMDb, en español latino)
- `https://www.sensacine.com.mx/peliculas/estrenos/` (estrenos + críticas)
- `PUBLIC_URL/catalogo` (tu **catálogo real**, ver abajo)

### Página de catálogo propia (`/catalogo`)
El backend además sirve una página pública en **`/catalogo`** (español latino) que lee tu Jellyfin y
muestra **todas** tus películas y series con póster y buscador. Úsala si quieres que los usuarios
vean solo **tu** contenido (ponla en el link de recomendaciones como `PUBLIC_URL/catalogo`).
- Define `PUBLIC_URL` (ej. `https://espe.lat`) para el link absoluto.
- Los pósters se sirven por proxy (`/catalogo/img/:id`) para no exponer la API key de Jellyfin.
- El catálogo se cachea en memoria (10 min por defecto, `CATALOG_TTL_MS`).

### Telegram (lo más fácil)
1. Crea un bot con **@BotFather** y copia el token en `TELEGRAM_BOT_TOKEN`.
2. Pon `TELEGRAM_BOT_POLLING=true`. Al arrancar, el backend escucha por *long polling*
   (no necesita URL pública ni webhook).

### WhatsApp (Cloud API)
1. Configura una app de WhatsApp Cloud API y completa `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID`.
2. Define `WHATSAPP_VERIFY_TOKEN` (lo que quieras) y `WHATSAPP_APP_SECRET` (el de tu app de Meta).
3. En Meta, registra el webhook apuntando a `https://TU-DOMINIO/api/v1/webhook/whatsapp`
   con el mismo verify token. El backend valida la verificación (GET) y la firma de cada evento.

### API de administración de pedidos
```
GET  /api/v1/admin/requests?status=pendiente   # lista + estadísticas
POST /api/v1/admin/requests/status             # { id, status, note }  status: pendiente|aprobado|cumplido|rechazado
GET  /api/v1/admin/bots/status                 # estado de los bots + config
```
Al cambiar el estado de un pedido, el backend **avisa automáticamente al usuario** por su misma plataforma.

## Fases del proyecto

- **MVP:** activas/extiendes suscripciones a mano; la app consulta el estado.
- **Pro (ya incluido):** Jellyfin como candado, Mercado Pago automático, notificaciones, backups y auditoría.
