-- =============================================================================
-- 006 — Cross-instance Socket.io.
--
-- With several API instances behind a load balancer, a booking handled by
-- instance A must reach browsers connected to instance B. The Socket.io
-- Postgres adapter relays broadcasts through LISTEN/NOTIFY, so no Redis is
-- needed. Payloads too large for NOTIFY (8 KB) go through this table.
-- =============================================================================

CREATE TABLE socket_io_attachments (
  id         bigserial UNIQUE,
  created_at timestamptz DEFAULT now(),
  payload    bytea
);

GRANT SELECT, INSERT, DELETE ON socket_io_attachments TO :system_user;
GRANT USAGE ON SEQUENCE socket_io_attachments_id_seq TO :system_user;
