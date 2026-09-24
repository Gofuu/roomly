-- =============================================================================
-- 004 — Stripe webhook bookkeeping.
--
-- stripe_events makes webhook handling idempotent. Stripe delivers events "at
-- least once", so the same event can arrive twice. The handler inserts the
-- event id in the same transaction as its side effects. A duplicate hits the
-- primary key and is skipped. If processing fails, the whole transaction
-- (including the id) rolls back, so Stripe's retry is processed normally.
--
-- subscriptions.last_event_at handles ordering. Stripe does not guarantee
-- delivery order, so an older "incomplete" update can arrive after a newer
-- "active" one. We only apply an event if it is at least as new as the last
-- one applied.
-- =============================================================================

CREATE TABLE stripe_events (
  id          text PRIMARY KEY,  -- Stripe's evt_... id
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscriptions
  ADD COLUMN last_event_at timestamptz NOT NULL DEFAULT '-infinity';

GRANT SELECT, INSERT ON stripe_events TO :system_user;

-- Only the webhook path (system role) may change an org's plan. The tenant role
-- keeps UPDATE on the columns an admin legitimately edits, which also still
-- lets it take the org row lock (SELECT ... FOR UPDATE needs UPDATE on some column).
REVOKE UPDATE ON organizations FROM :app_user;
GRANT UPDATE (name, stripe_customer_id) ON organizations TO :app_user;
