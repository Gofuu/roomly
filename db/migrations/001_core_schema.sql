-- =============================================================================
-- 001 — Core schema: tenants, users, spaces, bookings.
--
-- Two ideas carry most of the weight here:
--   1. Every tenant-owned row carries org_id, and child tables reference their
--      parent by (id, org_id). A row can therefore never point at a parent that
--      belongs to a different organization — even if application code is buggy.
--   2. bookings.during is a tstzrange guarded by an EXCLUDE constraint, so the
--      database itself rejects overlapping bookings for the same room, including
--      under concurrent inserts (see the long comment on bookings below).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- lets a GiST index do "=" on uuid
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email

CREATE TYPE user_role AS ENUM ('admin', 'employee');
CREATE TYPE booking_status AS ENUM ('confirmed', 'cancelled');

-- True if Postgres recognises tz as a time zone name. Declared IMMUTABLE so it can
-- be used in a CHECK; the tz database changing underneath us is an accepted edge.
CREATE FUNCTION is_valid_timezone(tz text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  PERFORM now() AT TIME ZONE tz;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN false;
END $$;

-- -----------------------------------------------------------------------------
-- Plans: fixed reference data. Limits live here, not in application constants.
-- -----------------------------------------------------------------------------
CREATE TABLE plans (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  room_limit      int CHECK (room_limit IS NULL OR room_limit >= 0),  -- NULL = unlimited
  monthly_price_cents int NOT NULL DEFAULT 0,
  sort_order      int NOT NULL DEFAULT 0
);

INSERT INTO plans (id, name, room_limit, monthly_price_cents, sort_order) VALUES
  ('free',       'Free',        3,     0, 0),
  ('pro',        'Pro',        25,  4900, 1),
  ('enterprise', 'Enterprise', NULL, 19900, 2);

-- -----------------------------------------------------------------------------
-- Tenancy & identity
-- -----------------------------------------------------------------------------
CREATE TABLE organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  plan_id            text NOT NULL DEFAULT 'free' REFERENCES plans (id),
  stripe_customer_id text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Mirror of the org's Stripe subscription, written only by webhook handlers.
CREATE TABLE subscriptions (
  org_id                 uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  plan_id                text NOT NULL REFERENCES plans (id),
  status                 text NOT NULL,  -- Stripe's status string: active, past_due, canceled, ...
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email         citext NOT NULL UNIQUE,  -- globally unique: a user belongs to exactly one org
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'employee',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)  -- target for tenant-safe composite foreign keys
);
CREATE INDEX users_org ON users (org_id);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        user_role NOT NULL DEFAULT 'employee',
  token_hash  text NOT NULL UNIQUE,  -- SHA-256 of the emailed token; the token itself is never stored
  invited_by  uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invited_by, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);
-- At most one open invitation per email per org.
CREATE UNIQUE INDEX invitations_one_open ON invitations (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Refresh tokens are only ever touched by the auth code path (system role), never
-- by tenant-scoped queries, so this table has no org_id and no RLS policy.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,  -- all tokens descended from one login share a family
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

-- -----------------------------------------------------------------------------
-- Spaces: building → floor → room, each hop a composite (id, org_id) FK.
-- -----------------------------------------------------------------------------
CREATE TABLE buildings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  address    text,
  timezone   text NOT NULL CHECK (is_valid_timezone(timezone)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, name)
);

CREATE TABLE floors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  building_id uuid NOT NULL,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  level       int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (building_id, level),
  FOREIGN KEY (building_id, org_id) REFERENCES buildings (id, org_id) ON DELETE CASCADE
);

CREATE TABLE rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  floor_id   uuid NOT NULL,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  capacity   int NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  amenities  text[] NOT NULL DEFAULT '{}',
  is_active  boolean NOT NULL DEFAULT true,  -- deactivate instead of deleting rooms with history
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (floor_id, name),
  FOREIGN KEY (floor_id, org_id) REFERENCES floors (id, org_id) ON DELETE CASCADE
);
CREATE INDEX rooms_org_active ON rooms (org_id) WHERE is_active;

-- -----------------------------------------------------------------------------
-- Bookings — the double-booking guarantee lives here.
--
-- `during` is a half-open range [start, end). Half-open means 10:00–11:00 and
-- 11:00–12:00 do NOT overlap, so back-to-back meetings are allowed.
--
-- bookings_no_overlap says: no two rows may have the same room_id (=) AND
-- overlapping ranges (&&) — counting only confirmed bookings (the WHERE clause),
-- so cancelling a booking frees its slot while keeping the history row.
--
-- Why this is race-proof: the constraint is enforced through its GiST index at
-- write time, like a UNIQUE constraint. If two transactions insert overlapping
-- bookings concurrently, the second finds the first's not-yet-committed entry and
-- WAITS for it. If the first commits, the second fails with SQLSTATE 23P01
-- (exclusion_violation); if the first rolls back, the second succeeds. This holds
-- at the default READ COMMITTED isolation level with no explicit locking.
-- A "SELECT to check the slot is free, then INSERT" approach cannot give this
-- guarantee: both transactions' SELECTs can see the slot as free.
-- -----------------------------------------------------------------------------
CREATE TABLE bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  room_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  title        text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  during       tstzrange NOT NULL,
  status       booking_status NOT NULL DEFAULT 'confirmed',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,

  -- Tenant-safe references: the room and the booker must belong to the booking's org.
  FOREIGN KEY (room_id, org_id) REFERENCES rooms (id, org_id),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id),

  CONSTRAINT bookings_valid_range CHECK (
        NOT isempty(during)
    AND NOT lower_inf(during) AND NOT upper_inf(during)
    AND lower_inc(during) AND NOT upper_inc(during)            -- exactly [start, end)
    AND upper(during) - lower(during) <= interval '12 hours'
    AND date_trunc('minute', lower(during)) = lower(during)    -- whole minutes only
    AND date_trunc('minute', upper(during)) = upper(during)
  ),
  CONSTRAINT bookings_cancelled_consistent CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),
  CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (room_id WITH =, during WITH &&)
    WHERE (status = 'confirmed')
);
-- The exclusion constraint's GiST index already serves "bookings for room X in
-- window Y" queries. This one serves "my upcoming bookings".
CREATE INDEX bookings_user_start ON bookings (user_id, lower(during));
