import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

/**
 * Kill Switch — a company-wide emergency HALT.
 *
 * Design stance: stop first, ask questions later. Tripping is instant and
 * requires no reason. The company stays frozen until a board actor explicitly
 * resumes with a REQUIRED resolution note. Human-in-the-loop is mandatory to
 * un-halt.
 *
 * Enforcement is layered (defense in depth):
 *   1. Host pause via agents.write — the true stop.
 *   2. HALT flag in plugin.state, exposed via the `status` API route so agents
 *      can cooperatively refuse checkout in HEARTBEAT even if host pause is
 *      unavailable.
 *   3. Event re-assert + watchdog job — self-healing while tripped.
 *
 * Resume reverses (1) and (2) together, only via the board `resume` action
 * with a non-empty note.
 *
 * ⚑ Two live-SDK surfaces are pinned behind small helpers below
 * (pauseAllAgents / resumeAllAgents). If the runtime exposes no host pause at
 * all, they degrade to no-ops and the plugin runs cooperative-only (HALT flag
 * + status route + heartbeat contract) — see README.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActorType = "board" | "agent" | "webhook" | "system";

type KillSwitchAction = "trip" | "annotate" | "resume" | "reassert";

interface HaltState {
  tripped: boolean;
  since: string | null;
  actorId: string | null;
  actorType: ActorType | null;
  reason: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  paused: boolean;
}

interface StatusView {
  tripped: boolean;
  since: string | null;
  actorId: string | null;
  actorType: ActorType | null;
  reason: string | null;
  pausedAgentCount: number;
  totalAgentCount: number;
}

interface EventRow {
  id: string;
  action: KillSwitchAction;
  actorId: string | null;
  actorType: string | null;
  reason: string | null;
  createdAt: string;
}

const HALT_STATE_KEY = "killswitch:halt";

const CLEARED_STATE: HaltState = {
  tripped: false,
  since: null,
  actorId: null,
  actorType: null,
  reason: null,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toActorType(value: unknown): ActorType {
  return value === "board" || value === "agent" || value === "webhook"
    ? value
    : "system";
}

function readHaltState(raw: unknown): HaltState {
  if (!raw || typeof raw !== "object") return { ...CLEARED_STATE };
  const r = raw as Partial<HaltState>;
  return {
    tripped: r.tripped === true,
    since: typeof r.since === "string" ? r.since : null,
    actorId: typeof r.actorId === "string" ? r.actorId : null,
    actorType: r.actorType ? toActorType(r.actorType) : null,
    reason: typeof r.reason === "string" ? r.reason : null,
  };
}

/**
 * Load the live agent roster. Display name is `agent.name` (see live Agent
 * type). `paused` is best-effort — the runtime field name is reconciled here
 * so the rest of the worker can rely on a stable shape.
 */
async function listAgents(ctx: any, companyId: string): Promise<AgentRow[]> {
  const raw = (await ctx.agents.list({ companyId })) ?? [];
  return (Array.isArray(raw) ? raw : []).map((a: any): AgentRow => ({
    id: String(a.id),
    name: typeof a.name === "string" && a.name.length > 0 ? a.name : String(a.id),
    paused: a.paused === true || a.status === "paused" || a.state === "paused",
  }));
}

/**
 * ⚑ Host-enforced pause of every agent in the company (the true kill).
 * Idempotent: already-paused agents are skipped. Degrades to a no-op if the
 * runtime exposes no pause surface — cooperative fallback still applies.
 * Returns the number of agents newly paused this call.
 */
async function pauseAllAgents(ctx: any, companyId: string): Promise<number> {
  if (!ctx.agents || typeof ctx.agents.pause !== "function") return 0;
  const agents = await listAgents(ctx, companyId);
  let paused = 0;
  for (const agent of agents) {
    if (agent.paused) continue;
    try {
      await ctx.agents.pause({ companyId, agentId: agent.id });
      paused += 1;
    } catch (err) {
      ctx.log?.warn?.("killswitch: failed to pause agent", { agentId: agent.id, err: String(err) });
    }
  }
  return paused;
}

