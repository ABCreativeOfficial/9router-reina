import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock("open-sse/services/newapi/resolve.js", () => ({ createNewApiClientForConnection: () => null }));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const connection = {
  id: "synthetic-connection",
  provider: "openai-compatible-chat-timeout-test",
  isActive: true,
  apiKey: "synthetic-only",
  providerSpecificData: {
    baseUrl: "https://models.example.test/v1",
    prefix: "synthetic",
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.getProviderConnections.mockResolvedValue([connection]);
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("compatible-provider model catalog timeout", () => {
  it("aborts a model response whose JSON body exceeds the five-second deadline", async () => {
    let signal;
    let releaseBody;
    const fetch = vi.fn(async (_url, init) => {
      signal = init.signal;
      return {
        ok: true,
        json: () => new Promise((resolve, reject) => {
          releaseBody = resolve;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      };
    });
    vi.stubGlobal("fetch", fetch);

    const modelsPromise = buildModelsList(["llm"]);
    try {
      for (let i = 0; i < 20 && !releaseBody; i++) await Promise.resolve();
      expect(fetch).toHaveBeenCalledOnce();
      expect(signal).toBeDefined();
      expect(releaseBody).toBeTypeOf("function");

      await vi.advanceTimersByTimeAsync(5_000);

      expect(signal.aborted).toBe(true);
      const models = await modelsPromise;
      expect(models.some((model) => model.owned_by === "synthetic")).toBe(false);
    } finally {
      releaseBody?.({ data: [] });
      await modelsPromise.catch(() => {});
    }
  });
});
