-- 001_init.sql — Kill Switch incident/audit log.
--
-- Applied inside the plugin's own SQL namespace (schema resolved by the host at
-- migration time; the worker composes queries via ctx.db.namespace, using the
-- unqualified table name below). Mutations are restricted to this schema.
--
-- One row per lifecycle event on the switch:
--   trip     — the switch was tripped (instant, reason optional/null)
--   annotate — a follow-up reason note was attached to the open incident
--   resume   — the board cleared the halt (reason REQUIRED, enforced in worker)
--   reassert — while tripped, a drifted-back agent was re-paused (defense in depth)

CREATE TABLE IF NOT EXISTS killswitch_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action      TEXT        NOT NULL CHECK (action IN ('trip', 'annotate', 'resume', 'reassert')),
  actor_id    TEXT,
  actor_type  TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The console lists newest-first; index the sort key.
CREATE INDEX IF NOT EXISTS killswitch_events_created_at_idx
  ON killswitch_events (created_at DESC);
