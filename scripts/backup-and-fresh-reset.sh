#!/usr/bin/env bash
set -eo pipefail

AWS_PROFILE="do-tor1"
ENDPOINT="https://sgp1.digitaloceanspaces.com"
BUCKET_PREFIX="s3://missi/crypto"
DATE_STR="2026-10-20"
NOW_TS="$(date '+%Y%m%d_%H%M%S')"

echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Memulai Backup & Fresh Reset System"
echo "Bucket prefix : ${BUCKET_PREFIX}"
echo "Endpoint      : ${ENDPOINT}"
echo "=========================================================="

cd /home/bbliong/project/crypto-bot

# 0. Hentikan worker sementara untuk integritas data snapshot
echo ""
echo "=== [0/5] Menghentikan worker services sementara ==="
systemctl --user stop crypto-bot-trend20m-worker.service || true
systemctl --user stop crypto-bot-momentum-worker.service || true
systemctl --user stop crypto-bot-smartmoney-worker.service || true
systemctl --user stop crypto-bot-syndicate-worker.service || true
systemctl --user stop crypto-bot-bounce-worker.service || true
sleep 2

# 1. Backup Code, DB, Research, Reports & Configs
echo ""
echo "=== [1/5] Backup Code, DB, Research, Reports & Config ==="
TARGET_1="${BUCKET_PREFIX}/crypto-bot-code-db-research-${DATE_STR}_${NOW_TS}.tar.gz"
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

# 2. Backup Full Watch Data (Momentum, Syndicate, SmartMoney, Trend20m, Profit4, Holder149)
echo ""
echo "=== [2/5] Backup Watch Data Groups & Active Runs ==="
TARGET_2="${BUCKET_PREFIX}/crypto-bot-all-watch-groups-${DATE_STR}_${NOW_TS}.tar.gz"
echo "Target: ${TARGET_2}"
(tar --warning=no-file-changed --ignore-failed-read -cf - \
  data/momentum-watch \
  data/syndicate-watch \
  data/smartmoney-watch \
  data/trend20m-watch \
  data/profit4-watch \
  data/holder149-watch \
  data/archive-runs \
  2>/dev/null || true) | pigz -p 3 | aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 cp - "${TARGET_2}"
aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 ls "${TARGET_2}" --human-readable

# 3. Backup Legacy folders jika belum
if [ -d "data/profit4-watch-backup" ] || [ -d "data/profit4-watch-legacy-chrome" ]; then
  echo ""
  echo "=== [3/5] Backup Legacy Chrome & Backup Dirs ==="
  TARGET_3="${BUCKET_PREFIX}/profit4-legacy-and-backup-${DATE_STR}_${NOW_TS}.tar.gz"
  echo "Target: ${TARGET_3}"
  (tar --warning=no-file-changed --ignore-failed-read -cf - \
    data/profit4-watch-backup \
    data/profit4-watch-legacy-chrome \
    2>/dev/null || true) | pigz -p 3 | aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 cp - "${TARGET_3}"
  aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 ls "${TARGET_3}" --human-readable
fi

# 4. Melakukan Fresh Reset Direktori Data Run
echo ""
echo "=== [4/5] Melakukan Fresh Reset Direktori Run ==="

# Bersihkan direktori legacy lama untuk hemat disk space
rm -rf data/profit4-watch-backup data/profit4-watch-legacy-chrome || true
rm -rf data/archive-runs/* || true

# Reset run folders di masing-masing grup (folder 202*)
for grp in momentum-watch syndicate-watch smartmoney-watch trend20m-watch profit4-watch; do
  dir="data/${grp}"
  if [ -d "$dir" ]; then
    echo "Membersihkan run lama di ${dir}..."
    rm -rf ${dir}/202* || true
    rm -f ${dir}/worker-control.json || true
    echo '{"updatedAt": '"$(date +%s000)"', "mints": []}' > "${dir}/bought-mints.json"
  fi
done

# 5. Restart semua layanan agar berjalan di clean state
echo ""
echo "=== [5/5] Menyalakan kembali worker dan dashboard ==="
systemctl --user start crypto-bot-bounce-worker.service
sleep 4
systemctl --user start crypto-bot-momentum-worker.service
systemctl --user start crypto-bot-smartmoney-worker.service
systemctl --user start crypto-bot-syndicate-worker.service
systemctl --user start crypto-bot-trend20m-worker.service
systemctl --user restart crypto-bot-profit4-dashboard.service

echo ""
echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] FRESH RESET & BACKUP SELESAI!"
echo "=========================================================="
