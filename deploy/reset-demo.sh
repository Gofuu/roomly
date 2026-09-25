#!/usr/bin/env bash
# Nightly: restore the two demo companies (acme, northwind) to a clean state.
# Organizations that real visitors signed up are not touched.
set -euo pipefail
cd /opt/roomly
docker compose -f docker-compose.prod.yml run --rm --no-deps api node apps/api/dist/seed.js --reset-demo
