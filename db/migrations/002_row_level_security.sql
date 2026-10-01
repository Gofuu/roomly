-- =============================================================================
-- 002: Row-Level Security. Postgres itself keeps companies' data apart.
--
-- Each API request runs in a transaction that first does
--     SELECT set_config('app.org_id', '<org id from the login token>', true)
-- The `true` makes the setting last only for that transaction, so it cannot
-- leak to the next request that reuses the same pooled connection.
--
-- The API connects as :app_user, an ordinary role. On the tables below, every
-- query is filtered to the current company and every write is checked. If no
-- company is set, current_org_id() is NULL and the tables look empty.
--
-- organizations, users, invitations and refresh_tokens are not covered here:
-- login and invitation links have to find a row before the company is known.
-- The API filters those by org_id in its queries.
-- =============================================================================

CREATE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['buildings', 'floors', 'rooms', 'bookings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t);
  END LOOP;
END $$;

-- The app role gets only what it needs. Bookings and users are never deleted:
-- a booking is cancelled and a user is deactivated.
GRANT USAGE ON SCHEMA public TO :app_user;
GRANT SELECT ON plans TO :app_user;
GRANT SELECT, INSERT, UPDATE ON organizations, users, invitations, bookings TO :app_user;
GRANT SELECT, INSERT, DELETE ON refresh_tokens TO :app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON buildings, floors, rooms TO :app_user;
