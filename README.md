---
name: Kill Switch
slug: agent-kill-switch
kind: plugin
sdkPackage: "@paperclipai/plugin-sdk"
installTarget: standalone
---

# Kill Switch

A big red emergency stop for the whole company. One action immediately halts
every agent, pauses in-flight work, and blocks any new task from starting. The
company stays frozen until a human on the board resolves the incident and
explicitly resumes with a required resolution note.

**Design stance: stop first, ask questions later.** Tripping is instant and
requires no reason. The resolution note is required only to *resume* —
human-in-the-loop is mandatory to un-halt, never to halt.

---

## What it does

- **Trip (instant).** Anyone authorized hits STOP. In one action the plugin:
  1. sets a HALT flag in plugin state (`tripped=true`, since, actor),
  2. host-pauses every agent in the company (the true stop), and
  3. writes a `trip` row to the tamper-evident audit log.
  No reason is required. If the company is already halted, tripping is a no-op.

- **Stay halted.** While tripped, the plugin actively keeps the company frozen:
  - lifecycle events (`issue.created`, `issue.updated`, `task.created`) that
    look like a *new start* re-assert the host pause (defense in depth) and log a
    `reassert` row;
  - a watchdog job re-pauses any agent that drifted back to running;
  - a `status` API route lets agents cooperatively refuse checkout in their
    HEARTBEAT even if the host pause surface is momentarily unavailable.

- **Annotate (optional).** Attach a follow-up note to the open incident at any
  time before resuming. Logged as an `annotate` row.

- **Resume (board only, note required).** The single path out of halt. A board
  actor supplies a non-empty resolution note; the plugin host-resumes all agents,
  clears the HALT flag, and logs a `resume` row with the note. Empty notes are
  rejected.

---

## Where it shows up

Three surfaces, one shared status hook:

| Slot | Label | What you see |
|------|-------|--------------|
| `dashboardWidget` | Kill Switch | Compact card. Running → big red **STOP ALL AGENTS** button (confirm-guarded). Halted → red banner "N agents paused • since … • by …" + Resume… (board only). |
| `sidebar` | Kill Switch | Minimal: status dot (green = running / red = halted) + STOP button, links to the full page. |
| `page` (`/:companyPrefix/killswitch`) | Kill Switch | Incident console: hero STOP / HALTED state, live agent table, audit history, and the resume panel with the required resolution-note textarea plus an optional annotate field. |

The STOP button uses the host's `var(--destructive)` / `var(--destructive-foreground)`
tokens — intentionally, unmistakably red, but still theme-correct and dark-mode-safe.

---

## ⚑ Two live-SDK unknowns to verify before install

This plugin depends on two host surfaces whose exact names must be reconciled
against the **live SDK** at render/install time. They are flagged here loudly
because the plugin's core promise (a *true* stop) rides on the first one.

1. **The real agent-pause capability / endpoint.** The brief assumes
   `agents.write` performs a host-enforced pause/resume of all company agents.
   The live SDK may instead expose this as a `companies.write` / company-pause
   surface. **Verify the exact capability and endpoint** before relying on the
   host pause.

2. **Widget + sidebar slot registration capability names.** The page slot uses
   `ui.page.register`. The dashboard-widget and sidebar slots may require
   distinct registration capabilities (e.g. `ui.dashboardWidget.register`,
   `ui.sidebar.register`). **Verify the exact slot registration cap names**
   against the live SDK.

### If the host has NO pause surface at all — cooperative-only degradation

If the runtime turns out to have no host-enforced agent-pause surface, this
plugin **degrades to cooperative-only** and you must know it:

- The **HALT flag** in plugin state is still set on trip and cleared on resume.
- The **`status` API route** still reports `{ tripped }`.
- Agents must honor the flag in their **HEARTBEAT contract** — checking the
  status route and refusing checkout while `tripped=true`.

In cooperative-only mode the switch is a *contract*, not an enforced kill: an
agent that ignores its HEARTBEAT will not be stopped. The event re-assert and
watchdog job become no-ops with nothing to enforce. **Do not present this plugin
as a hard kill unless the host pause surface (unknown #1) is confirmed live.**

---

## Enforcement model

Three layers, so a single failure does not un-freeze the company:

1. **Host pause** (the true stop) — pauses every agent via the host.
2. **HALT flag in plugin state**, exposed via the `status` route — agents honor
   it cooperatively in HEARTBEAT (the fallback if layer 1 is unavailable).
3. **Self-healing while tripped** — lifecycle-event re-assert plus a watchdog
   cron re-pause anything that drifts back to running.

Resume reverses layers 1 and 2 together, only via the board resume action with a
required note.

---

## Capabilities

Declared because each is actually used (read *and* write are separate gates and
fail silently if under-declared):

- `plugin.state.read`, `plugin.state.write` — HALT flag.
- `database.namespace.migrate`, `database.namespace.read`, `database.namespace.write` — audit log.
- `agents.read` — live agent list + paused counts.
- `agents.write` — ⚑ host pause/resume (see unknown #1).
- `events.subscribe` — issue/task lifecycle re-assert.
- `jobs.schedule` — watchdog cron.
- `api.routes.register` — `status` and `trip` HTTP routes.
- `companies.read` — company context.
- `ui.page.register` — ⚑ page slot (widget/sidebar cap names: see unknown #2).

No `ctx.assets`. No host UI component-kit imports.

---

## HTTP routes

Mounted under `/api/plugins/:pluginId/api/<path>`.

- **`status`** — `GET`, auth `board-or-agent`, `companyResolution { from: "query", key: "companyId" }`.
  Returns `{ tripped }` so agent HEARTBEAT checks can cooperatively refuse
  checkout even if the host pause is unavailable.
- **`trip`** — `POST`, auth `webhook`, `companyResolution { from: "query", key: "companyId" }`.
  Lets an external monitor (runaway-cost / anomaly detector) trip the switch —
  same effect as the in-app trip action.

---

## Data model

The plugin owns one table, `killswitch_events`, in its private SQL namespace
(schema `plugin_agent_kill_switch_<hash>`, derived deterministically from the
install id — hardcoded in the migration, no template substitution):

| column | notes |
|--------|-------|
| `id` | |
| `action` | one of `trip`, `annotate`, `resume`, `reassert` |
| `actor_id` | |
| `actor_type` | |
| `reason` | nullable — required only for `resume` |
| `created_at` | |

Newest-first, this is the incident audit trail shown on the page.

---

## Inputs

- **Env vars:** none.
- **Core read tables:** none.

---

## Install

Production install (npm is the deployable artifact):

```
pnpm add paperclip-plugin-agent-kill-switch
```

Development install from an absolute local path (dev-only; not a production
distribution path):

```
paperclipai plugin install /absolute/path/to/output/plugins/agent-kill-switch
```

Standalone builds snapshot the SDK into `.paperclip-sdk/` via the scaffold's
`--sdk-path` flag — run the scaffold command if you want that; it is not copied
by the factory.

## Local checks

Inside the plugin folder:

```
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

---

## Operating notes

- **Tripping never asks for a reason.** If you find yourself unable to stop the
  company without filling in a field, that is a bug — report it.
- **Resume always asks for a reason.** The resolution note is mandatory and the
  Resume button stays disabled until it is non-empty.
- **Only the board can resume.** The widget and sidebar Resume affordances route
  to the page's resume form; the action itself rejects non-board actors.
- **Verify the two ⚑ unknowns before trusting this as a hard kill.** Until the
  host pause surface is confirmed, treat the switch as cooperative-only.
