import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(async () => ({})),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  })),
  pickProxyPoolId: vi.fn(() => null),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn(),
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const acc = (id, enabledModels, extra = {}) => ({
  id,
  provider: "codex",
  isActive: true,
  authType: "oauth",
  accessToken: `tok-${id}`,
  priority: extra.priority ?? 1,
  ...extra,
  providerSpecificData: enabledModels ? { enabledModels } : {},
});

describe("getProviderCredentials — per-account model access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
  });

  it("legacy accounts with no policy behave exactly as before", async () => {
    mocks.getProviderConnections.mockResolvedValue([acc("A"), acc("B")]);
    const creds = await getProviderCredentials("codex", null, "sol");
    expect(creds.connectionId).toBe("A");
  });

  it("skips an account whose allowlist excludes the requested model", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      acc("E", ["a", "b"]),          // first by priority but not eligible
      acc("A", ["a", "b", "sol"]),
    ]);
    const creds = await getProviderCredentials("codex", null, "sol");
    expect(creds.connectionId).toBe("A");
  });

  it("filters BEFORE fill-first picks, so an ineligible top-priority account is never selected", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      acc("F", ["b"], { priority: 1 }),
      acc("E", ["a", "b"], { priority: 2 }),
      acc("C", ["a", "b", "sol"], { priority: 3 }),
    ]);
    const creds = await getProviderCredentials("codex", null, "sol");
    expect(creds.connectionId).toBe("C");
  });

  it("filters BEFORE round-robin, so rotation stays inside the eligible pool", async () => {
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
    mocks.getProviderConnections.mockResolvedValue([
      acc("E", ["b"], { lastUsedAt: "2026-01-01T00:00:00.000Z" }),  // oldest, ineligible
      acc("A", ["sol"], { lastUsedAt: "2026-01-02T00:00:00.000Z" }),
      acc("B", ["sol"], { lastUsedAt: "2026-01-03T00:00:00.000Z", consecutiveUseCount: 5 }),
    ]);
    const creds = await getProviderCredentials("codex", null, "sol");
    expect(["A", "B"]).toContain(creds.connectionId);
    expect(creds.connectionId).toBe("A"); // least-recently-used *eligible* account
  });

  it("rate-limit fallback stays inside the eligible pool", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      acc("A", ["sol"], { priority: 1 }),
      acc("B", ["sol"], { priority: 2 }),
      acc("C", ["sol"], { priority: 3 }),
      acc("D", ["b"], { priority: 4 }),
      acc("E", ["b"], { priority: 5 }),
    ]);
    const picked = [];
    const exclude = new Set();
    for (let i = 0; i < 3; i++) {
      const creds = await getProviderCredentials("codex", exclude, "sol");
      picked.push(creds.connectionId);
      exclude.add(creds.connectionId);
    }
    expect(picked).toEqual(["A", "B", "C"]);
    // Pool exhausted — must NOT fall through to D/E.
    expect(await getProviderCredentials("codex", exclude, "sol")).toBeNull();
  });

  it("zero eligible accounts returns null deterministically", async () => {
    mocks.getProviderConnections.mockResolvedValue([acc("E", ["b"]), acc("F", ["b"])]);
    expect(await getProviderCredentials("codex", null, "sol")).toBeNull();
  });

  it("a model enabled on every account keeps the whole pool routable", async () => {
    mocks.getProviderConnections.mockResolvedValue(
      ["A", "B", "C", "D", "E", "F"].map((id, i) => acc(id, ["b"], { priority: i + 1 }))
    );
    const exclude = new Set();
    const picked = [];
    for (let i = 0; i < 6; i++) {
      const creds = await getProviderCredentials("codex", exclude, "b");
      picked.push(creds.connectionId);
      exclude.add(creds.connectionId);
    }
    expect(picked).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("model lock inside the eligible pool still reports allRateLimited", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    mocks.getProviderConnections.mockResolvedValue([
      acc("A", ["sol"], { modelLock_sol: future, lastError: "429" }),
      acc("E", ["b"]),
    ]);
    const creds = await getProviderCredentials("codex", null, "sol");
    expect(creds.allRateLimited).toBe(true);
    expect(creds.retryAfter).toBe(future);
  });

  it("policy does not affect a model-less lookup", async () => {
    mocks.getProviderConnections.mockResolvedValue([acc("A", ["sol"])]);
    const creds = await getProviderCredentials("codex", null, null);
    expect(creds.connectionId).toBe("A");
  });
});
