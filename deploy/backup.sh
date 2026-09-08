#!/bin/sh
# Sauvegarde cohérente de la base SQLite (à planifier dans cron).
#   0 3 * * * /opt/familyboard/deploy/backup.sh >> /var/log/familyboard-backup.log 2>&1
set -eu

DB="${DATABASE_PATH:-/var/lib/familyboard/familyboard.db}"
DEST="${BACKUP_DIR:-/var/backups/familyboard}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)

# .backup copie la base à chaud, sans interrompre le service.
sqlite3 "$DB" ".backup '$DEST/familyboard-$STAMP.db'"
gzip -f "$DEST/familyboard-$STAMP.db"

find "$DEST" -name 'familyboard-*.db.gz' -mtime "+$KEEP_DAYS" -delete
echo "$(date -Is) sauvegarde effectuée : $DEST/familyboard-$STAMP.db.gz"
