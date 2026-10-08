#!/bin/bash
set -e

echo "=== Step 1: Starting streaming backup of October research (Oct 5 - Oct 8) and SQLite data to DO Spaces ==="
tar --warning=no-file-changed -czf - \
  research/momentum-aggressive-2026-10-05* \
  research/momentum-aggressive-2026-10-06* \
  research/momentum-aggressive-2026-10-07* \
  research/momentum-aggressive-2026-10-08* \
  data/*.sqlite* \
  | aws s3 cp - s3://missi/crypto/research-backup-oct-2026-batch3.tar.gz --profile do-tor1

echo "=== Upload completed successfully! Verifying S3 object... ==="
aws s3 ls s3://missi/crypto/research-backup-oct-2026-batch3.tar.gz --profile do-tor1 --human-readable

echo "=== Step 2: Removing local October research folders to reclaim disk space... ==="
rm -rf research/momentum-aggressive-2026-10-*

echo "=== Local research cleanup finished! Checking disk space: ==="
df -h /
