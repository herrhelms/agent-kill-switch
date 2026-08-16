import React, { useCallback, useMemo, useState } from "react";
import {
  useHostContext,
  useHostNavigation,
  usePluginData,
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";

// -----------------------------------------------------------------------------
// Kill Switch — plugin UI
//
// Three exports, one shared status hook:
//   KillSwitchWidget  — dashboard card (compact STOP / HALTED)
//   KillSwitchSidebar — status dot + STOP, links to the page
//   KillSwitchPage    — /:companyPrefix/killswitch incident console
//
// Design stance from the brief: stop first, ask questions later. Tripping the
// switch is instant and needs no reason. The resolution note is required ONLY
// to resume — the single path out of halt, and one that a board human must
// take (the worker's `resume` action enforces the board-actor check and
// rejects an empty note; the UI mirrors that so operators see why a resume
// was refused).
//
// Data keys  (usePluginData ↔ ctx.data.register in the worker):
//   "status" → StatusData         (tripped flag + incident metadata + counts)
//   "agents" → { agents: AgentRow[] }
//   "events" → { events: EventRow[] }
// Action keys (usePluginAction ↔ ctx.actions.register in the worker):
//   "trip"     → halt all agents, no reason required
//   "annotate" → append a follow-up note to the open incident (optional)
//   "resume"   → board-only, note REQUIRED, clears the halt
//
// Theme: reference the host's shadcn-style CSS variables directly
// (var(--background), var(--card), var(--border), var(--foreground),
// var(--muted-foreground), var(--destructive), var(--destructive-foreground)).
// The host stores tokens as direct oklch() values and switches light/dark via
// a parent class — the plugin subtree inherits it for free. No plugin-side
// palette, no media queries, no dark-mode overrides.
// -----------------------------------------------------------------------------

const KILLSWITCH_ROUTE_SLUG = "killswitch";
// The page slot's routePath mounts directly under the company prefix as
// /:companyPrefix/<routePath>. linkProps() takes a company-relative path
// (leading slash, no prefix) and the host resolves the prefix at render time.
const PAGE_HREF = `/${KILLSWITCH_ROUTE_SLUG}`;

// ---- Shared response shapes (mirror the worker's registered data handlers) --

type ActorType = "board" | "agent" | "webhook" | "system" | string;

type StatusData = {
  tripped: boolean;
  // occurredAt of the trip. Nullable when not tripped.
  since: string | null;
  actorId: string | null;
  actorType: ActorType | null;
  // Latest reason note attached to the open incident (from a `trip`-time note
  // or a later `annotate`). Optional — a trip needs no reason.
  reason: string | null;
  pausedAgentCount: number;
  totalAgentCount: number;
};

type AgentRow = {
  id: string;
  name: string;
  paused: boolean;
};

type AgentsData = { agents: AgentRow[] };

type EventAction = "trip" | "annotate" | "resume" | "reassert" | string;

type EventRow = {
  id: string;
  action: EventAction;
  actor_id: string | null;
  actor_type: ActorType | null;
  reason: string | null;
  created_at: string;
};

type EventsData = { events: EventRow[] };

// ---- Small helpers ----------------------------------------------------------

// Walk common SDK/action error shapes down to a human-readable string. Action
// errors arrive as plain objects ({ message } / { error } / { body }), not
// Error instances — String(err) would render "[object Object]".
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.error === "string") return e.error;
    if (typeof e.body === "string") return e.body;
    const data = e.data as Record<string, unknown> | undefined;
    if (data && typeof data === "object") {
      if (typeof data.message === "string") return data.message;
      if (typeof data.error === "string") return data.error;
    }
    try {
      const dump = JSON.stringify(err);
      if (dump && dump !== "{}") return dump;
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

// Cross-engine timestamp parser for postgres timestamptz `::text` values.
// Postgres uses a space separator and a 2-digit offset (e.g.
// "2026-08-14 01:32:45+02") which Safari/Firefox historically reject.
// Normalize to strict ISO 8601 before Date(); return null on failure so
// callers fall back to the raw string rather than "Invalid Date".
function parseTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  let iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  iso = iso.replace(/([+-]\d{2})(?::?(\d{2}))?$/, (_, sign, mins) =>
    mins ? `${sign}:${mins}` : `${sign}:00`,
  );
  if (!/[Zz+-]\d?\d(?::\d{2})?$/.test(iso)) iso = `${iso}Z`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Absolute timestamp for audit rows and banners.
function fmtAbsolute(raw: string | null | undefined): string {
  const d = parseTimestamp(raw);
  if (!d) return raw ?? "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Compact "since" phrasing for the HALTED banner (e.g. "3m ago", "2h ago").
function fmtRelative(raw: string | null | undefined): string {
  const d = parseTimestamp(raw);
  if (!d) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Friendly actor label. The worker records actorId/actorType; agent display
// names aren't resolved here (the audit trail is about accountability, not
// prettiness), so fall back to a short id + type.
function fmtActor(
  actorType: ActorType | null | undefined,
  actorId: string | null | undefined,
): string {
  const type = actorType ?? "unknown";
  if (!actorId) return type;
  const shortId = actorId.length > 12 ? `${actorId.slice(0, 8)}…` : actorId;
  return `${type} (${shortId})`;
}

const ACTION_LABEL: Record<string, string> = {
  trip: "Tripped",
  annotate: "Annotated",
  resume: "Resumed",
  reassert: "Re-asserted",
};

// ---- Theme / style tokens (host CSS variables) ------------------------------

const styles = {
  fontStack:
    "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" as const,

  page: {
    padding: 24,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    color: "var(--foreground)",
    maxWidth: 960,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column" as const,
    gap: 20,
  } as React.CSSProperties,

  card: {
    border: "1px solid var(--border)",
    borderRadius: 12,
    background: "var(--card)",
    color: "var(--foreground)",
    padding: 20,
  } as React.CSSProperties,

  widgetCard: {
    border: "1px solid var(--border)",
    borderRadius: 12,
    background: "var(--card)",
    color: "var(--foreground)",
    padding: 16,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  } as React.CSSProperties,

  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
    color: "var(--foreground)",
  } as React.CSSProperties,

  muted: {
    fontSize: 12,
    color: "var(--muted-foreground)",
    margin: 0,
  } as React.CSSProperties,

  // The STOP button — intentionally, unmistakably red, via the host's
  // destructive tokens so it stays theme-correct and dark-mode-safe.
  stopButton: {
    width: "100%",
    padding: "16px 20px",
    border: "1px solid var(--destructive)",
    borderRadius: 12,
    background: "var(--destructive)",
    color: "var(--destructive-foreground)",
    cursor: "pointer",
    fontSize: 18,
    fontWeight: 800,
    letterSpacing: 0.4,
    textTransform: "uppercase" as const,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  } as React.CSSProperties,

  stopButtonArmed: {
    width: "100%",
    padding: "16px 20px",
    border: "2px solid var(--destructive-foreground)",
    borderRadius: 12,
    background: "var(--destructive)",
    color: "var(--destructive-foreground)",
    cursor: "pointer",
    fontSize: 18,
    fontWeight: 800,
    letterSpacing: 0.4,
    textTransform: "uppercase" as const,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  } as React.CSSProperties,

  btn: {
    padding: "8px 14px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  } as React.CSSProperties,

  btnGhost: {
    padding: "6px 10px",
    border: "1px solid transparent",
    borderRadius: 8,
    background: "transparent",
    color: "var(--muted-foreground)",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  } as React.CSSProperties,

  // Resume — a deliberate, non-red action; the way OUT of halt.
  resumeButton: {
    padding: "10px 18px",
    border: "1px solid var(--primary)",
    borderRadius: 10,
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 700,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  } as React.CSSProperties,

  textarea: {
    width: "100%",
    minHeight: 84,
    padding: "10px 12px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background)",
    color: "var(--foreground)",
    fontSize: 13,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    resize: "vertical" as const,
    boxSizing: "border-box" as const,
  } as React.CSSProperties,

  // HALTED banner — red surface built from destructive tokens.
  haltedBanner: {
    border: "1px solid var(--destructive)",
    borderRadius: 12,
    background: "color-mix(in oklab, var(--destructive) 14%, var(--card))",
    color: "var(--foreground)",
    padding: 16,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  } as React.CSSProperties,

  haltedTitle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 15,
    fontWeight: 800,
    color: "var(--destructive)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.4,
  } as React.CSSProperties,

  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 13,
    color: "var(--foreground)",
  } as React.CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--muted-foreground)",
    fontWeight: 600,
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--foreground)",
    verticalAlign: "top" as const,
  } as React.CSSProperties,

  link: {
    color: "var(--primary)",
    textDecoration: "underline",
    textUnderlineOffset: 3,
    fontSize: 13,
    cursor: "pointer",
  } as React.CSSProperties,

  skeleton: {
    background: "var(--muted)",
    borderRadius: 8,
    height: 44,
    width: "100%",
    opacity: 0.6,
  } as React.CSSProperties,
};

