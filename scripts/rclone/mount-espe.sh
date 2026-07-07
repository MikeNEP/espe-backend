#!/usr/bin/env bash
# Monta el contenido de ESPE Player desde Google Drive con caché VFS.
# Ajusta REMOTE, MOUNT y CACHE a tu servidor. Pensado para usarse desde systemd.
set -euo pipefail

REMOTE="${ESPE_REMOTE:-gdrive:}"      # o "gcrypt:" si usas cifrado
MOUNT="${ESPE_MOUNT:-/mnt/espe}"
CACHE_DIR="${ESPE_CACHE_DIR:-/var/cache/rclone-espe}"
CACHE_SIZE="${ESPE_CACHE_SIZE:-100G}"
LOG="${ESPE_LOG:-/var/log/rclone-espe.log}"

mkdir -p "$MOUNT" "$CACHE_DIR"

exec rclone mount "$REMOTE" "$MOUNT" \
  --allow-other \
  --umask 002 \
  --cache-dir "$CACHE_DIR" \
  --dir-cache-time 168h \
  --vfs-cache-mode full \
  --vfs-cache-max-size "$CACHE_SIZE" \
  --vfs-cache-max-age 168h \
  --vfs-read-chunk-size 32M \
  --vfs-read-chunk-size-limit 512M \
  --buffer-size 256M \
  --poll-interval 15s \
  --drive-chunk-size 64M \
  --drive-acknowledge-abuse \
  --log-level INFO \
  --log-file "$LOG"
