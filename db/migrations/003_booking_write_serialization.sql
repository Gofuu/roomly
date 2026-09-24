-- =============================================================================
-- 003 — Serialize concurrent writers to the same room.
--
-- The exclusion constraint alone is already correct: overlaps can never be
-- stored. But its check runs *after* the new row's index entry is written. When
-- two transactions insert overlapping bookings at the same instant, each can find
-- the other's uncommitted entry and wait for it — a cycle. Postgres resolves the
-- cycle after deadlock_timeout (1s) by aborting one transaction with 40P01. Under
-- a burst of simultaneous requests for one room this becomes a chain of 1-second
-- stalls and aborted transactions.
--
-- This trigger takes a transaction-scoped advisory lock keyed on the room *before*
-- the row is inserted. Concurrent writers for the same room now queue in order:
-- the second waits for the first to commit, then its constraint check sees the
-- committed row and fails immediately with 23P01 — no cycle, no deadlock.
--
-- The lock is an optimisation, not the guarantee. The constraint still decides
-- what is allowed; the lock just makes contention fail fast and deterministically.
-- The cost is that bookings for one room are written one at a time, which is
-- harmless: a single room never sees meaningful write throughput.
-- =============================================================================

CREATE FUNCTION bookings_lock_room() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only writes that can create a conflict need the lock (cancellations cannot).
  IF NEW.status = 'confirmed' THEN
    IF TG_OP = 'UPDATE' AND OLD.room_id <> NEW.room_id THEN
      -- Moving between rooms: lock both, in a fixed order, so two opposite moves cannot deadlock.
      PERFORM pg_advisory_xact_lock(hashtextextended(r::text, 0))
        FROM unnest(ARRAY[OLD.room_id, NEW.room_id]) AS r ORDER BY r;
    ELSE
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.room_id::text, 0));
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bookings_lock_room
  BEFORE INSERT OR UPDATE OF room_id, during, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_lock_room();