// Status dot — green (running) / red (halted). Built from host tokens.
function StatusDot(props: { tripped: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: 999,
        background: props.tripped
          ? "var(--destructive)"
          : "color-mix(in oklab, #16a34a 90%, var(--foreground))",
        boxShadow: props.tripped
          ? "0 0 0 3px color-mix(in oklab, var(--destructive) 25%, transparent)"
          : "none",
        flex: "0 0 auto",
      }}
    />
  );
}

// -----------------------------------------------------------------------------
// STOP button with a hold-to-confirm guard.
//
// Tripping is instant and needs no reason, but it is destructive company-wide,
// so we gate the click behind a two-step arm: first click arms ("Click again
// to STOP"), second click within the window trips. This keeps the "stop
// first" ethos (no form, no reason) while preventing a single stray click from
// freezing the whole company.
// -----------------------------------------------------------------------------
function useStop(companyId: string, onDone: () => void) {
  const trip = usePluginAction("trip");
  const toast = usePluginToast();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const disarm = useCallback(() => setArmed(false), []);

  const onClick = useCallback(async () => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      // Auto-disarm after a short window so a stale armed state can't linger.
      window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    setBusy(true);
    try {
      await trip({ companyId });
      toast?.({
        title: "Kill switch tripped",
        body: "All agents halted. New work is blocked until a board member resumes.",
        tone: "success",
      });
      onDone();
    } catch (err) {
      const msg = extractErrorMessage(err);
      toast?.({ title: "Could not trip the kill switch", body: msg, tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [armed, busy, trip, companyId, toast, onDone]);

  return { armed, busy, onClick, disarm };
}

function StopButton(props: {
  companyId: string;
  onDone: () => void;
  label?: string;
}): JSX.Element {
  const { armed, busy, onClick } = useStop(props.companyId, props.onDone);
  const label = busy
    ? "Halting…"
    : armed
      ? "Click again to STOP"
      : (props.label ?? "Stop all agents");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-live="polite"
      style={{
        ...(armed ? styles.stopButtonArmed : styles.stopButton),
        opacity: busy ? 0.7 : 1,
        cursor: busy ? "progress" : "pointer",
      }}
      title="Immediately halt every agent and block new work. Requires a second click to confirm."
    >
      {label}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Resume panel — board-only, resolution note REQUIRED.
//
// The note textarea drives a disabled Resume button until the note is
// non-empty. An optional annotate field lets the operator record the reason
// separately before resuming. The worker's `resume` action re-checks the
// board-actor requirement and the non-empty note; if it rejects (e.g. an agent
// actor tries to resume), the error surfaces via toast so the operator learns
// why. This is the only path out of halt.
// -----------------------------------------------------------------------------
function ResumePanel(props: {
  companyId: string;
  onResumed: () => void;
  onAnnotated: () => void;
}): JSX.Element {
  const { companyId } = props;
  const resume = usePluginAction("resume");
  const annotate = usePluginAction("annotate");
  const toast = usePluginToast();
  const [note, setNote] = useState("");
  const [annotation, setAnnotation] = useState("");
  const [resuming, setResuming] = useState(false);
  const [annotating, setAnnotating] = useState(false);

  const noteEmpty = note.trim().length === 0;

  const doResume = useCallback(async () => {
    if (noteEmpty || resuming) return;
    setResuming(true);
    try {
      await resume({ companyId, reason: note.trim() });
      toast?.({
        title: "Company resumed",
        body: "Agents un-halted. New work can start again.",
        tone: "success",
      });
      setNote("");
      props.onResumed();
    } catch (err) {
      const msg = extractErrorMessage(err);
      toast?.({ title: "Resume was refused", body: msg, tone: "error" });
    } finally {
      setResuming(false);
    }
  }, [noteEmpty, resuming, resume, companyId, note, toast, props]);

  const doAnnotate = useCallback(async () => {
    const text = annotation.trim();
    if (text.length === 0 || annotating) return;
    setAnnotating(true);
    try {
      await annotate({ companyId, reason: text });
      toast?.({ title: "Note added to the incident", tone: "success" });
      setAnnotation("");
      props.onAnnotated();
    } catch (err) {
      const msg = extractErrorMessage(err);
      toast?.({ title: "Could not add note", body: msg, tone: "error" });
    } finally {
      setAnnotating(false);
    }
  }, [annotation, annotating, annotate, companyId, toast, props]);

  return (
    <section style={styles.card}>
      <h2 style={{ ...styles.sectionTitle, marginBottom: 4 }}>Resolve &amp; resume</h2>
      <p style={{ ...styles.muted, marginBottom: 16 }}>
        Resuming un-halts every agent and lets new work start. Only a board
        member can resume, and a resolution note is required — it becomes part
        of the incident audit trail.
      </p>

      {/* Optional annotate-before-resume field */}
      <label
        style={{ ...styles.muted, display: "block", marginBottom: 6, fontWeight: 600 }}
      >
        Add a note to the open incident (optional)
      </label>
      <textarea
        value={annotation}
        onChange={(e) => setAnnotation(e.target.value)}
        placeholder="e.g. Root cause: runaway retry loop in billing-agent. Investigating."
        style={styles.textarea}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, marginBottom: 20 }}>
        <button
          type="button"
          onClick={doAnnotate}
          disabled={annotation.trim().length === 0 || annotating}
          style={{
            ...styles.btn,
            opacity: annotation.trim().length === 0 || annotating ? 0.5 : 1,
            cursor:
              annotation.trim().length === 0 || annotating ? "not-allowed" : "pointer",
          }}
        >
          {annotating ? "Adding…" : "Add note"}
        </button>
      </div>

      {/* Required resolution note → resume */}
      <label
        htmlFor="killswitch-resume-note"
        style={{ ...styles.muted, display: "block", marginBottom: 6, fontWeight: 600 }}
      >
        Resolution note <span style={{ color: "var(--destructive)" }}>*</span>
      </label>
      <textarea
        id="killswitch-resume-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Describe what was resolved. Required to resume."
        aria-required
        style={styles.textarea}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 8,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={styles.muted}>
          {noteEmpty
            ? "Enter a resolution note to enable Resume."
            : "Resume is the only path out of halt."}
        </span>
        <button
          type="button"
          onClick={doResume}
          disabled={noteEmpty || resuming}
          style={{
            ...styles.resumeButton,
            opacity: noteEmpty || resuming ? 0.5 : 1,
            cursor: noteEmpty || resuming ? "not-allowed" : "pointer",
          }}
          title={
            noteEmpty
              ? "A resolution note is required before resuming."
              : "Un-halt all agents (board only)."
          }
        >
          {resuming ? "Resuming…" : "Resume company"}
        </button>
      </div>
    </section>
  );
}

// ---- Live agent table (page) ------------------------------------------------

function AgentTable(props: { loading: boolean; agents: AgentRow[] }): JSX.Element {
  if (props.loading) {
    return (
      <section style={styles.card}>
        <h2 style={{ ...styles.sectionTitle, marginBottom: 16 }}>Agents</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ ...styles.skeleton, height: 20 }} />
          ))}
        </div>
      </section>
    );
  }
  const agents = props.agents;
  const pausedCount = agents.filter((a) => a.paused).length;
  return (
    <section style={styles.card}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h2 style={styles.sectionTitle}>Agents</h2>
        <span style={styles.muted}>
          {pausedCount} of {agents.length} paused
        </span>
      </div>
      {agents.length === 0 ? (
        <p style={styles.muted}>No agents found for this company.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Agent</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td style={styles.td}>{a.name || a.id}</td>
                  <td style={{ ...styles.td, textAlign: "right" }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontWeight: 600,
                        color: a.paused
                          ? "var(--destructive)"
                          : "var(--muted-foreground)",
                      }}
                    >
                      <StatusDot tripped={a.paused} />
                      {a.paused ? "Paused" : "Running"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- Audit history table (page) ---------------------------------------------

function AuditTable(props: { loading: boolean; events: EventRow[] }): JSX.Element {
  if (props.loading) {
    return (
      <section style={styles.card}>
        <h2 style={{ ...styles.sectionTitle, marginBottom: 16 }}>Incident history</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ ...styles.skeleton, height: 20 }} />
          ))}
        </div>
      </section>
    );
  }
  const events = props.events;
  return (
    <section style={styles.card}>
      <h2 style={{ ...styles.sectionTitle, marginBottom: 16 }}>Incident history</h2>
      {events.length === 0 ? (
        <p style={styles.muted}>
          No kill-switch events yet. When the switch is tripped, every trip,
          note, resume, and re-assertion is recorded here.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Action</th>
                <th style={styles.th}>Actor</th>
                <th style={styles.th}>Reason</th>
                <th style={styles.th}>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td style={styles.td}>
                    <span
                      style={{
                        fontWeight: 700,
                        color:
                          ev.action === "trip" || ev.action === "reassert"
                            ? "var(--destructive)"
                            : "var(--foreground)",
                      }}
                    >
                      {ACTION_LABEL[ev.action] ?? ev.action}
                    </span>
                  </td>
                  <td style={{ ...styles.td, color: "var(--muted-foreground)" }}>
                    {fmtActor(ev.actor_type, ev.actor_id)}
                  </td>
                  <td style={styles.td}>
                    {ev.reason ? (
                      ev.reason
                    ) : (
                      <span style={{ color: "var(--muted-foreground)" }}>—</span>
                    )}
                  </td>
                  <td
                    style={{
                      ...styles.td,
                      color: "var(--muted-foreground)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmtAbsolute(ev.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- HALTED banner (shared by widget + page) --------------------------------

function HaltedBanner(props: {
  status: StatusData;
  compact?: boolean;
}): JSX.Element {
  const { status } = props;
  return (
    <div style={styles.haltedBanner} role="alert">
      <span style={styles.haltedTitle}>
        <StatusDot tripped />
        Company halted
      </span>
      <div style={{ fontSize: props.compact ? 13 : 14, lineHeight: 1.5 }}>
        <strong>
          {status.pausedAgentCount} of {status.totalAgentCount} agents paused
        </strong>{" "}
        · since {fmtRelative(status.since)} · by{" "}
        {fmtActor(status.actorType, status.actorId)}
      </div>
      {status.reason ? (
        <div style={{ ...styles.muted, fontStyle: "italic" }}>“{status.reason}”</div>
      ) : (
        <div style={styles.muted}>
          Tripped with no reason on record — stop first, ask questions later.
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Export 1 — KillSwitchWidget (dashboard card)
// =============================================================================
export function KillSwitchWidget(): JSX.Element {
  const host = useHostContext();
  const nav = useHostNavigation();
  const companyId = host?.companyId ?? "";
  const status = usePluginData<StatusData>("status", { companyId });
  const pageLink = nav.linkProps(PAGE_HREF);

  const s = status.data;
  const loading = status.loading && !s;

  const onTripped = useCallback(() => status.refresh?.(), [status]);

  return (
    <div style={styles.widgetCard}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <h2 style={styles.sectionTitle}>Kill Switch</h2>
        {s ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              color: s.tripped ? "var(--destructive)" : "var(--muted-foreground)",
            }}
          >
            <StatusDot tripped={s.tripped} />
            {s.tripped ? "Halted" : "Running"}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div style={styles.skeleton} />
      ) : s?.tripped ? (
        <>
          <HaltedBanner status={s} compact />
          <a
            {...pageLink}
            style={{ ...styles.resumeButton, textAlign: "center", textDecoration: "none" }}
          >
            Resume…
          </a>
        </>
      ) : (
        <>
          <p style={styles.muted}>
            {s ? `${s.totalAgentCount} agents running.` : "All agents running."}{" "}
            One click halts the whole company.
          </p>
          <StopButton companyId={companyId} onDone={onTripped} label="Stop all agents" />
          <a {...pageLink} style={{ ...styles.link, alignSelf: "flex-start" }}>
            Open incident console →
          </a>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Export 2 — KillSwitchSidebar (minimal)
// =============================================================================
export function KillSwitchSidebar(): JSX.Element {
  const host = useHostContext();
  const nav = useHostNavigation();
  const companyId = host?.companyId ?? "";
  const status = usePluginData<StatusData>("status", { companyId });
  const pageLink = nav.linkProps(PAGE_HREF);

  const s = status.data;
  const tripped = !!s?.tripped;
  const onTripped = useCallback(() => status.refresh?.(), [status]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
        fontFamily: styles.fontStack,
        color: "var(--foreground)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusDot tripped={tripped} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {status.loading && !s ? "Kill Switch" : tripped ? "Halted" : "Running"}
        </span>
      </div>

      {tripped ? (
        <>
          <span style={styles.muted}>
            {s?.pausedAgentCount ?? 0} agents paused · {fmtRelative(s?.since)}
          </span>
          <a
            {...pageLink}
            style={{
              ...styles.resumeButton,
              textAlign: "center",
              textDecoration: "none",
              padding: "8px 12px",
              fontSize: 13,
            }}
          >
            Resume…
          </a>
        </>
      ) : (
        <>
          <StopButton
            companyId={companyId}
            onDone={onTripped}
            label="Stop all"
          />
          <a {...pageLink} style={styles.link}>
            Open console →
          </a>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Export 3 — KillSwitchPage (/:companyPrefix/killswitch incident console)
// =============================================================================
export function KillSwitchPage(): JSX.Element {
  const host = useHostContext();
  const companyId = host?.companyId ?? "";

  const status = usePluginData<StatusData>("status", { companyId });
  const agents = usePluginData<AgentsData>("agents", { companyId });
  const events = usePluginData<EventsData>("events", { companyId });

  const s = status.data;
  const tripped = !!s?.tripped;

  // Refresh the whole console after a state-changing action so the hero,
  // agent table, and audit history all reflect the new incident state.
  const refreshAll = useCallback(() => {
    status.refresh?.();
    agents.refresh?.();
    events.refresh?.();
  }, [status, agents, events]);

  const agentRows = useMemo(() => agents.data?.agents ?? [], [agents.data]);
  const eventRows = useMemo(() => events.data?.events ?? [], [events.data]);

  return (
    <div style={styles.page}>
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
            letterSpacing: -0.2,
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <StatusDot tripped={tripped} />
          Kill Switch
        </h1>
        <p style={styles.muted}>
          One action halts every agent, pauses in-flight work, and blocks new
          tasks. The company stays frozen until a board member resumes with a
          resolution note.
        </p>
      </header>

      {/* Hero: STOP when running, HALTED state when tripped */}
      {status.loading && !s ? (
        <div style={{ ...styles.skeleton, height: 88 }} />
      ) : tripped && s ? (
        <HaltedBanner status={s} />
      ) : (
        <section style={styles.card}>
          <h2 style={{ ...styles.sectionTitle, marginBottom: 6 }}>
            Emergency stop
          </h2>
          <p style={{ ...styles.muted, marginBottom: 16 }}>
            {s ? `${s.totalAgentCount} agents running.` : "Agents running."}{" "}
            Tripping is instant and needs no reason. A second click confirms.
          </p>
          <StopButton companyId={companyId} onDone={refreshAll} />
        </section>
      )}

      {/* Resume panel only makes sense while halted */}
      {tripped ? (
        <ResumePanel
          companyId={companyId}
          onResumed={refreshAll}
          onAnnotated={refreshAll}
        />
      ) : null}

      {/* Live agents */}
      <AgentTable loading={agents.loading && !agents.data} agents={agentRows} />

      {/* Audit history */}
      <AuditTable loading={events.loading && !events.data} events={eventRows} />
    </div>
  );
}
