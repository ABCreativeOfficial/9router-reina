import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
}));

const { describeNoEligibleAccountForModel } = await import("@/sse/services/accountModelPolicy.js");

const conn = (id, enabledModels) => ({
  id,
  provider: "codex",
  isActive: true,
  providerSpecificData: enabledModels ? { enabledModels } : {},
});

describe("describeNoEligibleAccountForModel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the policy reason when every account bars the model", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("E", ["b"]), conn("F", ["b"])]);
    const reason = await describeNoEligibleAccountForModel("codex", "sol");
    expect(reason).toContain("no_eligible_account_for_model");
    expect(reason).toContain("sol");
    expect(reason).toContain("codex");
  });

  it("stays silent when the provider simply has no accounts", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    expect(await describeNoEligibleAccountForModel("codex", "sol")).toBeNull();
  });

  it("stays silent when at least one account is eligible", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("E", ["b"]), conn("A", ["sol"])]);
    expect(await describeNoEligibleAccountForModel("codex", "sol")).toBeNull();
  });

  it("stays silent for a model-less lookup", async () => {
    expect(await describeNoEligibleAccountForModel("codex", null)).toBeNull();
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  });

  it("never leaks credentials into the message", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...conn("E", ["b"]), accessToken: "secret-token", apiKey: "sk-secret" },
    ]);
    const reason = await describeNoEligibleAccountForModel("codex", "sol");
    expect(reason).not.toContain("secret");
  });

  it("fails open when the DB read throws", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("db down"));
    expect(await describeNoEligibleAccountForModel("codex", "sol")).toBeNull();
  });
});
