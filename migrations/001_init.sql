CREATE TABLE IF NOT EXISTS plugin_agent_kill_switch_ef032069aa.killswitch_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action      TEXT        NOT NULL CHECK (action IN ('trip', 'annotate', 'resume', 'reassert')),
  actor_id    TEXT,
  actor_type  TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS killswitch_events_created_at_idx
  ON plugin_agent_kill_switch_ef032069aa.killswitch_events (created_at DESC);
