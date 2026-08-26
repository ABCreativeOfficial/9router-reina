import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getProviderConnections: vi.fn(),
  createProviderConnection: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProxyPoolById: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));

vi.mock("@/models", () => ({
  getProviderConnections: mocks.getProviderConnections,
  createProviderConnection: mocks.createProviderConnection,
  getProviderNodeById: mocks.getProviderNodeById,
  getProxyPoolById: mocks.getProxyPoolById,
}));

const { POST: EXPORT } = await import("../../src/app/api/providers/export/route.js");
const { POST: IMPORT } = await import("../../src/app/api/providers/import/route.js");
const { buildExportPayload } = await import("@/lib/providerConnectionTransfer");

const req = (body) => ({ json: async () => body });

const codexConn = (over = {}) => ({
  id: "codex-1",
  provider: "codex",
  authType: "oauth",
  name: "Work",
  email: "a@example.com",
  accessToken: "at-secret",
  refreshToken: "rt-secret",
  idToken: "it-secret",
  priority: 1,
  isActive: true,
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-02T00:00:00.000Z",
  providerSpecificData: { chatgptAccountId: "ws-1", enabledModels: ["gpt-5.5"], proxyPoolId: "pool-1" },
  ...over,
});

const serialized = (s) => JSON.stringify(s);

