-- =============================================================================
-- 005: Google Calendar sync via a transactional outbox.
--
-- Problem: after a booking commits, we must call Google's API. Calling it inside
-- the booking transaction would hold locks during a slow network call, and a
-- Google outage would fail bookings. Calling it after commit risks losing the
-- sync if the process dies in between.
--
-- Outbox: the booking transaction also inserts a job row, so the booking and its
-- job commit or roll back together. A background worker drains the jobs, retrying
-- with backoff. Here the jobs are inserted by a TRIGGER on bookings, so every
-- write path enqueues a job, including ones that aren't booking endpoints
-- (e.g. deactivating a member cancels their bookings).
-- =============================================================================

-- One Google account per user. The refresh token is encrypted by the app
-- (AES-256-GCM); the database never sees it in plaintext.
CREATE TABLE google_connections (
  user_id           uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  google_email      text NOT NULL,
  refresh_token_enc text NOT NULL,
  scopes            text NOT NULL,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

CREATE TABLE calendar_sync_outbox (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  booking_id  uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,  -- whose calendar
  action      text NOT NULL CHECK (action IN ('upsert', 'delete')),
  attempts    int NOT NULL DEFAULT 0,
  run_after   timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
-- The worker's "what's due?" query touches only pending rows.
CREATE INDEX calendar_sync_outbox_due ON calendar_sync_outbox (run_after) WHERE done_at IS NULL;

CREATE FUNCTION bookings_enqueue_calendar_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    next_action := CASE WHEN NEW.status = 'confirmed' THEN 'upsert' END;
  ELSIF NEW.status = 'cancelled' AND OLD.status = 'confirmed' THEN
    next_action := 'delete';
  ELSIF NEW.status = 'confirmed'
        AND (NEW.during, NEW.title, NEW.room_id) IS DISTINCT FROM (OLD.during, OLD.title, OLD.room_id) THEN
    next_action := 'upsert';
  END IF;

  -- Only for organizers who have connected Google. (A user who connects later
  -- gets their upcoming bookings backfilled at connection time.)
  IF next_action IS NOT NULL
     AND EXISTS (SELECT 1 FROM google_connections g WHERE g.user_id = NEW.user_id) THEN
    INSERT INTO calendar_sync_outbox (org_id, booking_id, user_id, action)
    VALUES (NEW.org_id, NEW.id, NEW.user_id, next_action);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER bookings_enqueue_calendar_sync
  AFTER INSERT OR UPDATE OF status, during, title, room_id ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_enqueue_calendar_sync();

-- Tenant isolation, as for every other tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['google_connections', 'calendar_sync_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())', t);
  END LOOP;
END $$;

-- The trigger runs as the app role, so it needs to read connections and add jobs.
-- The app role can see whether a connection exists, but never the token column.
GRANT SELECT (user_id, org_id, google_email, scopes, connected_at) ON google_connections TO :app_user;
GRANT DELETE ON google_connections TO :app_user;
GRANT INSERT ON calendar_sync_outbox TO :app_user;
GRANT SELECT ON calendar_sync_outbox TO :app_user;
GRANT USAGE ON SEQUENCE calendar_sync_outbox_id_seq TO :app_user;

-- The worker (system role) works across tenants and handles tokens.
GRANT SELECT, INSERT, UPDATE, DELETE ON google_connections, calendar_sync_outbox TO :system_user;
GRANT USAGE ON SEQUENCE calendar_sync_outbox_id_seq TO :system_user;