/**
 * ⚑ Host-enforced resume of every agent. Only reachable from the board
 * `resume` action. Idempotent. Degrades to a no-op with cooperative fallback.
 */
async function resumeAllAgents(ctx: any, companyId: string): Promise<number> {
  if (!ctx.agents || typeof ctx.agents.resume !== "function") return 0;
  const agents = await listAgents(ctx, companyId);
  let resumed = 0;
  for (const agent of agents) {
    if (!agent.paused) continue;
    try {
      await ctx.agents.resume({ companyId, agentId: agent.id });
      resumed += 1;
    } catch (err) {
      ctx.log?.warn?.("killswitch: failed to resume agent", { agentId: agent.id, err: String(err) });
    }
  }
  return resumed;
}

/** Append one row to the killswitch_events audit table (plugin's own schema). */
async function appendEvent(
  ctx: any,
  row: {
    action: KillSwitchAction;
    actorId: string | null;
    actorType: string | null;
    reason: string | null;
    createdAt: string;
  },
): Promise<void> {
  const ns = ctx.db.namespace;
  await ns.query(
    `INSERT INTO killswitch_events (action, actor_id, actor_type, reason, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.action, row.actorId, row.actorType, row.reason, row.createdAt],
  );
}

/** Persist the HALT flag. */
async function writeHaltState(ctx: any, next: HaltState): Promise<void> {
  await ctx.state.set(HALT_STATE_KEY, next);
}

/** Read the HALT flag (fast path — no agent query). */
async function loadHaltState(ctx: any): Promise<HaltState> {
  return readHaltState(await ctx.state.get(HALT_STATE_KEY));
}

// ---------------------------------------------------------------------------
// Core operations (shared by actions, events, jobs, and API routes)
// ---------------------------------------------------------------------------

/**
 * Trip the switch. Instant, no reason required. Idempotent: if already tripped,
 * re-asserts the host pause but does not overwrite the incident's origin.
 */
async function trip(
  ctx: any,
  args: { companyId: string; actorId: string | null; actorType: ActorType; occurredAt: string; reason?: string | null },
): Promise<StatusView> {
  const current = await loadHaltState(ctx);
  const pausedNow = await pauseAllAgents(ctx, args.companyId);

  if (current.tripped) {
    // Already halted — treat as defense-in-depth re-assertion.
    await appendEvent(ctx, {
      action: "reassert",
      actorId: args.actorId,
      actorType: args.actorType,
      reason: null,
      createdAt: args.occurredAt,
    });
  } else {
    await writeHaltState(ctx, {
      tripped: true,
      since: args.occurredAt,
      actorId: args.actorId,
      actorType: args.actorType,
      reason: args.reason ?? null,
    });
    await appendEvent(ctx, {
      action: "trip",
      actorId: args.actorId,
      actorType: args.actorType,
      reason: args.reason ?? null,
      createdAt: args.occurredAt,
    });
  }

  ctx.log?.warn?.("killswitch: TRIPPED", { pausedNow, actorType: args.actorType });
  return buildStatus(ctx, args.companyId);
}

/**
 * Attach/append a follow-up reason note to the current open incident. Optional;
 * a way to record context before resuming. No-op reject if not tripped.
 */
async function annotate(
  ctx: any,
  args: { companyId: string; actorId: string | null; actorType: ActorType; occurredAt: string; note: string },
): Promise<StatusView> {
  const current = await loadHaltState(ctx);
  if (!current.tripped) {
    throw new Error("Cannot annotate: the kill switch is not tripped.");
  }
  const note = (args.note ?? "").trim();
  if (note.length === 0) {
    throw new Error("Annotation note must not be empty.");
  }
  await writeHaltState(ctx, { ...current, reason: note });
  await appendEvent(ctx, {
    action: "annotate",
    actorId: args.actorId,
    actorType: args.actorType,
    reason: note,
    createdAt: args.occurredAt,
  });
  return buildStatus(ctx, args.companyId);
}

/**
 * Resume — the ONLY path out of halt. Board actor only. Resolution note
 * REQUIRED (empty is rejected). Reverses host pause and clears the HALT flag
 * together, then appends the resolution row.
 */
async function resume(
  ctx: any,
  args: { companyId: string; actorId: string | null; actorType: ActorType; occurredAt: string; note: string },
): Promise<StatusView> {
  if (args.actorType !== "board") {
    throw new Error("Only a board actor may resume the company from HALT.");
  }
  const note = (args.note ?? "").trim();
  if (note.length === 0) {
    throw new Error("A resolution note is required to resume.");
  }
  const current = await loadHaltState(ctx);
  if (!current.tripped) {
    // Nothing to resume — return current status without side effects.
    return buildStatus(ctx, args.companyId);
  }

  await resumeAllAgents(ctx, args.companyId);
  await writeHaltState(ctx, { ...CLEARED_STATE });
  await appendEvent(ctx, {
    action: "resume",
    actorId: args.actorId,
    actorType: args.actorType,
    reason: note,
    createdAt: args.occurredAt,
  });

  ctx.log?.warn?.("killswitch: RESUMED by board");
  return buildStatus(ctx, args.companyId);
}

/**
 * Re-assert the host pause while tripped (defense in depth). Called from the
 * event handler on any new-start attempt and from the watchdog job. No-op when
 * not tripped. Idempotent.
 */
async function reassert(
  ctx: any,
  args: { companyId: string; occurredAt: string; trigger: ActorType },
): Promise<void> {
  const current = await loadHaltState(ctx);
  if (!current.tripped) return;
  const pausedNow = await pauseAllAgents(ctx, args.companyId);
  if (pausedNow > 0) {
    await appendEvent(ctx, {
      action: "reassert",
      actorId: null,
      actorType: args.trigger,
      reason: null,
      createdAt: args.occurredAt,
    });
    ctx.log?.warn?.("killswitch: re-asserted pause on drifted agents", { pausedNow, trigger: args.trigger });
  }
}

/** Build the composite status view: fast HALT flag + live agent counts. */
async function buildStatus(ctx: any, companyId: string): Promise<StatusView> {
  const halt = await loadHaltState(ctx);
  const agents = await listAgents(ctx, companyId);
  return {
    tripped: halt.tripped,
    since: halt.since,
    actorId: halt.actorId,
    actorType: halt.actorType,
    reason: halt.reason,
    pausedAgentCount: agents.filter((a) => a.paused).length,
    totalAgentCount: agents.length,
  };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  setup(ctx: any) {
    // -----------------------------------------------------------------------
    // DATA (read-only fetchers → usePluginData)
    // -----------------------------------------------------------------------

    // 'status' → current HALT flag + agent counts. Drives all three UI exports.
    ctx.data.register("status", async (input: any): Promise<StatusView> => {
      return buildStatus(ctx, input.companyId);
    });

    // 'agents' → live roster { id, name, paused } for the incident console table.
    ctx.data.register("agents", async (input: any): Promise<AgentRow[]> => {
      return listAgents(ctx, input.companyId);
    });

    // 'events' → killswitch_events audit rows, newest first.
    ctx.data.register("events", async (): Promise<EventRow[]> => {
      const ns = ctx.db.namespace;
      const rows = await ns.query(
        `SELECT id, action, actor_id, actor_type, reason, created_at
           FROM killswitch_events
          ORDER BY created_at DESC, id DESC
          LIMIT 200`,
      );
      const list = (rows?.rows ?? rows ?? []) as any[];
      return list.map((r): EventRow => ({
        id: String(r.id),
        action: r.action,
        actorId: r.actor_id ?? null,
        actorType: r.actor_type ?? null,
        reason: r.reason ?? null,
        createdAt: r.created_at,
      }));
    });

    // -----------------------------------------------------------------------
    // ACTIONS (mutations → usePluginAction)
    // -----------------------------------------------------------------------

    // 'trip' — instant, no reason required.
    ctx.actions.register("trip", async (input: any): Promise<StatusView> => {
      return trip(ctx, {
        companyId: input.companyId,
        actorId: input.actorId ?? null,
        actorType: toActorType(input.actorType),
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        reason: typeof input.reason === "string" ? input.reason : null,
      });
    });

    // 'annotate' — optional follow-up note on the open incident.
    ctx.actions.register("annotate", async (input: any): Promise<StatusView> => {
      return annotate(ctx, {
        companyId: input.companyId,
        actorId: input.actorId ?? null,
        actorType: toActorType(input.actorType),
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        note: String(input.note ?? input.reason ?? ""),
      });
    });

    // 'resume' — board only, resolution note REQUIRED. The only path out of halt.
    ctx.actions.register("resume", async (input: any): Promise<StatusView> => {
      return resume(ctx, {
        companyId: input.companyId,
        actorId: input.actorId ?? null,
        actorType: toActorType(input.actorType),
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        note: String(input.note ?? input.reason ?? ""),
      });
    });

    // -----------------------------------------------------------------------
    // EVENTS (events.subscribe) — while tripped, any new transition into
    // in-progress is a new-start attempt → re-assert host pause (defense in
    // depth) + append a 'reassert' row. Read PluginEvent fields from the top
    // level (NOT event.payload).
    // -----------------------------------------------------------------------

    const onNewStartAttempt = async (event: any): Promise<void> => {
      await reassert(ctx, {
        companyId: event.companyId,
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        trigger: "system",
      });
    };

    // Reconcile exact lifecycle types against the live SDK; these are the
    // transitions that represent work (re-)starting.
    ctx.events.on("issue.created", onNewStartAttempt);
    ctx.events.on("issue.updated", onNewStartAttempt);
    ctx.events.on("task.created", onNewStartAttempt);

    // -----------------------------------------------------------------------
    // JOBS (jobs.schedule) — watchdog: while tripped, re-assert host pause on
    // any agent that drifted back to running. No-op when not tripped.
    // Idempotent.
    // -----------------------------------------------------------------------

    ctx.jobs.register("killswitch-watchdog", async (input: any): Promise<void> => {
      await reassert(ctx, {
        companyId: input.companyId,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        trigger: "system",
      });
    });
  },

  // -------------------------------------------------------------------------
  // API ROUTES — onApiRequest switches on input.routeKey.
  // -------------------------------------------------------------------------
  async onApiRequest(input: any) {
    switch (input.routeKey) {
      // 'status' (GET, auth board-or-agent) → { tripped } so agent HEARTBEAT.md
      // checks can cooperatively refuse checkout even if host pause is
      // unavailable (cooperative-fallback surface).
      case "status": {
        const halt = await loadHaltState(input.ctx);
        return {
          status: 200,
          body: {
            tripped: halt.tripped,
            since: halt.since,
          },
        };
      }

      // 'trip' (POST, auth webhook) → lets an external monitor (runaway-cost /
      // anomaly detector) trip the switch. Same effect as the trip action.
      case "trip": {
        const ctx = input.ctx;
        const occurredAt = new Date().toISOString();
        let reason: string | null = null;
        const body = input.body;
        if (body && typeof body === "object" && typeof body.reason === "string") {
          reason = body.reason;
        }
        const view = await trip(ctx, {
          companyId: input.companyId,
          actorId: input.actorId ?? null,
          actorType: "webhook",
          occurredAt,
          reason,
        });
        return {
          status: 200,
          body: { tripped: view.tripped, since: view.since },
        };
      }

      default:
        return { status: 404, body: { error: "Unknown route" } };
    }
  },
});

runWorker(plugin, import.meta.url);

export default plugin;
