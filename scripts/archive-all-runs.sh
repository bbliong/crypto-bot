#!/usr/bin/env bash
set -eo pipefail

AWS_PROFILE="do-tor1"
ENDPOINT="https://sgp1.digitaloceanspaces.com"
BUCKET_PREFIX="s3://missi/crypto"
DATE_STR="$(date '+%Y-%m-%d')"
NOW_TS="$(date '+%Y%m%d_%H%M%S')"

echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Memulai Full Archive & Fresh Reset Data"
echo "Target S3: ${BUCKET_PREFIX}"
echo "=========================================================="

cd /home/bbliong/project/crypto-bot

TARGET="${BUCKET_PREFIX}/crypto-bot-all-runs-archive-${DATE_STR}_${NOW_TS}.tar.gz"
echo "Mengunggah arsip ke ${TARGET} via stream..."

(tar --warning=no-file-changed --ignore-failed-read -cf - \
  data/momentum-watch \
  data/trend20m-watch \
  data/profit4-watch \
  data/smartmoney-watch \
  data/syndicate-watch \
  data/feed-hub \
  data/simulation-30m \
  data/backtest-trend20m-v2 \
  data/holder149-watch \
  data/curated-lowcap-smart-wallets.json \
  data/syndicate-candle-audit-results.json \
  data/convergence-monitor-events.json \
  data/smart-wallets-watchlist.json \
  data/crypto-bot.sqlite \
  data/crypto-bot.sqlite.bak* \
  2>/dev/null || true) | pigz -p 3 | aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 cp - "${TARGET}"

echo ""
echo "Verifikasi arsip di DO Spaces:"
aws --profile "${AWS_PROFILE}" --endpoint-url "${ENDPOINT}" s3 ls "${TARGET}" --human-readable

echo ""
echo "Membersihkan direktori runs lama..."

for grp in momentum-watch trend20m-watch profit4-watch smartmoney-watch syndicate-watch feed-hub holder149-watch; do
  dir="data/${grp}"
  if [ -d "$dir" ]; then
    echo "  -> Membersihkan ${dir}..."
    rm -rf "${dir}/202"* || true
    rm -f "${dir}/worker-control.json" || true
    rm -f "${dir}/real-state.json" || true
    rm -f "${dir}/real-trade-ledger.jsonl" || true
    rm -rf "${dir}/cached-mints" || true
    echo '{"updatedAt": '"$(date +%s000)"', "mints": []}' > "${dir}/bought-mints.json"
  fi
done

# Bersihkan archive pre-migration lawas (2.1GB)
rm -rf data/profit4-watch/archive-pre-migration || true

# Bersihkan backup sqlite lawas
rm -f data/crypto-bot.sqlite.bak-before-split-* || true
rm -rf data/archive-runs/* || true

echo ""
echo "Data direktori saat ini:"
du -sh data/*

echo ""
echo "Penggunaan disk setelah cleanup:"
df -h /home/bbliong

echo ""
echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] FULL ARCHIVE & CLEANUP SELESAI!"
echo "=========================================================="
