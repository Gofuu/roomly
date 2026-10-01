#!/usr/bin/env bash
# Updates the live server to the newest image. Run from your own machine:
#
#   INSTANCE_ID=i-0123456789abcdef0 AWS_REGION=ap-south-1 ./deploy/deploy.sh
#
# It asks the server (through AWS Systems Manager, so no SSH port is open) to
# fetch the compose file and Caddyfile from GitHub, pull the image that CI
# built, and restart. The server needs /opt/roomly/.env (see .env.example).
set -euo pipefail

: "${INSTANCE_ID:?set INSTANCE_ID to the EC2 instance id}"
RAW=https://raw.githubusercontent.com/Gofuu/roomly/main/deploy

COMMANDS="cd /opt/roomly \
&& curl -fsSLO $RAW/docker-compose.yml \
&& curl -fsSLO $RAW/Caddyfile \
&& docker compose pull -q \
&& docker compose up -d --remove-orphans \
&& docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile \
&& docker image prune -f"

id=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters "commands=[\"$COMMANDS\"]" --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$id" --instance-id "$INSTANCE_ID" || true
aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
