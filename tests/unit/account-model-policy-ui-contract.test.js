import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { sanitizeEnabledModels, isConnectionEligibleForModel } from "@/sse/services/accountModelPolicy.js";

// No DOM harness in this suite, so assert the wiring contract the UI depends on.
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const MODAL = read("../../src/shared/components/ModelAccessModal.js");
const ROW = read("../../src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js");
const PAGE = read("../../src/app/(dashboard)/dashboard/providers/[id]/page.js");
const EDIT = read("../../src/shared/components/EditConnectionModal.js");

describe("Model Access modal wiring", () => {
  it("is a standalone modal, not part of Edit Connection", () => {
    expect(EDIT).not.toContain("ModelAccess");
    expect(EDIT).not.toContain("enabledModels");
    expect(MODAL).toContain("export default function ModelAccessModal");
  });

  it("is opened from its own row action beside Edit", () => {
    expect(ROW).toContain("onEditModelAccess");
    expect(ROW).toContain("Models");
    expect(PAGE).toContain("onEditModelAccess={");
    expect(PAGE).toContain("<ModelAccessModal");
  });

  it("shares one catalog with the Available Models grid", () => {
    expect(PAGE).toContain("buildProviderModelCatalog");
    // The grid reads the same object the modal is handed.
    expect(PAGE).toContain("modelCatalog.entries");
    expect(PAGE).toContain("customRows: customModelRows");
  });

  it("offers no level-variant UI", () => {
    expect(MODAL).not.toContain("getThinkingLevels");
    expect(MODAL).not.toMatch(/levelIds|expandLevels/);
  });

  it("saves only enabledModels, letting the API merge preserve other keys", () => {
    expect(MODAL).toContain("providerSpecificData: { enabledModels: value }");
  });
});

describe("policy accepts what the modal can produce", () => {
  it("a bare model entry routes at every thinking level", () => {
    const conn = { provider: "codex", providerSpecificData: { enabledModels: ["gpt-5.6-luna"] } };
    for (const req of ["gpt-5.6-luna", "gpt-5.6-luna(low)", "gpt-5.6-luna(xhigh)", "gpt-5.6-luna(max)"]) {
      expect(isConnectionEligibleForModel(conn, req)).toBe(true);
    }
    expect(isConnectionEligibleForModel(conn, "gpt-5.6-sol")).toBe(false);
  });

  it("a custom id the registry does not know is routable", () => {
    const conn = { provider: "codex", providerSpecificData: { enabledModels: ["gpt-5.6-luna-xhigh"] } };
    expect(isConnectionEligibleForModel(conn, "gpt-5.6-luna-xhigh")).toBe(true);
    expect(isConnectionEligibleForModel(conn, "gpt-5.6-luna-xhigh(low)")).toBe(true);
    expect(isConnectionEligibleForModel(conn, "gpt-5.6-luna")).toBe(false);
  });

  it("the modal's baseId normalization matches the policy's", () => {
    // Both drop a trailing (level); a legacy stored entry converges on the same base.
    expect(sanitizeEnabledModels(["m(low)", "m(high)"])).toEqual(["m"]);
    const conn = { provider: "codex", providerSpecificData: { enabledModels: ["m(low)"] } };
    expect(isConnectionEligibleForModel(conn, "m(xhigh)")).toBe(true);
  });
});
