#!/bin/bash
set -e
echo "Starting streaming backup of October research and sqlite/json data to DO Spaces..."

tar --warning=no-file-changed -czf - \
  research/*2026-10-* \
  data/*.sqlite \
  | aws s3 cp - s3://missi/crypto/research-backup-oct-2026.tar.gz --profile do-tor1

echo "Streaming upload completed successfully!"
