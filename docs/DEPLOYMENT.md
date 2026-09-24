# Deploying to AWS

The target setup, and why each piece was chosen.

```
            ┌──────────── CloudFront (one domain, HTTPS) ────────────┐
 browser ──►│  /*            → S3 bucket (apps/web/dist)             │
            │  /api/*        → ALB → ECS Fargate service (API)       │
            │  /socket.io/*  → ALB → ECS Fargate service (API)       │
            └────────────────────────────────────────────────────────┘
                                   │
                          RDS PostgreSQL 17 (private subnets)
```

| Piece | Choice | Why |
|---|---|---|
| API | **ECS Fargate** (or App Runner) running the `Dockerfile` image | Socket.io needs long-lived connections, which Lambda can't hold. |
| Database | **RDS PostgreSQL 17** | Needs real Postgres: `btree_gist`, exclusion constraints, RLS and LISTEN/NOTIFY. DynamoDB can't express the overlap constraint. |
| Frontend | **S3 + CloudFront** | A static SPA. Serving it on the same domain as `/api` keeps the `SameSite=Strict` refresh cookie working with no CORS. |
| Secrets | **SSM Parameter Store / Secrets Manager**, injected as env vars | `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, DB passwords, Stripe and Google keys. |

## Steps

1. **RDS.** Create PostgreSQL 17 in private subnets and note the master user and password. RDS supports the `btree_gist` and `citext` extensions, and migration 001 creates them.
2. **Secrets.** Generate production values (the API refuses to start in production with the dev `JWT_SECRET` or `TOKEN_ENCRYPTION_KEY`):
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # TOKEN_ENCRYPTION_KEY
   ```
   Also pick passwords for `roomly_app` and `roomly_system`.
3. **Image.** `docker build -t roomly-api .`, then push it to ECR.
4. **Migrate** (once per deploy, before the new version starts): run a one-off ECS task with the same image and command `node apps/api/dist/migrate.js`. It needs `PG_SUPERUSER`/`PG_SUPERUSER_PASSWORD` (the RDS master user), `DB_NAME`, the two role passwords, and TLS settings (below). It creates or updates the two login roles and applies pending migrations, each in its own transaction.
   **TLS to RDS:** node-postgres reads `PGSSLMODE` from the environment in every pool (API and migrations). Set `PGSSLMODE=verify-full` and `NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem` (download AWS's RDS CA bundle into the image).
5. **Service.** Create an ECS service with 2+ tasks behind an ALB:
   - health check: `/api/health`, which returns 503 if the database is unreachable;
   - env: `NODE_ENV=production`, `WEB_ORIGIN=https://<your domain>`, `PGHOST`, `DB_NAME`, the role credentials, `STRIPE_*`, `GOOGLE_*`, `GOOGLE_REDIRECT_URI=https://<domain>/api/integrations/google/callback`.
   - Multiple tasks are fine. Socket.io broadcasts cross tasks through the Postgres adapter, and the calendar worker uses `SKIP LOCKED`. Use ALB sticky sessions only if you enable long-polling (the client uses WebSocket only).
6. **Frontend.** Run `npm run build -w @roomly/web`, upload `apps/web/dist` to S3, and add CloudFront behaviours for `/api/*` and `/socket.io/*` pointing at the ALB (forward all headers, cookies and query strings; no caching). Add a 404→`/index.html` rewrite for client-side routes.
7. **Stripe.** Add a webhook endpoint at `https://<domain>/api/webhooks/stripe` for `customer.subscription.created`, `.updated` and `.deleted`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
8. **Google.** Add the production redirect URI to the OAuth client and publish the consent screen (or keep it in testing mode with named test users).

## Before real production traffic

- The auth rate limiter uses in-memory counters per task; switch to a shared store (Redis or Postgres) so limits count across tasks.
- Run the calendar worker as its own ECS service instead of inside the API process (change one line in `apps/api/src/index.ts`).
- Add structured logging (pino) and error tracking (Sentry). Turn on RDS automated backups and Performance Insights.
- Email delivery for invitations (SES). Admins currently copy the invite link.
