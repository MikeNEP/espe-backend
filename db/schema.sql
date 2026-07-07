-- =============================================================================
-- ESPE Player — Esquema de base de datos profesional para plataforma de streaming
-- =============================================================================
-- Dialecto base: SQLite (portable, cero infraestructura). Notas para PostgreSQL
-- se indican con "-- PG:". El diseño sirve para un único servidor Jellyfin
-- (ESPE Player) alimentado por rclone + Google Drive, con suscripciones,
-- pagos, bots de pedidos, analítica de uso e infraestructura.
--
-- Convenciones:
--   * IDs de negocio propios: INTEGER PRIMARY KEY autoincremental.
--   * IDs externos (Jellyfin, TMDB, Mercado Pago): TEXT, únicos.
--   * Fechas: TEXT en ISO-8601 UTC (ej. '2026-07-07T05:00:00Z').
--     -- PG: usar TIMESTAMPTZ en su lugar.
--   * Dinero: INTEGER en centavos (evita errores de coma flotante).
--   * Estados (enums): TEXT con CHECK, documentados en docs/DATA-MODEL.md.
--   * Borrado lógico: columna deleted_at donde aplica (no borrar historial).
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- =============================================================================
-- 1. CONFIGURACIÓN Y OPERACIÓN
-- =============================================================================

-- Ajustes globales del sistema (clave/valor). Reemplaza al settings.json.
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,                     -- JSON o texto plano
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Servidores/nodos Jellyfin (para crecer a varios servidores).
CREATE TABLE IF NOT EXISTS servers (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,            -- ej. 'ESPE Player - Principal'
    base_url    TEXT NOT NULL,            -- http://jellyfin:8096
    region      TEXT,                     -- ej. 'ec', 'us'
    is_active   INTEGER NOT NULL DEFAULT 1,
    max_users   INTEGER,                  -- capacidad estimada
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Registro de auditoría (quién hizo qué y cuándo).
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY,
    actor_type  TEXT NOT NULL DEFAULT 'system'  CHECK (actor_type IN ('admin','system','bot','gateway','user')),
    actor_id    TEXT,                     -- id del admin/usuario que originó la acción
    action      TEXT NOT NULL,            -- ej. 'subscription.grant', 'payment.approved'
    entity_type TEXT,                     -- ej. 'user', 'payment'
    entity_id   TEXT,
    ip          TEXT,
    detail      TEXT,                     -- JSON con contexto
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- =============================================================================
-- 2. STAFF, ROLES Y PERMISOS (RBAC) + REVENDEDORES
-- =============================================================================

CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,     -- 'owner','admin','support','reseller'
    name        TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '[]' -- JSON array de permisos
);

-- Personal que accede al panel (dueño, soporte, revendedores).
CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY,
    role_id       INTEGER NOT NULL REFERENCES roles(id),
    username      TEXT NOT NULL UNIQUE,
    email         TEXT UNIQUE,
    -- Contraseña con scrypt/pbkdf2 (guardar 'algoritmo$salt$hash').
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role_id);

-- Sesiones del panel (login con token en vez de mandar la clave siempre).
CREATE TABLE IF NOT EXISTS admin_sessions (
    id          TEXT PRIMARY KEY,         -- token opaco aleatorio
    admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    ip          TEXT,
    user_agent  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);