describe("POST /api/providers/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockImplementation(async ({ provider }) =>
      provider === "codex" ? [codexConn(), codexConn({ id: "codex-2", email: "b@example.com" })] : []
    );
  });

  it("exports only the selected IDs", async () => {
    const res = await EXPORT(req({ provider: "codex", connectionIds: ["codex-2"] }));
    expect(res.status).toBe(200);
    expect(res.body.export.connections).toHaveLength(1);
    expect(res.body.export.connections[0].email).toBe("b@example.com");
  });

  it("scopes the ID lookup to the requested provider", async () => {
    await EXPORT(req({ provider: "codex", connectionIds: ["codex-1"] }));
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ provider: "codex" });
  });

  it("rejects an ID belonging to another provider without leaking it", async () => {
    // gemini-1 exists in the DB, but not under codex.
    const res = await EXPORT(req({ provider: "codex", connectionIds: ["gemini-1"] }));
    expect(res.status).toBe(404);
    expect(serialized(res.body)).not.toContain("at-secret");
  });

  it("rejects a partially valid selection rather than exporting a subset", async () => {
    const res = await EXPORT(req({ provider: "codex", connectionIds: ["codex-1", "missing"] }));
    expect(res.status).toBe(404);
    expect(res.body.export).toBeUndefined();
  });

  it("requires a provider and a non-empty ID list", async () => {
    expect((await EXPORT(req({ connectionIds: ["codex-1"] }))).status).toBe(400);
    expect((await EXPORT(req({ provider: "codex" }))).status).toBe(400);
    expect((await EXPORT(req({ provider: "codex", connectionIds: [] }))).status).toBe(400);
  });

  it("rejects invalid JSON body", async () => {
    const res = await EXPORT({ json: async () => { throw new Error("bad"); } });
    expect(res.status).toBe(400);
  });

  it("includes credentials and a date-stamped filename", async () => {
    const res = await EXPORT(req({ provider: "codex", connectionIds: ["codex-1"] }));
    const c = res.body.export.connections[0];
    expect(c.accessToken).toBe("at-secret");
    expect(c.refreshToken).toBe("rt-secret");
    expect(c.idToken).toBe("it-secret");
    expect(c.providerSpecificData.enabledModels).toEqual(["gpt-5.5"]);
    expect(c.id).toBeUndefined();
    expect(res.body.filename).toMatch(/^9router-codex-connections-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("does not leak credentials on an internal failure", async () => {
    mocks.getProviderConnections.mockRejectedValueOnce(new Error("db down at-secret"));
    const res = await EXPORT(req({ provider: "codex", connectionIds: ["codex-1"] }));
    expect(res.status).toBe(500);
    expect(serialized(res.body)).not.toContain("at-secret");
  });
});

describe("POST /api/providers/import", () => {
  const payload = (over = {}) => ({ ...buildExportPayload("codex", [codexConn()]), ...over });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getProxyPoolById.mockResolvedValue(null);
    mocks.createProviderConnection.mockImplementation(async (d) => ({ id: `new-${d.email || d.name}` }));
  });

  it("imports a valid exported file", async () => {
    const res = await IMPORT(req({ provider: "codex", export: payload() }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: 1, failed: 0, skipped: 0 });
    const created = mocks.createProviderConnection.mock.calls[0][0];
    expect(created.provider).toBe("codex");
    expect(created.accessToken).toBe("at-secret");
    expect(created.providerSpecificData.enabledModels).toEqual(["gpt-5.5"]);
    expect(created.id).toBeUndefined();
  });

  it("rejects invalid JSON, wrong format, bad version, wrong provider, empty list", async () => {
    expect((await IMPORT({ json: async () => { throw new Error("x"); } })).status).toBe(400);
    expect((await IMPORT(req({ provider: "codex", export: payload({ format: "nope" }) }))).status).toBe(400);
    expect((await IMPORT(req({ provider: "codex", export: payload({ version: 42 }) }))).status).toBe(400);
    expect((await IMPORT(req({ provider: "codex", export: payload({ provider: "gemini" }) }))).status).toBe(400);
    expect((await IMPORT(req({ provider: "codex", export: payload({ connections: [] }) }))).status).toBe(400);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("requires a provider in the body even when the file has one", async () => {
    expect((await IMPORT(req({ export: payload() }))).status).toBe(400);
  });

  it("produces a deterministic per-index summary on partial failure", async () => {
    const good = buildExportPayload("codex", [codexConn()]).connections[0];
    const res = await IMPORT(req({
      provider: "codex",
      export: { ...payload(), connections: [good, { authType: "oauth" }, "not-an-object"] },
    }));
    expect(res.body.success).toBe(1);
    expect(res.body.failed).toBe(2);
    expect(res.body.results.map((r) => [r.index, r.ok])).toEqual([[0, true], [1, false], [2, false]]);
  });

  it("creates serially so priority assignment cannot race", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.createProviderConnection.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { id: "x" };
    });
    const conns = buildExportPayload("codex", [
      codexConn(), codexConn({ id: "c2", email: "b@e.com" }), codexConn({ id: "c3", email: "c@e.com" }),
    ]);
    await IMPORT(req({ provider: "codex", export: conns }));
    expect(maxInFlight).toBe(1);
  });

  it("skips an obvious duplicate instead of overwriting it", async () => {
    mocks.getProviderConnections.mockResolvedValue([codexConn()]);
    const res = await IMPORT(req({ provider: "codex", export: payload() }));
    expect(res.body).toMatchObject({ success: 0, skipped: 1 });
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("skips a duplicate inside the same file after the first create", async () => {
    const two = buildExportPayload("codex", [codexConn(), codexConn({ id: "c2" })]);
    const res = await IMPORT(req({ provider: "codex", export: two }));
    expect(res.body).toMatchObject({ success: 1, skipped: 1 });
  });

  it("drops a proxyPoolId that does not exist locally, without failing the account", async () => {
    const res = await IMPORT(req({ provider: "codex", export: payload() }));
    expect(res.body.success).toBe(1);
    expect(mocks.createProviderConnection.mock.calls[0][0].providerSpecificData.proxyPoolId).toBeUndefined();
  });

  it("restores a proxyPoolId that does exist locally", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ id: "pool-1" });
    await IMPORT(req({ provider: "codex", export: payload() }));
    expect(mocks.createProviderConnection.mock.calls[0][0].providerSpecificData.proxyPoolId).toBe("pool-1");
  });

  it("requires the node definition for a custom-compatible provider", async () => {
    mocks.getProviderNodeById.mockResolvedValue(null);
    const compat = buildExportPayload("openai-compatible-x", [
      { authType: "apikey", name: "Key", apiKey: "sk-1" },
    ]);
    const res = await IMPORT(req({ provider: "openai-compatible-x", export: compat }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Provider definition must exist/);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("imports for a custom-compatible provider when the node exists", async () => {
    mocks.getProviderNodeById.mockResolvedValue({ id: "openai-compatible-x", baseUrl: "http://x" });
    const compat = buildExportPayload("openai-compatible-x", [
      { authType: "apikey", name: "Key", apiKey: "sk-1", providerSpecificData: { enabledModels: ["m"] } },
    ]);
    const res = await IMPORT(req({ provider: "openai-compatible-x", export: compat }));
    expect(res.body.success).toBe(1);
    expect(mocks.createProviderConnection.mock.calls[0][0].providerSpecificData.enabledModels).toEqual(["m"]);
  });

  it("never echoes a credential value in the result summary", async () => {
    mocks.createProviderConnection.mockRejectedValueOnce(new Error("write failed"));
    const res = await IMPORT(req({ provider: "codex", export: payload() }));
    const dumped = serialized(res.body);
    for (const secret of ["at-secret", "rt-secret", "it-secret"]) {
      expect(dumped).not.toContain(secret);
    }
  });
});
