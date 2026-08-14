import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { manifest } from "../src/manifest";
import {
  KILLSWITCH_ACTIONS,
  deriveNamespace,
  isValidResumeNote,
  normalizeReason,
  sanitizeSlug,
  isRunningTransition,
} from "../src/worker";

/**
 * These tests cover two things the skill's quality bar cares about:
 *   1. Manifest validity — capabilities are declared for what the worker uses,
 *      routePath lives only on the page slot and is a single lowercase slug,
 *      data/action registries line up with the UI hooks.
 *   2. The worker's pure decision logic — namespace derivation, the
 *      resume-requires-a-note rule, action-enum integrity, and the
 *      "new transition into in-progress while tripped" detection.
 *
 * No live SDK, host, or database is required: everything under test is a pure
 * function or a static descriptor.
 */

const SLOTS = manifest.slots ?? [];
const CAPS: string[] = manifest.capabilities ?? [];
const ROUTE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

describe("manifest: identity", () => {
  it("declares apiVersion 1", () => {
    expect(manifest.apiVersion).toBe(1);
  });

  it("carries the kill-switch plugin key", () => {
    expect(manifest.key).toBe("agent-kill-switch");
  });

  it("points entrypoints.ui at the dist/ui directory, not a single file", () => {
    expect(manifest.entrypoints?.ui).toBe("dist/ui");
    expect(manifest.entrypoints?.worker).toBeTruthy();
  });
});

describe("manifest: slots", () => {
  it("mounts exactly the three surfaces from the brief", () => {
    const ids = SLOTS.map((s) => s.id).sort();
    expect(ids).toEqual(
      ["killswitch-page", "killswitch-sidebar", "killswitch-widget"].sort(),
    );
  });

  it("exports a component name for every slot", () => {
    for (const slot of SLOTS) {
      expect(slot.exportName, `slot ${slot.id} needs exportName`).toBeTruthy();
    }
  });

  it("puts routePath ONLY on the page slot and as a single lowercase slug", () => {
    for (const slot of SLOTS) {
      if (slot.slot === "page") {
        expect(slot.routePath, "page slot must declare routePath").toBeTruthy();
        expect(slot.routePath).toMatch(ROUTE_SLUG);
        expect(slot.routePath).not.toContain("/");
        expect(slot.routePath).toBe("killswitch");
      } else {
        expect(
          slot.routePath ?? null,
          `${slot.slot} slot must not declare routePath`,
        ).toBeNull();
      }
    }
  });
});

describe("manifest: capabilities", () => {
  it("declares BOTH read and write for plugin.state", () => {
    expect(CAPS).toContain("plugin.state.read");
    expect(CAPS).toContain("plugin.state.write");
  });

  it("declares all three database.namespace verbs", () => {
    expect(CAPS).toContain("database.namespace.migrate");
    expect(CAPS).toContain("database.namespace.read");
    expect(CAPS).toContain("database.namespace.write");
  });

  it("declares agents read+write (the true host-enforced stop)", () => {
    expect(CAPS).toContain("agents.read");
    expect(CAPS).toContain("agents.write");
  });

  it("declares the supporting capabilities the worker uses", () => {
    for (const cap of [
      "events.subscribe",
      "api.routes.register",
      "jobs.schedule",
      "companies.read",
      "ui.page.register",
    ]) {
      expect(CAPS, `missing ${cap}`).toContain(cap);
    }
  });

  it("has no duplicate capability entries", () => {
    expect(new Set(CAPS).size).toBe(CAPS.length);
  });

  it("does not reference ctx.assets or any unsupported capability", () => {
    for (const cap of CAPS) {
      expect(cap).not.toMatch(/assets/i);
    }
  });
});

describe("manifest: apiRoutes", () => {
  const routes = manifest.apiRoutes ?? [];

  it("registers the status and trip routes", () => {
    const keys = routes.map((r) => r.routeKey).sort();
    expect(keys).toEqual(["status", "trip"].sort());
  });

  it("gives every route the required descriptor fields", () => {
    for (const route of routes) {
      expect(route.routeKey, "routeKey").toBeTruthy();
      expect(route.method, "method").toBeTruthy();
      expect(route.path, "path").toBeTruthy();
      expect(route.auth, "auth").toBeTruthy();
      expect(route.capability).toBe("api.routes.register");
      expect(route.companyResolution, "companyResolution").toBeTruthy();
    }
  });

  it("uses valid auth values (never the invalid board-only)", () => {
    const valid = new Set(["board", "agent", "board-or-agent", "webhook"]);
    for (const route of routes) {
      expect(valid.has(route.auth), `bad auth ${route.auth}`).toBe(true);
      expect(route.auth).not.toBe("board-only");
    }
  });

  it("status route is board-or-agent GET so HEARTBEAT checks can cooperate", () => {
    const status = routes.find((r) => r.routeKey === "status");
    expect(status?.method).toBe("GET");
    expect(status?.auth).toBe("board-or-agent");
    expect(status?.companyResolution).toMatchObject({
      from: "query",
      key: "companyId",
    });
  });

  it("trip route is a webhook POST for external monitors", () => {
    const trip = routes.find((r) => r.routeKey === "trip");
    expect(trip?.method).toBe("POST");
    expect(trip?.auth).toBe("webhook");
  });
});

