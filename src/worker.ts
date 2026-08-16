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
 *   1. Host pause via ctx.agents.pause — the true stop.
 *   2. HALT flag in company-scoped plugin.state, exposed via the `status` API
 *      route so agents can cooperatively refuse checkout in HEARTBEAT even if a
 *      host pause slips.
 *   3. Event re-assert (on new-work signals) + watchdog job — self-healing
 *      while tripped.
 *
 * Resume reverses (1) and (2) together, only via the board `resume` action with
 * a non-empty note.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActorType = "board" | "agent" | "webhook" | "system";

/**
 * The audit-log action vocabulary, as a runtime value so the worker and its
 * tests share one source of truth. `KillSwitchAction` is derived from it.
 */
export const KILLSWITCH_ACTIONS = [
  "trip",
  "annotate",
  "resume",
  "reassert",
] as const;

export type KillSwitchAction = (typeof KILLSWITCH_ACTIONS)[number];

/**
 * Resume (and annotate) require a non-empty resolution note. Null, undefined,
 * empty, and whitespace-only are all rejected. This is the human-in-the-loop
 * gate on leaving HALT.
 */
export function isValidResumeNote(note: unknown): boolean {
  return typeof note === "string" && note.trim().length > 0;
}

/**
 * Tripping needs no reason (stop-first), so a missing/blank reason normalizes
 * to null; a provided reason is trimmed. Keeps the audit log free of "" and
 * "   " noise.
 */
export function normalizeReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
  status: string;
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

const HALT_STATE_KEY = "halt";

const CLEARED_STATE: HaltState = {
  tripped: false,
  since: null,
  actorId: null,
  actorType: null,
  reason: null,
};

// Agent statuses that cannot (or need not) be paused/resumed. `terminated`
// throws on pause/resume; `paused` is already at rest.
const UNPAUSABLE = new Set(["paused", "terminated"]);

// The worker captures its PluginContext during setup so lifecycle hooks that
// the host calls WITHOUT a ctx argument (onApiRequest) can reach the host
// clients. setup runs once before any request is routed.
let activeCtx: any = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toActorType(value: unknown): ActorType {
  return value === "board" || value === "agent" || value === "webhook"
    ? value
    : "system";
}

/** Map the host's authenticated action actor to our audit vocabulary. */
function actorTypeFromContext(context: any): ActorType {
  const t = context?.actor?.type;
  if (t === "user") return "board";
  if (t === "agent") return "agent";
  return "system";
}

