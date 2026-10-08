#!/bin/bash
set -e
echo "Starting streaming backup of September research data to DO Spaces (using do-tor1)..."
tar -czf - research/*2026-09-* | aws s3 cp - s3://missi/crypto/research-backup-sept-2026.tar.gz --profile do-tor1

echo "Upload successful! Deleting local September folders to free up 12GB..."
rm -rf research/*2026-09-*
echo "Cleanup complete! Storage freed."
