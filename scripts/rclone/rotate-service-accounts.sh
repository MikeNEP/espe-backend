#!/usr/bin/env bash
# =============================================================================
# Rotación/selección de service accounts para rclone (ESPE Player)
# =============================================================================
# rclone puede rotar solo con `service_account_file_path`, pero este helper
# sirve para operaciones puntuales (copiar/sincronizar) donde quieras elegir
# una SA distinta en cada corrida y repartir la cuota manualmente.
#
# Uso:
#   ./rotate-service-accounts.sh            -> imprime la ruta de la próxima SA
#   ./rotate-service-accounts.sh copy A B   -> corre `rclone copy A B` con la SA elegida
#
# La "próxima" SA se elige de forma round-robin guardando el índice en un archivo.
set -euo pipefail

SA_DIR="${ESPE_SA_DIR:-/opt/espe/sa}"
STATE_FILE="${ESPE_SA_STATE:-/opt/espe/.sa_index}"

mapfile -t SAS < <(find "$SA_DIR" -maxdepth 1 -name '*.json' | sort)
COUNT=${#SAS[@]}
if [[ "$COUNT" -eq 0 ]]; then
  echo "No se encontraron service accounts (.json) en $SA_DIR" >&2
  exit 1
fi

# Índice round-robin persistente
idx=0
[[ -f "$STATE_FILE" ]] && idx=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
sa="${SAS[$((idx % COUNT))]}"
echo $(((idx + 1) % COUNT)) > "$STATE_FILE"

if [[ $# -eq 0 ]]; then
  # Solo imprime la SA elegida (útil para scripts)
  echo "$sa"
  exit 0
fi

# Ejecuta un comando rclone con la SA elegida
echo "[rotate] Usando $(basename "$sa") ($((idx % COUNT + 1))/$COUNT)" >&2
exec rclone "$@" --drive-service-account-file "$sa"
