-- =============================================================================
-- 007 — The privileged role gets explicit policies instead of BYPASSRLS.
--
-- 002 gave the system role (login, refresh, webhooks, calendar worker) the
-- BYPASSRLS attribute. Managed Postgres such as AWS RDS doesn't let the admin
-- user grant that attribute, so instead each tenant table gets a policy that
-- applies only TO the system role. The effect is the same, it works everywhere,
-- and the exception is now visible in the schema: `\dp` lists it on every table.
--
-- The tenant policy from 002 still applies to the app role unchanged.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations', 'subscriptions', 'users', 'invitations', 'buildings', 'floors', 'rooms', 'bookings',
    'google_connections', 'calendar_sync_outbox'
  ] LOOP
    EXECUTE format('CREATE POLICY system_access ON %I TO :system_user USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
