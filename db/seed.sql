-- =============================================================================
-- ESPE Player — Datos semilla (valores iniciales para empezar a operar)
-- Cargar DESPUÉS de schema.sql:  sqlite3 espe.db < db/schema.sql < db/seed.sql
-- Los precios están en centavos (990 = $9.90).
-- =============================================================================

-- Roles (RBAC) --------------------------------------------------------------
INSERT OR IGNORE INTO roles (slug, name, permissions) VALUES
  ('owner',   'Dueño',       '["*"]'),
  ('admin',   'Administrador','["subscribers.*","payments.*","requests.*","content.*","settings.read"]'),
  ('support', 'Soporte',      '["subscribers.read","requests.*","tickets.*"]'),
  ('reseller','Revendedor',   '["subscribers.create","subscribers.renew","subscribers.read.own"]');

-- Ajustes globales ----------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('business',           'ESPE Player'),
  ('currency',           'USD'),
  ('locale',             'es-419'),
  ('reminder_days',      '[7,3,1]'),
  ('trial_hours',        '2'),
  ('recommendations_url',''),
  ('request_window_days','7'),
  ('request_max_per_window','1'),
  ('request_prefix',     '!');

-- Servidor principal --------------------------------------------------------
INSERT OR IGNORE INTO servers (name, base_url, region, is_active, max_users)
VALUES ('ESPE Player - Principal', 'http://localhost:8096', 'ec', 1, 300);

-- Planes de ejemplo ---------------------------------------------------------
INSERT OR IGNORE INTO plans
  (slug, name, description, price_cents, currency, duration_days, duration_hours, max_screens, max_downloads, quality, is_trial, is_public, sort_order)
VALUES
  ('prueba',     'Prueba gratis', 'Acceso de cortesía por horas',        0,    'USD', NULL, 2,   1, 0, 'HD',  1, 0, 0),
  ('mensual',    'Mensual',       '1 pantalla, calidad HD',              500,  'USD', 30,   NULL,1, 0, 'HD',  0, 1, 1),
  ('mensual_2p', 'Mensual 2 pantallas','2 pantallas, Full HD',           800,  'USD', 30,   NULL,2, 5, 'FHD', 0, 1, 2),
  ('trimestral', 'Trimestral',    '2 pantallas, Full HD (ahorra)',       2000, 'USD', 90,   NULL,2, 5, 'FHD', 0, 1, 3),
  ('anual',      'Anual',         '2 pantallas, 4K + descargas',         6000, 'USD', 365,  NULL,2, 10,'4K',  0, 1, 4);

-- Géneros base --------------------------------------------------------------
INSERT OR IGNORE INTO genres (name) VALUES
  ('Acción'), ('Aventura'), ('Comedia'), ('Drama'), ('Terror'),
  ('Ciencia ficción'), ('Fantasía'), ('Romance'), ('Animación'),
  ('Documental'), ('Suspenso'), ('Crimen'), ('Familia'), ('Bélica');

-- Colecciones curadas --------------------------------------------------------
INSERT OR IGNORE INTO collections (slug, name, description, is_public, sort_order) VALUES
  ('estrenos',    'Estrenos',        'Lo último que agregamos', 1, 0),
  ('tendencias',  'Tendencias',      'Lo más visto esta semana', 1, 1),
  ('recomendados','Recomendados',    'Selección del equipo', 1, 2);

-- NOTA: crea tu primer admin 'owner' con contraseña hasheada (scrypt).
-- Genera el hash con el helper del backend y luego:
-- INSERT INTO admins (role_id, username, email, password_hash, display_name)
-- VALUES ((SELECT id FROM roles WHERE slug='owner'), 'mike', 'tu@correo.com', 'scrypt$....', 'Mike');
