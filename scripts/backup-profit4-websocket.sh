#!/usr/bin/env bash
set -eo pipefail

S3_DEST="s3://missi/crypto/profit4-websocket-backup-2026-10-10.tar.gz"
AWS_PROFILE="do-tor1"

echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Memulai streaming backup ke DO Spaces / AWS S3"
echo "Target S3: ${S3_DEST}"
echo "Profile: ${AWS_PROFILE}"
echo "=========================================================="

echo "[1/4] Memeriksa ukuran direktori sumber..."
du -sh data/profit4-watch data/holder149-watch data/*.sqlite* 2>/dev/null || true

echo "[2/4] Streaming arsip via tar + pigz langsung ke S3..."
# Peringatan file berubah diabaikan karena worker sedang aktif menulis frame
(tar --warning=no-file-changed --ignore-failed-read -cf - \
  data/profit4-watch \
  data/holder149-watch \
  data/*.sqlite* \
  config \
  scripts \
  src \
  dist \
  package.json \
  tsconfig.json \
  2>/dev/null || true) | pigz -p 3 | aws --profile "${AWS_PROFILE}" s3 cp - "${S3_DEST}"

echo "=========================================================="
echo "[3/4] Verifikasi file di S3..."
aws --profile "${AWS_PROFILE}" s3 ls "${S3_DEST}" --human-readable

echo "[4/4] Verifikasi header arsip yang telah terupload..."
aws --profile "${AWS_PROFILE}" s3 cp "${S3_DEST}" - | tar -tzf - | head -n 25 || true

echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup selesai dengan sukses!"
echo "Status disk saat ini:"
df -h /
echo "=========================================================="