function actorIdFromContext(context: any): string | null {
  return context?.actor?.userId ?? context?.actor?.agentId ?? null;
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

/** Company-scoped state key for the HALT flag. */
function haltScope(companyId: string) {
  return { scopeKind: "company", scopeId: companyId, stateKey: HALT_STATE_KEY };
}

/** Read the HALT flag (fast path — no agent query). */
async function loadHaltState(ctx: any, companyId: string): Promise<HaltState> {
  return readHaltState(await ctx.state.get(haltScope(companyId)));
}

/** Persist the HALT flag. */
async function writeHaltState(
  ctx: any,
  companyId: string,
  next: HaltState,
): Promise<void> {
  await ctx.state.set(haltScope(companyId), next);
}

/** Fully-qualified audit table name inside the plugin's own SQL namespace. */
function eventsTable(ctx: any): string {
  return `${ctx.db.namespace}.killswitch_events`;
}

/**
 * Load the live agent roster. Display name is `agent.name`; an agent is paused
 * when its status is `"paused"`.
 */
async function listAgents(ctx: any, companyId: string): Promise<AgentRow[]> {
  const raw = (await ctx.agents.list({ companyId })) ?? [];
  return (Array.isArray(raw) ? raw : []).map((a: any): AgentRow => {
    const status = typeof a.status === "string" ? a.status : "unknown";
    return {
      id: String(a.id),
      name: typeof a.name === "string" && a.name.length > 0 ? a.name : String(a.id),
      status,
      paused: status === "paused",
    };
  });
}

/**
 * Host-enforced pause of every pausable agent in the company (the true kill).
 * Idempotent: already-paused and terminated agents are skipped. Returns the
 * number of agents newly paused this call.
 */
async function pauseAllAgents(ctx: any, companyId: string): Promise<number> {
  const agents = await listAgents(ctx, companyId);
  let paused = 0;
  for (const agent of agents) {
    if (UNPAUSABLE.has(agent.status)) continue;
    try {
      await ctx.agents.pause(agent.id, companyId);
      paused += 1;
    } catch (err) {
      ctx.logger?.warn?.("killswitch: failed to pause agent", {
        agentId: agent.id,
        err: String(err),
      });
    }
  }
  return paused;
}

/**
 * Host-enforced resume of every paused agent. Only reachable from the board
 * `resume` action. Idempotent.
 */
async function resumeAllAgents(ctx: any, companyId: string): Promise<number> {
  const agents = await listAgents(ctx, companyId);
  let resumed = 0;
  for (const agent of agents) {
    if (agent.status !== "paused") continue;
    try {
      await ctx.agents.resume(agent.id, companyId);
      resumed += 1;
    } catch (err) {
      ctx.logger?.warn?.("killswitch: failed to resume agent", {
        agentId: agent.id,
        err: String(err),
      });
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
  await ctx.db.execute(
    `INSERT INTO ${eventsTable(ctx)} (action, actor_id, actor_type, reason, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.action, row.actorId, row.actorType, row.reason, row.createdAt],
  );
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
  args: {
    companyId: string;
    actorId: string | null;
    actorType: ActorType;
    occurredAt: string;
    reason?: string | null;
  },
): Promise<StatusView> {
  const current = await loadHaltState(ctx, args.companyId);
  const reason = normalizeReason(args.reason);
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
    await writeHaltState(ctx, args.companyId, {
      tripped: true,
      since: args.occurredAt,
      actorId: args.actorId,
      actorType: args.actorType,
      reason,
    });
    await appendEvent(ctx, {
      action: "trip",
      actorId: args.actorId,
      actorType: args.actorType,
      reason,
      createdAt: args.occurredAt,
    });
  }

  ctx.logger?.warn?.("killswitch: TRIPPED", {
    pausedNow,
    actorType: args.actorType,
  });
  return buildStatus(ctx, args.companyId);
}

/**
 * Attach/append a follow-up reason note to the current open incident. Optional;
 * a way to record context before resuming. No-op reject if not tripped.
 */
async function annotate(
  ctx: any,
  args: {
    companyId: string;
    actorId: string | null;
    actorType: ActorType;
    occurredAt: string;
    note: string;
  },
): Promise<StatusView> {
  const current = await loadHaltState(ctx, args.companyId);
  if (!current.tripped) {
    throw new Error("Cannot annotate: the kill switch is not tripped.");
  }
  if (!isValidResumeNote(args.note)) {
    throw new Error("Annotation note must not be empty.");
  }
  const note = args.note.trim();
  await writeHaltState(ctx, args.companyId, { ...current, reason: note });
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
  args: {
    companyId: string;
    actorId: string | null;
    actorType: ActorType;
    occurredAt: string;
    note: string;
  },
): Promise<StatusView> {
  if (args.actorType !== "board") {
    throw new Error("Only a board actor may resume the company from HALT.");
  }
  if (!isValidResumeNote(args.note)) {
    throw new Error("A resolution note is required to resume.");
  }
  const note = args.note.trim();
  const current = await loadHaltState(ctx, args.companyId);
  if (!current.tripped) {
    // Nothing to resume — return current status without side effects.
    return buildStatus(ctx, args.companyId);
  }

  await resumeAllAgents(ctx, args.companyId);
  await writeHaltState(ctx, args.companyId, { ...CLEARED_STATE });
  await appendEvent(ctx, {
    action: "resume",
    actorId: args.actorId,
    actorType: args.actorType,
    reason: note,
    createdAt: args.occurredAt,
  });

  ctx.logger?.warn?.("killswitch: RESUMED by board");
  return buildStatus(ctx, args.companyId);
}

/**
 * Re-assert the host pause while tripped (defense in depth). Called from the
 * event handler on any new-start signal and from the watchdog job. No-op when
 * not tripped. Idempotent.
 */
async function reassert(
  ctx: any,
  args: { companyId: string; occurredAt: string; trigger: ActorType },
): Promise<void> {
  const current = await loadHaltState(ctx, args.companyId);
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
    ctx.logger?.warn?.("killswitch: re-asserted pause on drifted agents", {
      pausedNow,
      trigger: args.trigger,
    });
  }
}

/** Build the composite status view: fast HALT flag + live agent counts. */
async function buildStatus(ctx: any, companyId: string): Promise<StatusView> {
  const halt = await loadHaltState(ctx, companyId);
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
  async setup(ctx: any) {
    activeCtx = ctx;

    // -----------------------------------------------------------------------
    // DATA (read-only fetchers → usePluginData)
    // -----------------------------------------------------------------------

    // 'status' → current HALT flag + agent counts. Drives all three UI exports.
    ctx.data.register("status", async (input: any): Promise<StatusView> => {
      return buildStatus(ctx, String(input.companyId));
    });

    // 'agents' → live roster { id, name, paused } for the incident console table.
    ctx.data.register("agents", async (input: any): Promise<AgentRow[]> => {
      return listAgents(ctx, String(input.companyId));
    });

    // 'events' → killswitch_events audit rows, newest first.
    ctx.data.register("events", async (): Promise<EventRow[]> => {
      const rows = (await ctx.db.query(
        `SELECT id, action, actor_id, actor_type, reason, created_at
           FROM ${eventsTable(ctx)}
          ORDER BY created_at DESC, id DESC
          LIMIT 200`,
      )) as any[];
      return (rows ?? []).map((r): EventRow => ({
        id: String(r.id),
        action: r.action,
        actorId: r.actor_id ?? null,
        actorType: r.actor_type ?? null,
        reason: r.reason ?? null,
        createdAt:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
      }));
    });

    // -----------------------------------------------------------------------
    // ACTIONS (mutations → usePluginAction). The host passes an authenticated
    // actor context as the 2nd arg; board = actor.type "user".
    // -----------------------------------------------------------------------

    // 'trip' — instant, no reason required.
    ctx.actions.register("trip", async (input: any, context: any): Promise<StatusView> => {
      return trip(ctx, {
        companyId: String(input.companyId ?? context?.companyId),
        actorId: actorIdFromContext(context),
        actorType: actorTypeFromContext(context),
        occurredAt: new Date().toISOString(),
        reason: typeof input.reason === "string" ? input.reason : null,
      });
    });

    // 'annotate' — optional follow-up note on the open incident.
    ctx.actions.register("annotate", async (input: any, context: any): Promise<StatusView> => {
      return annotate(ctx, {
        companyId: String(input.companyId ?? context?.companyId),
        actorId: actorIdFromContext(context),
        actorType: actorTypeFromContext(context),
        occurredAt: new Date().toISOString(),
        note: String(input.note ?? input.reason ?? ""),
      });
    });

    // 'resume' — board only, resolution note REQUIRED. The only path out of halt.
    ctx.actions.register("resume", async (input: any, context: any): Promise<StatusView> => {
      return resume(ctx, {
        companyId: String(input.companyId ?? context?.companyId),
        actorId: actorIdFromContext(context),
        actorType: actorTypeFromContext(context),
        occurredAt: new Date().toISOString(),
        note: String(input.note ?? input.reason ?? ""),
      });
    });

    // -----------------------------------------------------------------------
    // EVENTS (events.subscribe) — while tripped, an agent checking out or a new
    // issue appearing is a new-work signal → re-assert host pause (defense in
    // depth) + append a 'reassert' row. PluginEvent fields are top-level.
    // -----------------------------------------------------------------------

    const onNewStartAttempt = async (event: any): Promise<void> => {
      await reassert(ctx, {
        companyId: String(event.companyId),
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        trigger: "system",
      });
    };

    ctx.events.on("issue.checked_out", onNewStartAttempt);
    ctx.events.on("issue.created", onNewStartAttempt);

    // -----------------------------------------------------------------------
    // JOBS (jobs.schedule) — watchdog: the job context carries no company, so
    // sweep every company and re-assert where tripped. reassert() no-ops on
    // companies that are not halted. Idempotent.
    // -----------------------------------------------------------------------

    ctx.jobs.register("killswitch-watchdog", async (job: any): Promise<void> => {
      const occurredAt = job?.scheduledAt ?? new Date().toISOString();
      let companies: any[] = [];
      try {
        companies = (await ctx.companies.list()) ?? [];
      } catch (err) {
        ctx.logger?.warn?.("killswitch: watchdog could not list companies", {
          err: String(err),
        });
        return;
      }
      for (const company of companies) {
        await reassert(ctx, {
          companyId: String(company.id),
          occurredAt,
          trigger: "system",
        });
      }
    });
  },

  // -------------------------------------------------------------------------
  // API ROUTES — onApiRequest switches on input.routeKey. No ctx is passed;
  // use the captured activeCtx. Auth/company/capabilities are already enforced
  // by the host before we are called.
  // -------------------------------------------------------------------------
  async onApiRequest(input: any) {
    const ctx = activeCtx;
    if (!ctx) {
      return { status: 503, body: { error: "Plugin not ready" } };
    }
    switch (input.routeKey) {
      // 'status' (GET, auth board-or-agent) → { tripped } so agent HEARTBEAT.md
      // checks can cooperatively refuse checkout.
      case "status": {
        const halt = await loadHaltState(ctx, String(input.companyId));
        return {
          status: 200,
          body: { tripped: halt.tripped, since: halt.since },
        };
      }

      // 'trip' (POST, auth webhook) → lets an external monitor (runaway-cost /
      // anomaly detector) trip the switch. Same effect as the trip action.
      case "trip": {
        const body = input.body;
        let reason: string | null = null;
        if (body && typeof body === "object" && typeof (body as any).reason === "string") {
          reason = (body as any).reason;
        }
        const view = await trip(ctx, {
          companyId: String(input.companyId),
          actorId: input.actor?.actorId ?? null,
          actorType: "webhook",
          occurredAt: new Date().toISOString(),
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
