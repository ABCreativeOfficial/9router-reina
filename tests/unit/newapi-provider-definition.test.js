import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://example.com";

const mocks = vi.hoisted(() => ({
  getProviderNodes: vi.fn(),
  getProviderNodeById: vi.fn(),
  createProviderNode: vi.fn(),
  fetchStatus: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderNodes: mocks.getProviderNodes,
  getProviderNodeById: mocks.getProviderNodeById,
  createProviderNode: mocks.createProviderNode,
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.fetchStatus,
}));

const {
  allocateNewApiAlias,
  getNewApiProviderDefinition,
  isNewApiAliasAvailable,
  isNewApiProvider,
  listNewApiProviders,
  prepareNewApiProviderDefinition,
  probeNewApiOrigin,
  resolveNewApiProviderClient,
} = await import("../../src/sse/services/newapiProvider.js");
const { POST: createProvider, GET: listProviders } = await import(
  "../../src/app/api/new-api/providers/route.js"
);

function newApiNode(overrides = {}) {
  return {
    id: "openai-compatible-chat-example",
    type: "openai-compatible",
    apiType: "chat",
    family: "new-api",
    name: "Example API",
    prefix: "ex",
    baseUrl: `${ORIGIN}/v1`,
    newApi: { origin: ORIGIN },
    ...overrides,
  };
}

function statusResponse(ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    json: async () => (ok ? { success: true, data: { quota_per_unit: 500000 } } : {}),
  };
}

function createRequest(body) {
  return new Request("http://localhost/api/new-api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("New API provider definitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getProviderNodeById.mockResolvedValue(null);
    mocks.fetchStatus.mockResolvedValue(statusResponse(true));
    mocks.createProviderNode.mockImplementation(async (data) => ({ ...data, createdAt: "t", updatedAt: "t" }));
  });

  it("lists only family-marked nodes", async () => {
    mocks.getProviderNodes.mockResolvedValue([
      newApiNode(),
      // A plain compatible node must not appear as a New API provider.
      { id: "openai-compatible-chat-plain", type: "openai-compatible", name: "Plain", prefix: "pl" },
      // Family marker with an unusable origin is not a definition either.
      newApiNode({ id: "bad", newApi: { origin: "http://example.com" } }),
    ]);
    const providers = await listNewApiProviders();
    expect(providers.map((node) => node.id)).toEqual(["openai-compatible-chat-example"]);
  });

  it("resolves a provider id to its definition and a management client", async () => {
    const node = newApiNode();
    mocks.getProviderNodeById.mockResolvedValue(node);

    expect(await getNewApiProviderDefinition(node.id)).toBe(node);
    expect(await isNewApiProvider(node.id)).toBe(true);

    const resolved = await resolveNewApiProviderClient(node.id);
    // The client's origin comes from the persisted definition, nothing else.
    expect(resolved.client.origin).toBe(ORIGIN);
    expect(resolved.client.endpoints.account).toBe(`${ORIGIN}/api/user/self`);
    expect(resolved.node).toBe(node);
  });

  it("refuses to resolve a non-New-API provider", async () => {
    mocks.getProviderNodeById.mockResolvedValue({
      id: "openai-compatible-chat-plain",
      type: "openai-compatible",
      name: "Plain",
    });
    expect(await getNewApiProviderDefinition("openai-compatible-chat-plain")).toBeNull();
    expect(await resolveNewApiProviderClient("openai-compatible-chat-plain")).toBeNull();
    expect(await isNewApiProvider("claude")).toBe(false);
    expect(await getNewApiProviderDefinition(null)).toBeNull();
  });
});

describe("New API alias collisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.fetchStatus.mockResolvedValue(statusResponse(true));
    mocks.createProviderNode.mockImplementation(async (data) => ({ ...data }));
  });

  it("rejects an alias that a compiled-in provider already owns", async () => {
    // Static provider ids and aliases both count.
    for (const taken of ["claude", "cc", "openai", "codex", "cx", "xmtp"]) {
      expect(await isNewApiAliasAvailable(taken), taken).toBe(false);
    }
    expect(await isNewApiAliasAvailable("definitely-unused-prefix")).toBe(true);
  });

  it("rejects an alias another dynamic node already uses", async () => {
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-a", prefix: "ex" },
    ]);
    expect(await isNewApiAliasAvailable("ex")).toBe(false);
    // …unless that very node is the one being edited.
    expect(await isNewApiAliasAvailable("ex", "openai-compatible-chat-a")).toBe(true);
  });

  it("allocates the next free alias from a name", async () => {
    mocks.getProviderNodes.mockResolvedValue([{ id: "n1", prefix: "example-api" }]);
    expect(await allocateNewApiAlias("Example API")).toBe("example-api-2");
  });
});

