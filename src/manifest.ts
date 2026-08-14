import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Kill Switch — a company-wide emergency halt.
 *
 * One action trips the switch: it sets a HALT flag in plugin.state, asks the
 * host to pause every agent in the company (agents.write — the true stop), and
 * appends an audit row. The company stays frozen until a board member resumes
 * with a REQUIRED resolution note. Design stance: stop first, ask questions
 * later — tripping is instant and reasonless; the note is required only to
 * resume.
 *
 * Enforcement is layered (defense in depth):
 *   (1) host pause via agents.write            — the real stop
 *   (2) HALT flag in plugin.state, exposed via the read-only `status` API route
 *       so agents can cooperatively refuse checkout in HEARTBEAT even if the
 *       host pause surface is unavailable
 *   (3) event re-assert + watchdog job         — self-healing while tripped
 * Resume reverses (1) and (2) together, and only via the board resume action.
 *
 * ⚑ Two live-SDK unknowns to pin during Render (see capability comments):
 *   - the exact agent-pause capability/endpoint (may be a companies.write /
 *     company-pause surface instead of agents.write); if the runtime exposes no
 *     host pause at all, degrade to cooperative-only and say so in the README.
 *   - the widget/sidebar slot-registration capability names.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "agent-kill-switch",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Kill Switch",
  description:
    "A big red emergency kill-switch for the whole company. One action immediately halts every agent, pauses in-flight work, and blocks any new task from starting. The company stays frozen until the board explicitly resumes with a required resolution note. Tripping is instant and needs no reason; resuming is human-in-the-loop and always does.",
  author: "@herrhelms",
  categories: ["automation"],
  capabilities: [
    // HALT flag lives in ctx.state (company-scoped) so it survives reinstalls
    // and migration changes. The host gates reads and writes via SEPARATE
    // capabilities — declaring only .write lets `trip` save the flag but
    // ctx.state.get returns null on the next render, so the UI (and the status
    // route agents poll) would think the company is running. Declare both.
    "plugin.state.read",
    "plugin.state.write",
    // Private SQL namespace for the killswitch_events audit log
    // (trip / annotate / resume / reassert). Three independent capabilities.
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    // agents.read — live agent list (id, name, paused) for the status counts
    // and the incident-console table. Agent display name is agent.name.
    "agents.read",
    // agents.write ⚑ — host-enforced pause/resume of every company agent. This
    // is the true kill. VERIFY the exact capability/endpoint against the live
    // SDK before shipping — it may instead be a companies.write / company-pause
    // surface. If NO host pause surface exists at all, drop this capability,
    // fall back to cooperative-only (HALT flag + status route + heartbeat
    // contract) and document that loudly in the README.
    "agents.write",
    // events.subscribe — issue/task lifecycle. While tripped, any new
    // transition into in-progress is a new-start attempt: re-assert the host
    // pause and append a `reassert` audit row. (Read PluginEvent fields from
    // the top level: event.eventType / event.companyId / event.actorId /
    // event.occurredAt — never event.payload.)
    "events.subscribe",
    // api.routes.register — callable HTTP surface: `status` (agents poll it to
    // cooperatively refuse checkout) and `trip` (an external monitor can trip
    // the switch on runaway-cost / anomaly).
    "api.routes.register",
    // jobs.schedule — watchdog cron: while tripped, re-assert the host pause on
    // any agent that has drifted back to running. No-op when not tripped.
    "jobs.schedule",
    // companies.read — resolve the company display name for readable audit/log
    // context instead of an opaque UUID. Falls back silently when denied.
    "companies.read",
    // ui.page.register — the full incident-console page slot.
    "ui.page.register",
    // ⚑ VERIFY the widget + sidebar slot-registration capability names against
    // the live SDK before shipping — they are likely distinct from
    // ui.page.register (e.g. ui.dashboardWidget.register / ui.sidebar.register).
    // If the live SDK requires them, add them here alongside ui.page.register.
    "ui.dashboardWidget.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui",
  },
  database: {
    migrationsDir: "migrations",
    // No core host tables are read — the audit log lives entirely in the
    // plugin's own SQL namespace, and agent state comes from agents.read.
    coreReadTables: [],
  },
  jobs: [
    {
      jobKey: "killswitch-watchdog",
      displayName: "Kill Switch watchdog",
      description:
        "While the switch is tripped, re-assert the host pause on any agent that has drifted back to running. No-op when not tripped. Idempotent.",
      schedule: "*/3 * * * *",
    },
  ],
  apiRoutes: [
    {
      // Agents poll this in HEARTBEAT so they cooperatively refuse checkout even
      // if the host pause surface is unavailable. Returns { tripped }.
      routeKey: "status",
      method: "GET",
      path: "/status",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      // Lets an external monitor (runaway-cost / anomaly detector) trip the
      // switch — same effect as the in-UI `trip` action.
      routeKey: "trip",
      method: "POST",
      path: "/trip",
      auth: "webhook",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "killswitch-widget",
        displayName: "Kill Switch",
        exportName: "KillSwitchWidget",
      },
      {
        type: "sidebar",
        id: "killswitch-sidebar",
        displayName: "Kill Switch",
        exportName: "KillSwitchSidebar",
      },
      {
        type: "page",
        id: "killswitch-page",
        displayName: "Kill Switch",
        exportName: "KillSwitchPage",
        // Host validation: routePath must be a single lowercase slug — letters,
        // numbers, hyphens; no slashes. Mounts at /:companyPrefix/killswitch.
        routePath: "killswitch",
      },
    ],
  },
};

export default manifest;
