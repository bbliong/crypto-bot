#!/usr/bin/env bash
set -eo pipefail

# ==============================================================================
# Auto Archive & Cleanup Chunks ke DigitalOcean Spaces (S3)
# ==============================================================================
# 1. Mencari chunk log 30-menit yang sudah selesai ditulis.
# 2. Mengompresi chunk dan streaming upload ke S3 / DO Spaces.
# 3. Menghapus chunk lokal yang berumur > 3 jam untuk menjaga disk tetap hemat.
# 4. Ringkasan profit4-state.json tetap dipertahankan utuh untuk dashboard.
# ==============================================================================

export PATH="/home/bbliong/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

PROJECT_DIR="/home/bbliong/project/crypto-bot"
DATA_DIR="${PROJECT_DIR}/data/profit4-watch"
S3_BUCKET="s3://missi/crypto/profit4-chunks"
AWS_PROFILE="do-tor1"
LOG_FILE="/tmp/auto-archive-chunks.log"
LOCK_FILE="/tmp/auto-archive-chunks.lock"

# Pastikan hanya 1 instance yang berjalan
exec 200>"${LOCK_FILE}"
if ! flock -n 200; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Archive process already running, skipping." >> "${LOG_FILE}"
  exit 0
fi

echo "==========================================================" >> "${LOG_FILE}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting auto-archive & cleanup..." >> "${LOG_FILE}"

cd "${PROJECT_DIR}"

CURRENT_TIME_SEC=$(date +%s)
# 3 jam = 10800 detik
RETENTION_SEC=10800
# Chunk yang sedang aktif ditulis (dalam 30 menit terakhir) tidak boleh diupload/dihapus
SAFETY_BUFFER_SEC=1800

# Loop semua run directory di profit4-watch
for RUN_DIR in "${DATA_DIR}"/*/; do
  [ -d "${RUN_DIR}" ] || continue
  CHUNKS_DIR="${RUN_DIR}chunks"
  [ -d "${CHUNKS_DIR}" ] || continue

  RUN_NAME=$(basename "${RUN_DIR}")

  for CHUNK_PATH in "${CHUNKS_DIR}"/*/; do
    [ -d "${CHUNK_PATH}" ] || continue
    CHUNK_NAME=$(basename "${CHUNK_PATH}")
    ARCHIVE_MARKER="${CHUNK_PATH}.archived"

    # Periksa waktu modifikasi direktori chunk
    CHUNK_MTIME=$(stat -c %Y "${CHUNK_PATH}" 2>/dev/null || echo "${CURRENT_TIME_SEC}")
    AGE_SEC=$((CURRENT_TIME_SEC - CHUNK_MTIME))

    # Jangan proses chunk yang masih aktif ditulis (< 30 menit)
    if [ "${AGE_SEC}" -lt "${SAFETY_BUFFER_SEC}" ]; then
      continue
    fi

    # 1. UPLOAD KE S3 JIKA BELUM TERUPLOAD
    if [ ! -f "${ARCHIVE_MARKER}" ]; then
      S3_TARGET="${S3_BUCKET}/${RUN_NAME}/${CHUNK_NAME}.tar.gz"
      echo "[UPLOAD] Archiving ${RUN_NAME}/${CHUNK_NAME} to ${S3_TARGET}..." >> "${LOG_FILE}"

      # Streaming kompresi menggunakan pigz jika ada, fallback ke gzip
      COMPRESS_CMD="gzip"
      if command -v pigz >/dev/null 2>&1; then
        COMPRESS_CMD="pigz -p 2"
      fi

      if (tar -C "${CHUNKS_DIR}" -cf - "${CHUNK_NAME}" 2>/dev/null || true) | ${COMPRESS_CMD} | aws --profile "${AWS_PROFILE}" s3 cp - "${S3_TARGET}" >> "${LOG_FILE}" 2>&1; then
        touch "${ARCHIVE_MARKER}"
        echo "[SUCCESS] Uploaded ${CHUNK_NAME} to S3." >> "${LOG_FILE}"
      else
        echo "[ERROR] Failed to upload ${CHUNK_NAME} to S3." >> "${LOG_FILE}"
        continue
      fi
    fi

    # 2. HAPUS DATA LOKAL JIKA UMURNYA > 3 JAM (10800 detik) DAN SUDAH TERUPLOAD
    if [ "${AGE_SEC}" -gt "${RETENTION_SEC}" ] && [ -f "${ARCHIVE_MARKER}" ]; then
      CHUNK_SIZE=$(du -sh "${CHUNK_PATH}" | cut -f1)
      echo "[CLEANUP] Deleting local chunk (> 3 hours old, size: ${CHUNK_SIZE}): ${RUN_NAME}/${CHUNK_NAME}" >> "${LOG_FILE}"
      rm -rf "${CHUNK_PATH}"
    fi
  done

  # Jika run sesi lama sudah kosong chunks-nya, hapus folder chunks kosongnya
  if [ -d "${CHUNKS_DIR}" ] && [ -z "$(ls -A "${CHUNKS_DIR}" 2>/dev/null)" ]; then
    rm -rf "${CHUNKS_DIR}"
  fi
done

# Ringkasan kapasitas disk setelah proses
FREED_INFO=$(df -h "${PROJECT_DIR}" | awk 'NR==2 {print "Disk Used: " $3 " / " $2 " (" $5 " used, " $4 " available)"}')
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Archive & cleanup completed. ${FREED_INFO}" >> "${LOG_FILE}"
echo "==========================================================" >> "${LOG_FILE}"
