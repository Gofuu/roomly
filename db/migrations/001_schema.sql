-- =============================================================================
-- 001: Tables.
--
-- Two ideas carry most of the weight:
--   1. Every company-owned row has an org_id, and child tables reference their
--      parent by (id, org_id). A room can therefore never sit on another
--      company's floor, and a booking can never point at another company's room.
--   2. A booking's time is one tstzrange value, and an EXCLUDE constraint makes
--      the database itself reject overlapping bookings for the same room.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- lets a GiST index compare uuids with "="
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email

CREATE TYPE user_role AS ENUM ('admin', 'employee');
CREATE TYPE booking_status AS ENUM ('confirmed', 'cancelled');

-- Plans are fixed reference data. The room limit lives here, not in code.
CREATE TABLE plans (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  room_limit          int,            -- NULL = unlimited
  monthly_price_cents int NOT NULL DEFAULT 0,
  sort_order          int NOT NULL DEFAULT 0
);

INSERT INTO plans (id, name, room_limit, monthly_price_cents, sort_order) VALUES
  ('free',       'Free',        3,     0, 0),
  ('pro',        'Pro',        25,  4900, 1),
  ('enterprise', 'Enterprise', NULL, 19900, 2);

-- A company using Roomly.
CREATE TABLE organizations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  slug                   text NOT NULL UNIQUE,
  plan_id                text NOT NULL DEFAULT 'free' REFERENCES plans (id),
  stripe_customer_id     text,
  stripe_subscription_id text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email         citext NOT NULL UNIQUE,  -- a person belongs to exactly one company
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'employee',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE INDEX users_org ON users (org_id);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        user_role NOT NULL DEFAULT 'employee',
  token_hash  text NOT NULL UNIQUE,  -- SHA-256 of the link's token; the token itself is never stored
  invited_by  uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invited_by, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);
-- At most one open invitation per email per company.
CREATE UNIQUE INDEX invitations_one_open ON invitations (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- One row per signed-in session. The row is replaced every time it is used.
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Spaces: building → floor → room.
CREATE TABLE buildings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  address    text,
  timezone   text NOT NULL,  -- IANA name such as Asia/Kolkata (validated by the API)
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
  is_active  boolean NOT NULL DEFAULT true,  -- rooms with history are deactivated, not deleted
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (floor_id, name),
  FOREIGN KEY (floor_id, org_id) REFERENCES floors (id, org_id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- Bookings: where double-booking is made impossible.
--
-- `during` is a half-open range [start, end), so 10:00–11:00 and 11:00–12:00
-- do not overlap and back-to-back meetings are fine.
--
-- bookings_no_overlap says: no two CONFIRMED rows may have the same room_id (=)
-- AND overlapping ranges (&&). Cancelling a booking takes it out of the rule
-- and frees the slot, while the row stays as history.
--
-- Why this is safe under concurrency: the rule is enforced through its index at
-- write time, like a UNIQUE constraint. If two transactions insert overlapping
-- bookings at once, the second waits for the first. If the first commits, the
-- second fails with error 23P01; if the first rolls back, the second succeeds.
-- "SELECT to check the slot is free, then INSERT" cannot give this guarantee,
-- because both transactions can see the slot as free.
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

  FOREIGN KEY (room_id, org_id) REFERENCES rooms (id, org_id),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id),

  CONSTRAINT bookings_valid_range CHECK (
        NOT isempty(during)
    AND NOT lower_inf(during) AND NOT upper_inf(during)
    AND lower_inc(during) AND NOT upper_inc(during)           -- exactly [start, end)
    AND upper(during) - lower(during) <= interval '12 hours'
  ),
  CONSTRAINT bookings_cancelled_consistent CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),
  CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (room_id WITH =, during WITH &&)
    WHERE (status = 'confirmed')
);
-- The constraint's index already serves "bookings for room X in window Y".
-- This one serves "my upcoming bookings".
CREATE INDEX bookings_user_start ON bookings (user_id, lower(during));

-- One writer per room at a time.
--
-- The constraint above already makes overlaps impossible. This trigger is about
-- waiting politely: before a booking is inserted or moved, it locks the room's
-- row, so requests for the same room queue up and are answered one by one.
-- Without it, many overlapping inserts arriving in the same instant can all end
-- up waiting on each other, and Postgres has to break that up as a deadlock,
-- one transaction per second. Bookings for different rooms do not wait.
CREATE FUNCTION lock_booked_room() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM rooms WHERE id = NEW.room_id FOR UPDATE;
  RETURN NEW;
END $$;

CREATE TRIGGER bookings_one_writer_per_room
  BEFORE INSERT OR UPDATE OF during ON bookings
  FOR EACH ROW EXECUTE FUNCTION lock_booked_room();
