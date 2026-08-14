# Changelog

All notable changes to `@herrhelms/agent-kill-switch` are documented here.

## 0.1.0 — unreleased

Initial release.

- Company-wide emergency **Kill Switch**: one instant, reasonless action halts every agent.
- Layered enforcement: host pause (`agents.write`), a HALT flag in plugin state exposed via a
  `status` API route agents can poll, event re-assert on new task starts, and a watchdog job.
- Human-in-the-loop resume: board-only, with a **required** resolution note.
- Durable incident/audit log in the plugin's own SQL namespace (`killswitch_events`).
- Three surfaces: dashboard widget, sidebar button, and a full incident-console page.

> Two live-SDK bindings are marked ⚑ in `src/manifest.ts` and must be verified before release:
> the exact agent-pause capability/endpoint, and the widget/sidebar slot-registration capability
> names. If the runtime exposes no host pause surface, the plugin degrades to cooperative-only.
