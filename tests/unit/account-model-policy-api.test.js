import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getProviderConnectionById: vi.fn(),
  getProxyPoolById: vi.fn(),
  updateProviderConnection: vi.fn(async (id, data) => ({ id, ...data })),
  deleteProviderConnection: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProxyPoolById: mocks.getProxyPoolById,
  updateProviderConnection: mocks.updateProviderConnection,
  deleteProviderConnection: mocks.deleteProviderConnection,
}));

const { PUT } = await import("../../src/app/api/providers/[id]/route.js");

const req = (body) => ({ json: async () => body });
const params = Promise.resolve({ id: "conn-1" });

const lastUpdate = () => mocks.updateProviderConnection.mock.calls.at(-1)[1];

describe("PUT /api/providers/[id] — enabledModels persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: "codex",
      authType: "oauth",
      providerSpecificData: {
        chatgptAccountId: "ws-123",
        proxyPoolId: "pool-1",
        enabledModels: ["old"],
      },
    });
  });

  it("stores a sanitized allowlist and preserves unrelated providerSpecificData", async () => {
    await PUT(req({ providerSpecificData: { enabledModels: [" sol ", "sol", "", 7, "gpt-5.5"] } }), { params });

    expect(lastUpdate().providerSpecificData).toEqual({
      chatgptAccountId: "ws-123",
      proxyPoolId: "pool-1",
      enabledModels: ["sol", "gpt-5.5"],
    });
  });

  it("an empty array clears the restriction rather than storing []", async () => {
    await PUT(req({ providerSpecificData: { enabledModels: [] } }), { params });

    const psd = lastUpdate().providerSpecificData;
    expect(psd.enabledModels).toBeUndefined();
    expect(psd.chatgptAccountId).toBe("ws-123");
  });

  it("null clears the restriction too", async () => {
    await PUT(req({ providerSpecificData: { enabledModels: null } }), { params });
    expect(lastUpdate().providerSpecificData.enabledModels).toBeUndefined();
  });

  it("leaves an existing allowlist untouched when the field is absent", async () => {
    await PUT(req({ name: "renamed" }), { params });

    expect(lastUpdate().providerSpecificData.enabledModels).toEqual(["old"]);
    expect(lastUpdate().name).toBe("renamed");
  });

  it("rejects a non-array payload", async () => {
    const res = await PUT(req({ providerSpecificData: { enabledModels: "sol" } }), { params });
    expect(res.status).toBe(400);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects an oversized payload", async () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `m${i}`);
    const res = await PUT(req({ providerSpecificData: { enabledModels: huge } }), { params });
    expect(res.status).toBe(400);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("composes with a proxy pool update without losing the allowlist", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "pool-2" });
    await PUT(req({ proxyPoolId: "pool-2", providerSpecificData: { enabledModels: ["sol"] } }), { params });

    expect(lastUpdate().providerSpecificData).toEqual({
      chatgptAccountId: "ws-123",
      proxyPoolId: "pool-2",
      enabledModels: ["sol"],
    });
  });

  it("normalizes level-suffixed entries down to their base model", async () => {
    await PUT(req({ providerSpecificData: { enabledModels: [" m(low) ", "m(low)", "m(high)", "n"] } }), { params });
    expect(lastUpdate().providerSpecificData.enabledModels).toEqual(["m", "n"]);
  });
});

describe("PUT /api/providers/[id] — server-owned providerSpecificData keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: "codex",
      authType: "oauth",
      accessToken: "oauth-access-token",
      providerSpecificData: { chatgptAccountId: "ws-123" },
    });
  });

  it("refuses to let a caller set the New API management target", async () => {
    // Otherwise any connection could be pointed at an arbitrary host, and the
    // family-based usage/models hooks would send its accessToken there as a Bearer.
    await PUT(req({
      providerSpecificData: {
        newApiOrigin: "https://attacker.example",
        newApiLabel: "Evil",
      },
    }), { params });

    const psd = lastUpdate().providerSpecificData;
    expect(psd.newApiOrigin).toBeUndefined();
    expect(psd.newApiLabel).toBeUndefined();
    expect(psd.chatgptAccountId).toBe("ws-123");
  });

  it("refuses the other node-owned keys too", async () => {
    await PUT(req({
      providerSpecificData: {
        baseUrl: "https://attacker.example/v1",
        prefix: "hijack",
        apiType: "responses",
        nodeName: "Evil",
      },
    }), { params });

    const psd = lastUpdate().providerSpecificData;
    for (const key of ["baseUrl", "prefix", "apiType", "nodeName"]) {
      expect(psd[key], key).toBeUndefined();
    }
  });

  it("does not disturb a stored value the server itself wrote", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: "openai-compatible-chat-example",
      authType: "apikey",
      providerSpecificData: {
        userId: "42",
        newApiOrigin: "https://example.com",
        baseUrl: "https://example.com/v1",
      },
    });

    await PUT(req({ providerSpecificData: { enabledModels: ["m"] } }), { params });

    const psd = lastUpdate().providerSpecificData;
    expect(psd.newApiOrigin).toBe("https://example.com");
    expect(psd.baseUrl).toBe("https://example.com/v1");
    expect(psd.enabledModels).toEqual(["m"]);
  });
});