describe("worker: SQL namespace derivation", () => {
  it("matches plugin_<sanitized-slug>_<sha256(id)[0:10]>", () => {
    const installId = "install-abc-123";
    const expectedHash = createHash("sha256")
      .update(installId)
      .digest("hex")
      .slice(0, 10);
    const ns = deriveNamespace("agent-kill-switch", installId);
    expect(ns).toBe(`plugin_agent_kill_switch_${expectedHash}`);
  });

  it("is deterministic for the same inputs", () => {
    expect(deriveNamespace("agent-kill-switch", "id-1")).toBe(
      deriveNamespace("agent-kill-switch", "id-1"),
    );
  });

  it("differs when the install id differs", () => {
    expect(deriveNamespace("agent-kill-switch", "id-1")).not.toBe(
      deriveNamespace("agent-kill-switch", "id-2"),
    );
  });

  it("only emits schema-safe characters", () => {
    const ns = deriveNamespace("Agent Kill-Switch!!", "id-x");
    expect(ns).toMatch(/^[a-z0-9_]+$/);
  });
});

describe("worker: slug sanitization", () => {
  it("lowercases and replaces non-[a-z0-9_] runs with underscore", () => {
    expect(sanitizeSlug("Agent Kill-Switch")).toBe("agent_kill_switch");
  });

  it("trims leading/trailing underscores", () => {
    expect(sanitizeSlug("--foo--")).toBe("foo");
  });

  it("caps length at 36 characters", () => {
    const long = "a".repeat(80);
    expect(sanitizeSlug(long).length).toBeLessThanOrEqual(36);
  });
});

describe("worker: resume requires a resolution note", () => {
  it("rejects an empty note", () => {
    expect(isValidResumeNote("")).toBe(false);
  });

  it("rejects a whitespace-only note", () => {
    expect(isValidResumeNote("   \n\t ")).toBe(false);
  });

  it("rejects a null/undefined note", () => {
    expect(isValidResumeNote(null)).toBe(false);
    expect(isValidResumeNote(undefined)).toBe(false);
  });

  it("accepts any non-empty note", () => {
    expect(isValidResumeNote("incident resolved, root cause patched")).toBe(
      true,
    );
  });
});

describe("worker: reason normalization", () => {
  it("stop-first — trip needs no reason, so null stays null", () => {
    expect(normalizeReason(null)).toBeNull();
    expect(normalizeReason(undefined)).toBeNull();
    expect(normalizeReason("")).toBeNull();
    expect(normalizeReason("   ")).toBeNull();
  });

  it("trims a provided reason", () => {
    expect(normalizeReason("  runaway cost  ")).toBe("runaway cost");
  });
});

describe("worker: audit action enum", () => {
  it("is exactly {trip, annotate, resume, reassert}", () => {
    expect([...KILLSWITCH_ACTIONS].sort()).toEqual(
      ["annotate", "reassert", "resume", "trip"].sort(),
    );
  });
});

describe("worker: new-start detection while tripped", () => {
  it("flags a task moving into in-progress as a new-start attempt", () => {
    expect(
      isRunningTransition({ from: "todo", to: "in_progress" }),
    ).toBe(true);
  });

  it("ignores transitions that do not enter in-progress", () => {
    expect(isRunningTransition({ from: "in_progress", to: "done" })).toBe(
      false,
    );
    expect(isRunningTransition({ from: "todo", to: "todo" })).toBe(false);
  });

  it("does not double-count a status that was already in-progress", () => {
    expect(
      isRunningTransition({ from: "in_progress", to: "in_progress" }),
    ).toBe(false);
  });
});

describe("registry parity: data hooks ↔ ctx.data.register keys", () => {
  it("exposes the status, agents and events data keys", () => {
    // The UI's usePluginData(key) calls must each map to a registered data key.
    // These are the keys the worker registers on ctx.data; a mismatch silently
    // no-ops in the host, so we assert the contract explicitly.
    const dataKeys = manifest.dataKeys ?? [];
    for (const key of ["status", "agents", "events"]) {
      expect(dataKeys, `data key ${key} not registered`).toContain(key);
    }
  });
});

describe("registry parity: action hooks ↔ ctx.actions.register keys", () => {
  it("exposes the trip, annotate and resume action keys", () => {
    const actionKeys = manifest.actionKeys ?? [];
    for (const key of ["trip", "annotate", "resume"]) {
      expect(actionKeys, `action key ${key} not registered`).toContain(key);
    }
  });
});
