#!/usr/bin/env bash
# Runs ON the EC2 host (invoked by the GitHub "Deploy" workflow through SSM Run Command).
#   deploy.sh <image-tag> <bucket> <region>
# Idempotent: safe to re-run with the same tag.
set -euo pipefail

TAG="${1:?image tag}"
BUCKET="${2:?bucket}"
REGION="${3:?region}"
APP_DIR=/opt/roomly
IMAGE="ghcr.io/gofuu/roomly-api:${TAG}"
cd "$APP_DIR"

echo "==> Writing environment from SSM Parameter Store (/roomly/*)"
umask 077
{
  # Secrets and per-deployment values (JWT_SECRET, passwords, WEB_ORIGIN, optional STRIPE_*/GOOGLE_*).
  aws ssm get-parameters-by-path --region "$REGION" --path /roomly/ --with-decryption \
    --query 'Parameters[*].[Name,Value]' --output text |
    while IFS=$'\t' read -r name value; do printf '%s=%s\n' "${name#/roomly/}" "$value"; done
  cat <<EOF
API_IMAGE=${IMAGE}
NODE_ENV=production
DB_NAME=roomly
PG_SUPERUSER=postgres
APP_DB_USER=roomly_app
SYSTEM_DB_USER=roomly_system
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
INVITE_TTL_DAYS=7
RATE_LIMIT_AUTH_PER_MINUTE=20
TRUST_PROXY_HOPS=1
MIGRATIONS_DIR=/app/db/migrations
EOF
} > .env.new
WEB_ORIGIN=$(grep '^WEB_ORIGIN=' .env.new | cut -d= -f2-)
echo "GOOGLE_REDIRECT_URI=${WEB_ORIGIN}/api/integrations/google/callback" >> .env.new
mv .env.new .env
umask 022
printf 'BUCKET=%s\nREGION=%s\n' "$BUCKET" "$REGION" > host.env

echo "==> Installing systemd timers (nightly backup + demo reset)"
cp systemd/roomly-*.service systemd/roomly-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now roomly-backup.timer roomly-demo-reset.timer

echo "==> Starting ${IMAGE}"
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans

echo "==> Waiting for /api/health"
for i in $(seq 1 60); do
  if curl -fsS http://localhost/api/health > /dev/null; then echo "healthy"; break; fi
  if [ "$i" = 60 ]; then
    docker compose -f docker-compose.prod.yml logs --tail 80 api migrate
    exit 1
  fi
  sleep 2
done

echo "==> Seeding demo companies if the database is empty"
docker compose -f docker-compose.prod.yml run --rm --no-deps api node apps/api/dist/seed.js --if-empty

docker image prune -f > /dev/null
echo "==> Deployed ${IMAGE}"