describe("New API provider creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.fetchStatus.mockResolvedValue(statusResponse(true));
    mocks.createProviderNode.mockImplementation(async (data) => ({ ...data }));
  });

  it("derives family, /v1 base URL and node type from Name + Origin + Alias", async () => {
    const prepared = await prepareNewApiProviderDefinition({
      name: "Example API",
      origin: ORIGIN,
      alias: "ex",
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.definition).toEqual({
      type: "openai-compatible",
      apiType: "chat",
      family: "new-api",
      name: "Example API",
      prefix: "ex",
      baseUrl: `${ORIGIN}/v1`,
      newApi: { origin: ORIGIN },
    });
  });

  it("derives a free alias when none is given", async () => {
    const prepared = await prepareNewApiProviderDefinition({ name: "TabiToken", origin: ORIGIN });
    expect(prepared.ok).toBe(true);
    expect(prepared.definition.prefix).toBe("tabitoken");
  });

  it("rejects an unusable origin with an actionable message", async () => {
    for (const origin of ["http://example.com", `${ORIGIN}/v1`, "https://u:p@example.com", "nope"]) {
      const prepared = await prepareNewApiProviderDefinition({ name: "X", origin });
      expect(prepared.ok, origin).toBe(false);
      expect(prepared.status).toBe(400);
    }
  });

  it("rejects a duplicate definition for the same canonical origin", async () => {
    mocks.getProviderNodes.mockResolvedValue([newApiNode()]);
    const prepared = await prepareNewApiProviderDefinition({
      name: "Second",
      // A trailing slash is the same canonical origin.
      origin: `${ORIGIN}/`,
      alias: "se",
    });
    expect(prepared.ok).toBe(false);
    expect(prepared.status).toBe(409);
  });

  it("rejects an alias collision and an invalid alias separately", async () => {
    const collision = await prepareNewApiProviderDefinition({ name: "X", origin: ORIGIN, alias: "claude" });
    expect(collision).toMatchObject({ ok: false, status: 409 });

    const invalid = await prepareNewApiProviderDefinition({ name: "X", origin: ORIGIN, alias: "Bad Alias" });
    expect(invalid).toMatchObject({ ok: false, status: 400 });
  });

  it("requires a name", async () => {
    expect(await prepareNewApiProviderDefinition({ name: "  ", origin: ORIGIN }))
      .toMatchObject({ ok: false, status: 400 });
  });
});

describe("New API compatibility probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.createProviderNode.mockImplementation(async (data) => ({ ...data }));
  });

  it("accepts an origin that answers /api/status", async () => {
    mocks.fetchStatus.mockResolvedValue(statusResponse(true));
    const probe = await probeNewApiOrigin(ORIGIN, "Example API");
    expect(probe.ok).toBe(true);
    // The probe is public: no management credential is sent.
    const [url, options] = mocks.fetchStatus.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/status`);
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("rejects an origin that does not answer, with an actionable message", async () => {
    mocks.fetchStatus.mockResolvedValue(statusResponse(false));
    const probe = await probeNewApiOrigin(ORIGIN, "Example API");
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain(ORIGIN);
  });

  it("uses no deployment fingerprint — any New API-shaped status passes", async () => {
    mocks.fetchStatus.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { version: "unknown-fork-9.9" } }),
    });
    expect((await probeNewApiOrigin(ORIGIN)).ok).toBe(true);
  });
});

describe("POST /api/new-api/providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.fetchStatus.mockResolvedValue(statusResponse(true));
    mocks.createProviderNode.mockImplementation(async (data) => ({ ...data }));
  });

  it("probes, then persists a definition in the openai-compatible id namespace", async () => {
    const response = await createProvider(createRequest({
      name: "Example API",
      origin: ORIGIN,
      alias: "ex",
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    const persisted = mocks.createProviderNode.mock.calls[0][0];
    // Sharing the compat namespace is what keeps inference routing unchanged.
    expect(persisted.id).toMatch(/^openai-compatible-chat-/);
    expect(persisted).toMatchObject({ family: "new-api", prefix: "ex", baseUrl: `${ORIGIN}/v1` });
    expect(payload.provider).toMatchObject({
      name: "Example API",
      alias: "ex",
      origin: ORIGIN,
      baseUrl: `${ORIGIN}/v1`,
    });
  });

  it("does not persist when the probe fails", async () => {
    mocks.fetchStatus.mockResolvedValue(statusResponse(false));
    const response = await createProvider(createRequest({ name: "Example API", origin: ORIGIN }));
    expect(response.status).toBe(502);
    expect(mocks.createProviderNode).not.toHaveBeenCalled();
  });

  it("rejects a bad body before touching the DB", async () => {
    const response = await createProvider(new Request("http://localhost/api/new-api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    }));
    expect(response.status).toBe(400);
    expect(mocks.createProviderNode).not.toHaveBeenCalled();
  });

  it("lists definitions with their origin and alias", async () => {
    mocks.getProviderNodes.mockResolvedValue([newApiNode()]);
    const payload = await (await listProviders()).json();
    expect(payload.providers).toEqual([expect.objectContaining({
      id: "openai-compatible-chat-example",
      name: "Example API",
      alias: "ex",
      origin: ORIGIN,
    })]);
  });
});