-- Datos extra de un admin con rol 'reseller' (revendedor).
CREATE TABLE IF NOT EXISTS resellers (
    admin_id       INTEGER PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
    credit_balance INTEGER NOT NULL DEFAULT 0,   -- créditos disponibles (centavos o unidades)
    commission_pct REAL NOT NULL DEFAULT 0,      -- comisión %
    max_subscribers INTEGER,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Movimientos de crédito de revendedores (libro mayor).
CREATE TABLE IF NOT EXISTS reseller_ledger (
    id          INTEGER PRIMARY KEY,
    reseller_id INTEGER NOT NULL REFERENCES resellers(admin_id) ON DELETE CASCADE,
    delta       INTEGER NOT NULL,         -- +recarga / -consumo
    reason      TEXT NOT NULL,            -- 'recarga','alta_suscriptor','ajuste'
    ref_id      TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reseller_ledger ON reseller_ledger(reseller_id);

-- =============================================================================
-- 3. USUARIOS / SUSCRIPTORES
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY,
    jellyfin_user_id  TEXT UNIQUE,        -- Id interno en Jellyfin
    username          TEXT NOT NULL UNIQUE,
    email             TEXT,
    phone             TEXT,               -- E.164, ej. +593999999999
    display_name      TEXT,
    country           TEXT,               -- ISO-3166 alfa-2 (EC, US...)
    locale            TEXT DEFAULT 'es-419',
    -- Estado global de la cuenta (independiente del vencimiento).
    status            TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','banned','deleted')),
    max_screens       INTEGER NOT NULL DEFAULT 2,   -- pantallas simultáneas
    -- A qué admin/revendedor pertenece este usuario (opcional).
    owner_admin_id    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    referred_by       INTEGER REFERENCES users(id)  ON DELETE SET NULL,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_phone  ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_owner  ON users(owner_admin_id);

-- Identificadores de contacto vinculados a un usuario (para los bots).
-- Permite reconocer al usuario por su chat de Telegram o número de WhatsApp.
CREATE TABLE IF NOT EXISTS user_identities (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL CHECK (platform IN ('telegram','whatsapp','email','app')),
    external_id TEXT NOT NULL,            -- chat_id de Telegram / número WA / etc.
    verified    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);

-- =============================================================================
-- 4. PLANES, SUSCRIPCIONES, PRUEBAS
-- =============================================================================

CREATE TABLE IF NOT EXISTS plans (
    id             INTEGER PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE,  -- 'mensual','trimestral','anual','prueba'
    name           TEXT NOT NULL,
    description    TEXT,
    price_cents    INTEGER NOT NULL DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'USD',
    duration_days  INTEGER,               -- NULL para pruebas por horas
    duration_hours INTEGER,               -- para planes/pruebas por horas
    max_screens    INTEGER NOT NULL DEFAULT 2,
    max_downloads  INTEGER NOT NULL DEFAULT 0,
    quality        TEXT NOT NULL DEFAULT 'HD' CHECK (quality IN ('SD','HD','FHD','4K')),
    is_trial       INTEGER NOT NULL DEFAULT 0,
    is_public      INTEGER NOT NULL DEFAULT 1,   -- se muestra en la página de precios
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id      INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    status       TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','expired','cancelled','trial','grace')),
    started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    expires_at   TEXT NOT NULL,
    auto_renew   INTEGER NOT NULL DEFAULT 0,
    is_trial     INTEGER NOT NULL DEFAULT 0,
    cancelled_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_user    ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_status  ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subs_expires ON subscriptions(expires_at);

-- Recordatorios de vencimiento ya enviados (evita duplicados; se limpia al renovar).
CREATE TABLE IF NOT EXISTS subscription_reminders (
    id              INTEGER PRIMARY KEY,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    threshold_days  INTEGER NOT NULL,     -- 7, 3, 1...
    sent_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (subscription_id, threshold_days)
);

-- =============================================================================
-- 5. PAGOS, FACTURAS, CUPONES, REFERIDOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    plan_id         INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    amount_cents    INTEGER NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    method          TEXT NOT NULL CHECK (method IN ('mercadopago','paypal','cash','transfer','crypto','reseller','other')),
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','refunded','chargeback')),
    -- Idempotencia y conciliación con la pasarela.
    gateway         TEXT,                  -- 'mercadopago'...
    gateway_ref     TEXT,                  -- id del pago en la pasarela
    external_ref    TEXT,                  -- external_reference que mandamos (usuario|plan)
    coupon_id       INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
    paid_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    raw             TEXT,                  -- JSON crudo de la pasarela (auditoría)
    UNIQUE (gateway, gateway_ref)          -- no procesar el mismo pago dos veces
);
CREATE INDEX IF NOT EXISTS idx_payments_user   ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- Comprobantes/facturas generados a partir de pagos aprobados.
CREATE TABLE IF NOT EXISTS invoices (
    id           INTEGER PRIMARY KEY,
    payment_id   INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    number       TEXT NOT NULL UNIQUE,    -- ej. 'ESPE-2026-000123'
    amount_cents INTEGER NOT NULL,
    currency     TEXT NOT NULL DEFAULT 'USD',
    issued_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    pdf_path     TEXT
);

CREATE TABLE IF NOT EXISTS coupons (
    id             INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    kind           TEXT NOT NULL CHECK (kind IN ('percent','fixed','days')),
    value          INTEGER NOT NULL,      -- % / centavos / días según kind
    max_redemptions INTEGER,              -- NULL = ilimitado
    times_redeemed INTEGER NOT NULL DEFAULT 0,
    valid_from     TEXT,
    valid_until    TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id         INTEGER PRIMARY KEY,
    coupon_id  INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
    redeemed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (coupon_id, user_id)
);

-- Programa de referidos: quién invitó a quién y la recompensa otorgada.
CREATE TABLE IF NOT EXISTS referrals (
    id             INTEGER PRIMARY KEY,
    referrer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_days    INTEGER NOT NULL DEFAULT 0,
    rewarded       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (referred_id)                  -- a un referido lo invita una sola persona
);

-- =============================================================================
-- 6. CATÁLOGO DE CONTENIDO (espejo enriquecido de Jellyfin + TMDB)
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_items (
    id             INTEGER PRIMARY KEY,
    jellyfin_id    TEXT UNIQUE,           -- Id del item en Jellyfin
    tmdb_id        TEXT,
    imdb_id        TEXT,
    type           TEXT NOT NULL CHECK (type IN ('movie','series')),
    title          TEXT NOT NULL,
    original_title TEXT,
    overview       TEXT,                  -- sinopsis (es-419)
    year           INTEGER,
    runtime_min    INTEGER,
    content_rating TEXT,                  -- 'PG-13', 'R', 'TV-MA'...
    tmdb_rating    REAL,
    poster_path    TEXT,
    backdrop_path  TEXT,
    server_id      INTEGER REFERENCES servers(id) ON DELETE SET NULL,
    added_at       TEXT,                  -- cuándo entró a la biblioteca
    is_available   INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_content_type  ON content_items(type);
CREATE INDEX IF NOT EXISTS idx_content_title ON content_items(title);
CREATE INDEX IF NOT EXISTS idx_content_tmdb  ON content_items(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_content_added ON content_items(added_at);

CREATE TABLE IF NOT EXISTS seasons (
    id           INTEGER PRIMARY KEY,
    content_id   INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    jellyfin_id  TEXT UNIQUE,
    season_number INTEGER NOT NULL,
    name         TEXT,
    UNIQUE (content_id, season_number)
);

CREATE TABLE IF NOT EXISTS episodes (
    id             INTEGER PRIMARY KEY,
    season_id      INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    jellyfin_id    TEXT UNIQUE,
    episode_number INTEGER NOT NULL,
    title          TEXT,
    overview       TEXT,
    runtime_min    INTEGER,
    air_date       TEXT,
    added_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_season ON episodes(season_id);

CREATE TABLE IF NOT EXISTS genres (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE            -- 'Acción','Comedia','Terror'...
);

CREATE TABLE IF NOT EXISTS content_genres (
    content_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    genre_id   INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (content_id, genre_id)
);

CREATE TABLE IF NOT EXISTS people (
    id       INTEGER PRIMARY KEY,
    tmdb_id  TEXT UNIQUE,
    name     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_people (
    content_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('actor','director','writer','creator')),
    character  TEXT,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (content_id, person_id, role)
);

-- Colecciones curadas ('Estrenos', 'Marvel', 'Navidad'...).
CREATE TABLE IF NOT EXISTS collections (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    is_public   INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    content_id    INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collection_id, content_id)
);

-- =============================================================================
-- 7. DISPOSITIVOS, SESIONES Y ANALÍTICA DE USO
-- =============================================================================

CREATE TABLE IF NOT EXISTS devices (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,           -- id que reporta el cliente/app
    name         TEXT,                    -- 'Samsung TV', 'Xiaomi Redmi'...
    platform     TEXT,                    -- 'AndroidTV','Android','Web','iOS'
    app_version  TEXT,
    last_ip      TEXT,
    last_seen_at TEXT,
    is_blocked   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Sesiones de reproducción (una por "play"). Base para analítica y control
-- de pantallas simultáneas / detección de compartición de cuenta.
CREATE TABLE IF NOT EXISTS playback_sessions (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    content_id     INTEGER REFERENCES content_items(id) ON DELETE SET NULL,
    episode_id     INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
    started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ended_at       TEXT,
    position_sec   INTEGER DEFAULT 0,     -- última posición reproducida
    duration_sec   INTEGER,
    play_method    TEXT,                  -- 'DirectPlay','DirectStream','Transcode'
    bitrate_kbps   INTEGER,
    ip             TEXT,
    country        TEXT
);
CREATE INDEX IF NOT EXISTS idx_playback_user    ON playback_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_playback_content ON playback_sessions(content_id);
CREATE INDEX IF NOT EXISTS idx_playback_started ON playback_sessions(started_at);

-- Historial de "continuar viendo" (última posición por contenido/usuario).
CREATE TABLE IF NOT EXISTS watch_history (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_id   INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    episode_id   INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
    position_sec INTEGER NOT NULL DEFAULT 0,
    watched      INTEGER NOT NULL DEFAULT 0,  -- 1 = terminado
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (user_id, content_id, episode_id)
);

CREATE TABLE IF NOT EXISTS watchlist (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (user_id, content_id)
);

CREATE TABLE IF NOT EXISTS ratings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
    liked      INTEGER,                   -- 1 like / 0 dislike / NULL
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (user_id, content_id)
);

-- =============================================================================
-- 8. PEDIDOS DE CONTENIDO (BOTS) CON VOTOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_requests (
    id           INTEGER PRIMARY KEY,
    title        TEXT NOT NULL,           -- lo que pidió el usuario
    norm_title   TEXT NOT NULL,           -- normalizado (para agrupar duplicados)
    tmdb_id      TEXT,                    -- si se autocompletó con TMDB
    type         TEXT CHECK (type IN ('movie','series','unknown')) DEFAULT 'unknown',
    year         INTEGER,
    status       TEXT NOT NULL DEFAULT 'pendiente'
                   CHECK (status IN ('pendiente','aprobado','descargando','cumplido','rechazado')),
    note         TEXT,                    -- motivo de rechazo / observaciones
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON content_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_norm   ON content_requests(norm_title);

-- Votos: cada usuario que pide un título ya existente suma aquí.
CREATE TABLE IF NOT EXISTS request_votes (
    request_id INTEGER NOT NULL REFERENCES content_requests(id) ON DELETE CASCADE,
    platform   TEXT NOT NULL,             -- 'telegram','whatsapp'
    external_id TEXT NOT NULL,            -- chat/número del votante
    user_name  TEXT,
    voted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (request_id, platform, external_id)
);

-- =============================================================================
-- 9. SOPORTE Y COMUNICACIÓN
-- =============================================================================

CREATE TABLE IF NOT EXISTS support_tickets (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    subject     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','pending','resolved','closed')),
    priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    assigned_to INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);

CREATE TABLE IF NOT EXISTS ticket_messages (
    id          INTEGER PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL CHECK (author_type IN ('user','admin')),
    author_id   TEXT,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id);

-- Registro de notificaciones enviadas (recordatorios, avisos, etc.).
CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    channel     TEXT NOT NULL CHECK (channel IN ('telegram','whatsapp','email','webhook','console')),
    template    TEXT,                     -- 'reminder','welcome','payment_ok'...
    body        TEXT,
    status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('queued','sent','failed')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

-- Preferencias de notificación por usuario.
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reminders         INTEGER NOT NULL DEFAULT 1,
    marketing         INTEGER NOT NULL DEFAULT 1,
    request_updates   INTEGER NOT NULL DEFAULT 1,
    preferred_channel TEXT DEFAULT 'whatsapp'
);

-- Anuncios/novedades para mostrar en la app o el portal.
CREATE TABLE IF NOT EXISTS announcements (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT,
    audience    TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','active','expired')),
    starts_at   TEXT,
    ends_at     TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- =============================================================================
-- 10. INFRAESTRUCTURA: GOOGLE DRIVE + RCLONE (rotación de service accounts)
-- =============================================================================
-- Modela las "cuentas de servicio" que rclone rota para repartir la cuota de
-- la API de Google Drive y evitar errores 403 (rate limit) con muchos usuarios.

CREATE TABLE IF NOT EXISTS gdrive_service_accounts (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,   -- xxxx@proyecto.iam.gserviceaccount.com
    file_name     TEXT NOT NULL,          -- sa-001.json
    project       TEXT,                   -- proyecto de Google Cloud
    is_active     INTEGER NOT NULL DEFAULT 1,
    -- Estado de cuota diaria (para saltar cuentas agotadas).
    daily_usage_bytes INTEGER NOT NULL DEFAULT 0,
    quota_hit_at  TEXT,                   -- última vez que dio 403
    last_used_at  TEXT,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Uso diario por cuenta de servicio (para monitoreo/rotación inteligente).
CREATE TABLE IF NOT EXISTS gdrive_usage (
    id           INTEGER PRIMARY KEY,
    sa_id        INTEGER NOT NULL REFERENCES gdrive_service_accounts(id) ON DELETE CASCADE,
    day          TEXT NOT NULL,           -- 'YYYY-MM-DD'
    bytes_down   INTEGER NOT NULL DEFAULT 0,
    bytes_up     INTEGER NOT NULL DEFAULT 0,
    api_calls    INTEGER NOT NULL DEFAULT 0,
    errors_403   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (sa_id, day)
);

-- =============================================================================
-- 11. VISTAS ÚTILES
-- =============================================================================

-- Suscriptores con su suscripción vigente y días restantes.
CREATE VIEW IF NOT EXISTS v_active_subscribers AS
SELECT u.id            AS user_id,
       u.username,
       u.phone,
       u.status        AS account_status,
       s.id            AS subscription_id,
       p.slug          AS plan,
       s.expires_at,
       CAST((julianday(s.expires_at) - julianday('now')) AS INTEGER) AS days_left,
       s.is_trial
FROM users u
JOIN subscriptions s ON s.user_id = u.id AND s.status IN ('active','trial','grace')
LEFT JOIN plans p    ON p.id = s.plan_id
WHERE u.deleted_at IS NULL
  AND julianday(s.expires_at) > julianday('now');

-- Cola de pedidos ordenada por votos.
CREATE VIEW IF NOT EXISTS v_request_queue AS
SELECT r.id,
       r.title,
       r.status,
       r.type,
       r.year,
       (SELECT COUNT(*) FROM request_votes v WHERE v.request_id = r.id) AS votes,
       r.created_at
FROM content_requests r
WHERE r.status = 'pendiente'
ORDER BY votes DESC, r.created_at ASC;

-- Contenido más visto (últimos registros de reproducción).
CREATE VIEW IF NOT EXISTS v_popular_content AS
SELECT c.id, c.title, c.type,
       COUNT(ps.id) AS plays,
       COUNT(DISTINCT ps.user_id) AS unique_viewers
FROM content_items c
JOIN playback_sessions ps ON ps.content_id = c.id
GROUP BY c.id
ORDER BY plays DESC;
