import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: db.getProviderConnections,
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const discovery = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../open-sse/services/codexModelDiscovery.js", () => ({
  resolveCodexLiveModels: discovery.resolve,
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("/v1/models Codex automatic discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.getProviderConnections.mockResolvedValue([{
      id: "codex-live-account", provider: "codex", accessToken: "test-only",
      isActive: true, providerSpecificData: {},
    }]);
    discovery.resolve.mockResolvedValue({ models: [
      { id: "gpt-7.9-auto", name: "GPT 7.9 Auto" },
      { id: "gpt-7.9-auto-high", name: "GPT 7.9 Auto high" },
      { id: "gpt-7.9-auto-(fast)", name: "GPT 7.9 Auto (Fast)" },
    ] });
  });

  it("publishes newly discovered canonical models and aliases", async () => {
    const models = await buildModelsList(["llm"]);
    expect(models.map((m) => m.id)).toEqual(expect.arrayContaining([
      "cx/gpt-7.9-auto", "cx/gpt-7.9-auto-high", "cx/gpt-7.9-auto-(fast)",
    ]));
    expect(discovery.resolve).toHaveBeenCalledTimes(1);
  });

  it("falls back to bundled models on catalog failure", async () => {
    discovery.resolve.mockResolvedValue({ models: [], warning: "Offline" });
    const models = await buildModelsList(["llm"]);
    expect(models.some((m) => m.id === "cx/gpt-6.2-sol")).toBe(true);
  });

  it("retains Codex native image and STT models while the chat catalog is live", async () => {
    const images = await buildModelsList(["image"]);
    expect(images.some((m) => m.id === "cx/gpt-image-2.5")).toBe(true);
    const speech = await buildModelsList(["stt"]);
    expect(speech.some((m) => m.id === "cx/transcribe")).toBe(true);
  });

  it("unions new models across multiple active Codex accounts", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "codex-A", provider: "codex", accessToken: "token-A", isActive: true },
      { id: "codex-B", provider: "codex", accessToken: "token-B", isActive: true },
    ]);
    discovery.resolve.mockImplementation(async (conn) => ({ models: [
      { id: `gpt-new-${conn.id}`, name: `GPT New ${conn.id}` },
    ] }));
    const models = await buildModelsList(["llm"]);
    expect(models.some((m) => m.id === "cx/gpt-new-codex-A")).toBe(true);
    expect(models.some((m) => m.id === "cx/gpt-new-codex-B")).toBe(true);
    expect(discovery.resolve).toHaveBeenCalledTimes(2);
  });

  it("respects the account's explicit model allowlist", async () => {
    db.getProviderConnections.mockResolvedValue([{
      id: "codex-live-account", provider: "codex", accessToken: "test-only",
      isActive: true, providerSpecificData: { enabledModels: ["gpt-6.2-sol"] },
    }]);
    const models = await buildModelsList(["llm"]);
    expect(models.some((m) => m.id === "cx/gpt-6.2-sol")).toBe(true);
    expect(models.some((m) => m.id === "cx/gpt-7.9-auto")).toBe(false);
    expect(discovery.resolve).not.toHaveBeenCalled();
  });
});
