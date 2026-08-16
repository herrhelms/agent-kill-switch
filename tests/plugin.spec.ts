import { describe, expect, it } from "vitest";

import manifest from "../src/manifest";
import {
  KILLSWITCH_ACTIONS,
  isValidResumeNote,
  normalizeReason,
} from "../src/worker";

/**
 * These tests assert the plugin against the REAL Paperclip SDK surface
 * (@paperclipai/shared PaperclipPluginManifestV1) and the worker's pure
 * decision logic. No live SDK, host, or database is required.
 *
 *   1. Manifest validity — the identifier, entrypoints, UI slots, api routes,
 *      and capabilities the host actually understands.
 *   2. The worker's pure gates — the resume-requires-a-note rule, reason
 *      normalization, and the audit-action vocabulary.
 */

const CAPS: string[] = manifest.capabilities ?? [];
const SLOTS = manifest.ui?.slots ?? [];
const ROUTES = manifest.apiRoutes ?? [];
const ROUTE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

describe("manifest: identity", () => {
  it("declares apiVersion 1", () => {
    expect(manifest.apiVersion).toBe(1);
  });

  it("carries the kill-switch plugin id", () => {
    expect(manifest.id).toBe("agent-kill-switch");
  });

  it("points entrypoints.ui at the dist/ui directory, and declares a worker", () => {
    expect(manifest.entrypoints?.ui).toBe("dist/ui");
    expect(manifest.entrypoints?.worker).toBeTruthy();
  });
});

describe("manifest: ui slots", () => {
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
      if (slot.type === "page") {
        expect(slot.routePath, "page slot must declare routePath").toBeTruthy();
        expect(slot.routePath).toMatch(ROUTE_SLUG);
        expect(slot.routePath).not.toContain("/");
        expect(slot.routePath).toBe("killswitch");
      } else {
        expect(
          (slot as { routePath?: string }).routePath ?? null,
          `${slot.type} slot must not declare routePath`,
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

  it("declares agents read + pause + resume (the true host-enforced stop)", () => {
    expect(CAPS).toContain("agents.read");
    expect(CAPS).toContain("agents.pause");
    expect(CAPS).toContain("agents.resume");
  });

  it("does NOT declare the non-existent agents.write capability", () => {
    expect(CAPS).not.toContain("agents.write");
  });

  it("declares the supporting capabilities the worker uses", () => {
    for (const cap of [
      "events.subscribe",
      "api.routes.register",
      "jobs.schedule",
      "companies.read",
      "ui.page.register",
      "ui.sidebar.register",
      "ui.dashboardWidget.register",
    ]) {
      expect(CAPS, `missing ${cap}`).toContain(cap);
    }
  });

  it("has no duplicate capability entries", () => {
    expect(new Set(CAPS).size).toBe(CAPS.length);
  });
});

describe("manifest: apiRoutes", () => {
  it("registers the status and trip routes", () => {
    const keys = ROUTES.map((r) => r.routeKey).sort();
    expect(keys).toEqual(["status", "trip"].sort());
  });

  it("gives every route the required descriptor fields", () => {
    for (const route of ROUTES) {
      expect(route.routeKey, "routeKey").toBeTruthy();
      expect(route.method, "method").toBeTruthy();
      expect(route.path, "path").toBeTruthy();
      expect(route.auth, "auth").toBeTruthy();
      expect(route.capability).toBe("api.routes.register");
      expect(route.companyResolution, "companyResolution").toBeTruthy();
    }
  });

  it("status route is board-or-agent GET so HEARTBEAT checks can cooperate", () => {
    const status = ROUTES.find((r) => r.routeKey === "status");
    expect(status?.method).toBe("GET");
    expect(status?.auth).toBe("board-or-agent");
    expect(status?.companyResolution).toMatchObject({
      from: "query",
      key: "companyId",
    });
  });

  it("trip route is a board-or-agent POST for internal monitors", () => {
    const trip = ROUTES.find((r) => r.routeKey === "trip");
    expect(trip?.method).toBe("POST");
    // webhook-auth routes need a host signature verifier a standard install
    // lacks, so the programmatic trip uses board-or-agent to work out of the box.
    expect(trip?.auth).toBe("board-or-agent");
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
  it("stop-first — trip needs no reason, so blank/absent normalizes to null", () => {
    expect(normalizeReason(null)).toBeNull();
    expect(normalizeReason(undefined)).toBeNull();
    expect(normalizeReason("")).toBeNull();
    expect(normalizeReason("   ")).toBeNull();
  });

  it("trims a provided reason", () => {
    expect(normalizeReason("  runaway cost  ")).toBe("runaway cost");
  });
});

describe("worker: audit action vocabulary", () => {
  it("is exactly {trip, annotate, resume, reassert}", () => {
    expect([...KILLSWITCH_ACTIONS].sort()).toEqual(
      ["annotate", "reassert", "resume", "trip"].sort(),
    );
  });
});
