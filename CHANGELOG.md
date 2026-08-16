# Changelog

All notable changes to `@herrhelms/agent-kill-switch` are documented here.

## 0.1.0 — unreleased

Initial release. Verified end-to-end against a live Paperclip host (v2026.707.0):
install, migration, trip/resume/annotate actions, host-enforced agent pause/resume,
audit log, and the `status`/`trip` API routes.

- Company-wide emergency **Kill Switch**: one instant, reasonless action halts every agent.
- Layered enforcement: host pause via `agents.pause` / `agents.resume` (the true, enforced
  kill), a HALT flag in company-scoped plugin state exposed via a `status` API route agents
  can poll, event re-assert on new-work signals, and a watchdog job that sweeps every company.
- Human-in-the-loop resume: board-only (`context.actor.type === "user"`), with a **required**
  resolution note.
- Durable incident/audit log in the plugin's own SQL namespace
  (`plugin_agent_kill_switch_ef032069aa.killswitch_events`).
- Three surfaces: dashboard widget, sidebar button, and a full incident-console page.

Reconciled from the generated scaffold against the real `@paperclipai/plugin-sdk`:

- Corrected the pause capability to `agents.pause` / `agents.resume` (was the non-existent
  `agents.write`).
- Rewrote the worker's host-interaction layer to the real SDK: `ctx.db.query` / `ctx.db.execute`
  with schema-qualified table names, company-scoped `ctx.state` scope keys, positional
  `ctx.agents.pause(agentId, companyId)`, valid event types, and captured-`ctx` API routing.
- Schema-qualified the migration to the deterministic plugin namespace (migrations run as
  literal SQL, no template substitution).
- Switched the programmatic `trip` route from `webhook` to `board-or-agent` auth (webhook-auth
  routes need a host signature verifier a standard install lacks).
