#!/usr/bin/env bash
# Nightly logical backup of the database to S3 (bucket lifecycle keeps 7 days).
set -euo pipefail
cd /opt/roomly
source host.env
STAMP=$(date -u +%Y-%m-%dT%H%MZ)
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U postgres --format=custom roomly |
  aws s3 cp - "s3://${BUCKET}/backups/roomly-${STAMP}.dump" --region "$REGION"
echo "backup uploaded: backups/roomly-${STAMP}.dump"
