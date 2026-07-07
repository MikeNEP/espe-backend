# Base de datos — ESPE Player

Esquema relacional profesional de la plataforma. Ver el detalle de cada tabla en
[../docs/DATA-MODEL.md](../docs/DATA-MODEL.md).

## Archivos
- **`schema.sql`** — estructura completa (tablas, índices, vistas).
- **`seed.sql`** — datos iniciales (roles, ajustes, planes, géneros, colecciones).

## Cargar en SQLite (recomendado para empezar)

```bash
cd espe-backend
sqlite3 data/espe.db < db/schema.sql
sqlite3 data/espe.db < db/seed.sql

# Verificar
sqlite3 data/espe.db ".tables"
sqlite3 data/espe.db "SELECT slug, price_cents, quality FROM plans;"
```

SQLite ya viene con WAL activado en el esquema: buen rendimiento para lecturas
concurrentes sin instalar nada.

## Migrar a PostgreSQL (cuando escales)

El esquema es casi idéntico; los cambios principales:

| SQLite | PostgreSQL |
|---|---|
| `INTEGER PRIMARY KEY` | `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` |
| Fechas en `TEXT` (ISO-8601) | `TIMESTAMPTZ` |
| `strftime('%Y-%m-%dT%H:%M:%SZ','now')` | `now()` |
| `INTEGER` booleanos (0/1) | `BOOLEAN` |

Los `CHECK`, `FOREIGN KEY`, `UNIQUE` e índices se mantienen igual. Recomendado
usar una herramienta de migraciones (ej. Flyway o migraciones propias) al pasar
a Postgres.

## Conectar el backend

El backend actual (`src/`) usa archivos JSON. Para adoptar esta base:

1. Empezar con **SQLite** y una capa de acceso a datos (repositorios) por entidad.
2. Opciones de driver:
   - `node:sqlite` (nativo, experimental en Node 22+),
   - o `better-sqlite3` (síncrono, muy usado) si se acepta una dependencia.
3. Migrar los módulos JSON (`store.js`, `requests.js`, `settings.js`) a consultas SQL,
   manteniendo la misma interfaz pública para no tocar `server.js`.

> Este paquete entrega la **base de datos y el modelo**; la migración del código
> del backend a SQL puede hacerse de forma incremental, tabla por tabla.

## Convenciones
- Dinero en **centavos** (`INTEGER`).
- Fechas en **UTC ISO-8601**.
- Estados válidos definidos con `CHECK` (ver DATA-MODEL.md).
