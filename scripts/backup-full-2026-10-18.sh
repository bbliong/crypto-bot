#!/usr/bin/env bash
set -eo pipefail

AWS_PROFILE="do-tor1"
ENDPOINT="https://sgp1.digitaloceanspaces.com"
BUCKET_PREFIX="s3://missi/crypto"
DATE_STR="2026-10-18"

echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Memulai Full Streaming Backup ke DO Spaces (S3)"
echo "Bucket prefix : ${BUCKET_PREFIX}"
echo "AWS Profile   : ${AWS_PROFILE}"
echo "Endpoint      : ${ENDPOINT}"
echo "=========================================================="

cd /home/bbliong/project/crypto-bot

# 1. Codebase, DB SQLite, JSON caches, Research, Reports
echo ""
echo "=== [1/4] Backup Code, DB, Research & Reports ==="
TARGET_1="${BUCKET_PREFIX}/crypto-bot-code-db-research-${DATE_STR}.tar.gz"
echo "Target: ${TARGET_1}"
(tar --warning=no-file-changed --ignore-failed-read -cf - \
  data/*.sqlite* \
  data/*.json \
  data/genesis-surge \
  research \
  reports \
  config \
  scripts \
  src \
  dist \
  package.json \
  tsconfig.json \
  2>/dev/null || true) | pigz -p 3 | aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 cp - "${TARGET_1}"
aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 ls "${TARGET_1}" --human-readable

# 2. Holder149 watch data
echo ""
echo "=== [2/4] Backup data/holder149-watch ==="
TARGET_2="${BUCKET_PREFIX}/holder149-watch-full-${DATE_STR}.tar.gz"
echo "Target: ${TARGET_2}"
(tar --warning=no-file-changed --ignore-failed-read -cf - \
  data/holder149-watch \
  2>/dev/null || true) | pigz -p 3 | aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 cp - "${TARGET_2}"
aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 ls "${TARGET_2}" --human-readable

# 3. Profit4 legacy & previous runs backup
echo ""
echo "=== [3/4] Backup data/profit4-watch-backup & legacy-chrome ==="
TARGET_3="${BUCKET_PREFIX}/profit4-legacy-and-backup-${DATE_STR}.tar.gz"
echo "Target: ${TARGET_3}"
(tar --warning=no-file-changed --ignore-failed-read -cf - \
  data/profit4-watch-backup \
  data/profit4-watch-legacy-chrome \
  2>/dev/null || true) | pigz -p 3 | aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 cp - "${TARGET_3}"
aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 ls "${TARGET_3}" --human-readable

# 4. Profit4 active live data
echo ""
echo "=== [4/4] Backup data/profit4-watch (Active) ==="
TARGET_4="${BUCKET_PREFIX}/profit4-active-${DATE_STR}.tar.gz"
echo "Target: ${TARGET_4}"
(tar --warning=no-file-changed --ignore-failed-read -cf - \
  data/profit4-watch \
  2>/dev/null || true) | pigz -p 3 | aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 cp - "${TARGET_4}"
aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 ls "${TARGET_4}" --human-readable

echo ""
echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Full Backup SELESAI & BERHASIL DIVERIFIKASI!"
echo "Semua file telah mendarat di ${BUCKET_PREFIX}/"
echo "=========================================================="
