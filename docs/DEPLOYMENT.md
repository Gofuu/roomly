# Deploying Roomly to AWS (budget setup)

One small ARM server runs the API and PostgreSQL with Docker Compose. CloudFront provides HTTPS and serves the web app from S3. GitHub Actions deploys with short-lived credentials (OIDC), so no AWS keys are stored anywhere.

**Estimated cost (ap-south-1, Mumbai):** about **US$10–15/month**: t4g.micro instance, 20 GB disk, one public IPv4 address, and CloudFront/S3 at demo traffic levels. A new AWS account's free-tier credits may cover the first months.

```
Browser ──HTTPS──► CloudFront  https://dxxxx.cloudfront.net
                    ├─ /*                     → S3 (site/, private, Origin Access Control)
                    └─ /api/* , /socket.io/*  → EC2 :80 (caching off, WebSockets on)
EC2 t4g.micro (Amazon Linux 2023, arm64) + Elastic IP
  └─ docker compose: postgres:17 → migrate (one-shot) → api
     security group: port 80 from CloudFront's IP list only, no SSH (admin via SSM Session Manager)
Secrets: SSM Parameter Store /roomly/* (generated on first deploy)
Nightly: pg_dump → S3 backups/ (kept 7 days), then reset of the demo companies
```

| File | Purpose |
|---|---|
| `infra/roomly-stack.yaml` | CloudFormation: server, security group, Elastic IP, S3 bucket, CloudFront, GitHub deploy role |
| `deploy/docker-compose.prod.yml` | Production containers on the server |
| `deploy/deploy.sh` | Runs on the server: writes `.env` from SSM, pulls the image, starts, health-checks, seeds if empty |
| `deploy/backup.sh`, `deploy/reset-demo.sh`, `deploy/systemd/*` | Nightly backup and demo reset (systemd timers) |
| `.github/workflows/ci.yml` (job `image`) | Builds the arm64 API image and pushes `ghcr.io/gofuu/roomly-api:<sha>` on `main` |
| `.github/workflows/deploy.yml` | Deploys after CI succeeds on `main`, or manually |

---

## One-time setup (≈ 20 minutes)

### 1. AWS account and safety rails
1. Create an account at <https://aws.amazon.com> (needs a card).
2. Signed in as root: **Security credentials → Assign MFA**.
3. **IAM Identity Center** → enable → create a user for yourself with the `AdministratorAccess` permission set. Sign in through the portal link from now on, and put root away.
4. **Billing → Budgets → Create budget → Monthly cost budget**: $15, with an alert to your email. Do this before creating anything.
5. Switch the console region (top right) to **Asia Pacific (Mumbai) ap-south-1**.

### 2. Create the infrastructure
1. **CloudFormation → Create stack → With new resources → Upload a template file** → `infra/roomly-stack.yaml`.
2. Stack name `roomly`. Keep the defaults (`t4g.micro`, repo `Gofuu/roomly`, create OIDC provider `true`).
3. Tick "I acknowledge that AWS CloudFormation might create IAM resources" → **Submit**.
4. Wait for `CREATE_COMPLETE` (~5–10 minutes; CloudFront is the slow part), then open the **Outputs** tab.

### 3. Connect GitHub
1. In the repo on GitHub, go to **Settings → Secrets and variables → Actions → Variables**. Add each stack output as a variable:

   | Variable | Output |
   |---|---|
   | `AWS_ROLE_ARN` | DeployRoleArn |
   | `AWS_REGION` | Region |
   | `S3_BUCKET` | BucketName |
   | `CLOUDFRONT_DISTRIBUTION_ID` | DistributionId |
   | `INSTANCE_ID` | InstanceId |
   | `SITE_URL` | SiteUrl |

2. The server pulls `ghcr.io/gofuu/roomly-api` without credentials. Because the repository is public, the package is already public; nothing to do. (If the repo is ever made private, set the package to Public in **Packages → roomly-api → Package settings**; the image contains no secrets.)

### 4. First deploy
**Actions → Deploy → Run workflow** (on `main`). The first run:
- generates `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` and all database passwords into SSM;
- uploads the site;
- starts the containers, runs migrations and seeds the demo companies;
- checks `https://<SiteUrl>/api/health`.

