import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { splitModelLevel, isConnectionEligibleForModel } from "@/sse/services/accountModelPolicy.js";

// The UI has no DOM harness in this suite, so assert the contract it depends on:
// every entry the picker can generate must be accepted by the router's matcher,
// and the picker's level source must be the same one the router's suffix parser uses.
const SOURCE = readFileSync(
  new URL("../../src/shared/components/ModelAccessSection.js", import.meta.url),
  "utf8"
);

describe("ModelAccessSection ↔ policy contract", () => {
  it("reads its level options from the shared thinkingLevels source", () => {
    expect(SOURCE).toContain('from "open-sse/providers/thinkingLevels.js"');
  });

  it("pulls custom models from the existing custom-models API, not a second catalog", () => {
    expect(SOURCE).toContain("/api/models/custom");
    expect(SOURCE).toContain("providerAlias");
  });

  it("still discovers per-connection models through the existing endpoint", () => {
    expect(SOURCE).toContain("/api/providers/${connection.id}/models");
  });

  it("every entry the picker generates for a real model is routable", () => {
    const providerId = "codex";
    const base = "gpt-5.6-luna";
    const levels = getThinkingLevels(providerId, base).filter((l) => l !== "none");
    expect(levels.length).toBeGreaterThan(0);

    // Same expansion the component performs: bare id + one entry per level.
    const entries = [base, ...levels.map((l) => `${base}(${l})`)];

    for (const entry of entries) {
      const conn = { provider: providerId, providerSpecificData: { enabledModels: [entry] } };
      const { level } = splitModelLevel(entry);
      // The entry always grants exactly the request it was generated for.
      expect(isConnectionEligibleForModel(conn, entry)).toBe(true);
      if (level === null) {
        // A bare grant covers every level.
        for (const l of levels) expect(isConnectionEligibleForModel(conn, `${base}(${l})`)).toBe(true);
      } else {
        // A level grant covers only itself.
        expect(isConnectionEligibleForModel(conn, base)).toBe(false);
        for (const other of levels.filter((l) => l !== level)) {
          expect(isConnectionEligibleForModel(conn, `${base}(${other})`)).toBe(false);
        }
      }
    }
  });

  it("a custom model id with no known levels is still routable as a bare entry", () => {
    const conn = {
      provider: "codex",
      providerSpecificData: { enabledModels: ["gpt-5.6-luna-xhigh"] },
    };
    expect(isConnectionEligibleForModel(conn, "gpt-5.6-luna-xhigh")).toBe(true);
    expect(isConnectionEligibleForModel(conn, "gpt-5.6-luna-xhigh(low)")).toBe(true);
    expect(isConnectionEligibleForModel(conn, "gpt-5.6-luna")).toBe(false);
  });
});
