-- =============================================================================
-- 002 — Row-Level Security: tenant isolation enforced by Postgres.
--
-- Each API request runs inside a transaction that first does
--     SELECT set_config('app.org_id', '<org uuid from the JWT>', true)
-- The `true` makes the setting transaction-local, so it cannot leak to the next
-- request that reuses the same pooled connection.
--
-- The API connects as :app_user, which has NOBYPASSRLS. If app.org_id is unset,
-- current_org_id() is NULL, `org_id = NULL` is never true, and every query sees
-- zero rows — the policy fails closed.
--
-- Pre-tenant code paths (login lookup by email, refresh, webhooks, accepting an
-- invitation) use :system_user, which has BYPASSRLS. That role is used in a
-- handful of explicit places only.
-- =============================================================================

CREATE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

-- organizations is keyed by id rather than org_id.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (id = current_org_id())
  WITH CHECK (id = current_org_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'users', 'invitations', 'buildings', 'floors', 'rooms', 'bookings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE applies the policy to the table owner too (defence in depth; superusers still bypass).
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Grants. Least privilege for the app role: no DELETE on bookings (cancel is a
-- status change) or users (deactivate instead); no access at all to refresh_tokens.
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO :app_user, :system_user;

GRANT SELECT ON plans TO :app_user;
GRANT SELECT, UPDATE ON organizations TO :app_user;
GRANT SELECT ON subscriptions TO :app_user;
GRANT SELECT, INSERT, UPDATE ON users TO :app_user;
GRANT SELECT, INSERT, UPDATE ON invitations TO :app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON buildings, floors, rooms TO :app_user;
GRANT SELECT, INSERT, UPDATE ON bookings TO :app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  plans, organizations, subscriptions, users, invitations, refresh_tokens,
  buildings, floors, rooms, bookings
TO :system_user;