After that, every push to `main` deploys automatically once CI is green.

---

## Operating it

| Task | How |
|---|---|
| Shell on the server | EC2 → Instances → roomly → **Connect → Session Manager** (then `sudo -i; cd /opt/roomly`) |
| Logs | `docker compose -f docker-compose.prod.yml logs -f api` |
| Restart | `docker compose -f docker-compose.prod.yml restart api` |
| Manual backup | `bash /opt/roomly/backup.sh` (files in `s3://<bucket>/backups/`) |
| Reset demo now | `bash /opt/roomly/reset-demo.sh` |
| Restore a backup | `aws s3 cp s3://<bucket>/backups/<file>.dump - \| docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U postgres -d roomly --clean` |
| Timers | `systemctl list-timers 'roomly-*'`. Backup 02:00 IST, demo reset 02:30 IST |

### Enabling Stripe (optional)
1. In Stripe test mode, create two recurring prices (Pro, Enterprise). Add a webhook endpoint `https://<SiteUrl>/api/webhooks/stripe` for `customer.subscription.created`, `.updated` and `.deleted`.
2. Session Manager on the server (or CloudShell in the console):
   ```bash
   aws ssm put-parameter --name /roomly/STRIPE_SECRET_KEY --type SecureString --value 'sk_test_...'
   aws ssm put-parameter --name /roomly/STRIPE_WEBHOOK_SECRET --type SecureString --value 'whsec_...'
   aws ssm put-parameter --name /roomly/STRIPE_PRICE_PRO --type String --value 'price_...'
   aws ssm put-parameter --name /roomly/STRIPE_PRICE_ENTERPRISE --type String --value 'price_...'
   ```
3. Re-run the Deploy workflow.

### Enabling Google Calendar (optional)
1. Google Cloud Console: enable the Calendar API, set up the OAuth consent screen (External, add test users), and create a Web OAuth client with redirect URI `https://<SiteUrl>/api/integrations/google/callback`.
2. Store `/roomly/GOOGLE_CLIENT_ID` (String) and `/roomly/GOOGLE_CLIENT_SECRET` (SecureString) the same way, then redeploy.

---

## Security notes
- Only CloudFront can reach the server. Port 80 is restricted to CloudFront's managed prefix list, and there is no SSH port.
- CloudFront → EC2 traffic is plain HTTP inside AWS's network, because an HTTPS origin needs a certificate for a domain you own. With a custom domain, add an ACM certificate and Caddy/Let's Encrypt on the server, then switch the origin to `https-only`.
- Browser ↔ CloudFront is HTTPS. Refresh cookies are `Secure; HttpOnly; SameSite=Strict`.
- Secrets live only in SSM Parameter Store and a root-only `.env` on the server. The deploy role can only touch `/roomly/*`, this bucket's `site/` and `deploy/`, this distribution, and Run Command on this instance.
- Express trusts exactly one proxy hop (`TRUST_PROXY_HOPS=1`), so rate limits apply to the real client IP and can't be dodged by spoofing `X-Forwarded-For`.

## Tearing it down
Delete the `roomly` CloudFormation stack. The S3 bucket is **retained** on purpose (backups); empty and delete it manually if you're sure. Delete the `/roomly/*` parameters in Systems Manager.

---

## Scaling up later (managed setup)

When the demo needs more than one server:
- **Database:** move Postgres to **RDS** (`pg_dump` → restore). RDS supports `btree_gist` and `citext`, and migration 007 means no superuser-only features are needed.
- **API:** run the same image on **ECS Fargate** behind an **ALB** (health check `/api/health`), with 2+ tasks. Socket.io already fans out across instances through Postgres LISTEN/NOTIFY, and the calendar worker uses `SKIP LOCKED`, so no code changes are needed.
- **Proxy hops:** set `TRUST_PROXY_HOPS=2` (CloudFront → ALB → task).
- **Rate limiting:** move the rate-limit counters to a shared store.
- **Worker:** optionally run the calendar worker as its own service.
- **TLS to RDS:** `PGSSLMODE=verify-full` plus `NODE_EXTRA_CA_CERTS` pointing at the RDS CA bundle.
