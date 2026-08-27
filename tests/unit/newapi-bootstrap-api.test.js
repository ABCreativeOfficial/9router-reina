import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://example.com";
const PROVIDER_ID = "openai-compatible-chat-example";
const MANAGEMENT_TOKEN = "management-token-fixture";
const FULL_KEY = "full-inference-key";

const NODE = Object.freeze({
  id: PROVIDER_ID,
  type: "openai-compatible",
  apiType: "chat",
  family: "new-api",
  name: "Example API",
  prefix: "ex",
  baseUrl: `${ORIGIN}/v1`,
  newApi: { origin: ORIGIN },
});

const mocks = vi.hoisted(() => ({
  createProviderConnection: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getAccount: vi.fn(),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  retrieveTokenKey: vi.fn(),
  validateInferenceKey: vi.fn(),
  fetchModels: vi.fn(),
  resolveClient: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/sse/services/newapiProvider", () => ({
  resolveNewApiProviderClient: mocks.resolveClient,
}));

const { POST } = await import("../../src/app/api/new-api/bootstrap/route.js");

const CLIENT = {
  label: "Example API",
  activeStatus: 1,
  getAccount: mocks.getAccount,
  listTokens: mocks.listTokens,
  createToken: mocks.createToken,
  retrieveTokenKey: mocks.retrieveTokenKey,
  validateInferenceKey: mocks.validateInferenceKey,
  fetchModels: mocks.fetchModels,
};

function request(body) {
  return new Request("http://localhost/api/new-api/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: PROVIDER_ID, ...body }),
  });
}

/** Token metadata as client.listTokens() returns it. */
function token(overrides = {}) {
  return {
    id: 7,
    name: "Reusable",
    maskedKey: "abcd**********wxyz",
    status: 1,
    group: "",
    unlimitedQuota: true,
    modelLimitsEnabled: false,
    remainQuota: null,
    usedQuota: null,
    expiredTime: -1,
    accessedTime: 100,
    createdTime: 10,
    ...overrides,
  };
}

const connect = (extra = {}) => POST(request({
  action: "connect",
  managementToken: MANAGEMENT_TOKEN,
  userId: "123",
  ...extra,
}));

describe("New API bootstrap route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveClient.mockResolvedValue({ client: CLIENT, node: NODE });
    mocks.getAccount.mockResolvedValue({
      ok: true,
      account: { id: "123", displayName: "Account", username: "acct-login", group: "default", status: 1 },
    });
    mocks.listTokens.mockResolvedValue({ ok: true, tokens: [token()] });
    mocks.retrieveTokenKey.mockResolvedValue({ ok: true, apiKey: FULL_KEY });
    mocks.validateInferenceKey.mockResolvedValue({ ok: true });
    mocks.fetchModels.mockResolvedValue({ ok: true, models: [{ id: "model-a", name: "model-a" }] });
    mocks.createToken.mockResolvedValue({ ok: true, name: "9Router Auto abcdef01" });
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.updateProviderConnection.mockImplementation(async (id, data) => ({ id, provider: PROVIDER_ID, ...data }));
    mocks.createProviderConnection.mockImplementation(async (data) => ({ id: "connection-1", ...data }));
  });

  it("rejects a provider that is not a New API definition", async () => {
    mocks.resolveClient.mockResolvedValue(null);
    const response = await POST(request({ managementToken: MANAGEMENT_TOKEN, userId: "123" }));
    expect(response.status).toBe(404);
    expect(mocks.getAccount).not.toHaveBeenCalled();
  });

  it("returns masked metadata only when inspecting", async () => {
    const response = await POST(request({
      action: "inspect",
      managementToken: MANAGEMENT_TOKEN,
      userId: "123",
    }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.tokens[0]).toMatchObject({ id: 7, maskedKey: "abcd**********wxyz" });
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(MANAGEMENT_TOKEN);
    expect(serialized).not.toContain(FULL_KEY);
    expect(mocks.retrieveTokenKey).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("persists the credential split plus the definition's family markers", async () => {
    const response = await connect();
    const data = await response.json();
    expect(response.status).toBe(201);

    const created = mocks.createProviderConnection.mock.calls[0][0];
    expect(created).toMatchObject({
      provider: PROVIDER_ID,
      authType: "apikey",
      // Inference uses the API key; the management token is never the bearer.
      apiKey: FULL_KEY,
      accessToken: MANAGEMENT_TOKEN,
    });
    expect(created.providerSpecificData).toMatchObject({
      userId: "123",
      newApiOrigin: ORIGIN,
      newApiLabel: "Example API",
      baseUrl: `${ORIGIN}/v1`,
      prefix: "ex",
    });
    expect(JSON.stringify(data)).not.toContain(FULL_KEY);
    expect(JSON.stringify(data)).not.toContain(MANAGEMENT_TOKEN);
  });

  it("names a new connection from the account identity, not the token name", async () => {
    await connect();
    expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("Account");

    // display_name → username → "<Label> <userId>"
    mocks.getAccount.mockResolvedValue({ ok: true, account: { id: "123", username: "acct-login", status: 1 } });
    mocks.createProviderConnection.mockClear();
    await connect();
    expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("acct-login");

    mocks.getAccount.mockResolvedValue({ ok: true, account: { id: "123", status: 1 } });
    mocks.createProviderConnection.mockClear();
    await connect();
    expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("Example API 123");
  });

  it("uniquifies a colliding generated name instead of overwriting another account", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "other", name: "Account" }]);
    await connect();
    expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("Account (2)");
  });

  it("reconnects in place, preserving the custom name and enabledModels", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "existing-1",
      provider: PROVIDER_ID,
      name: "My Renamed Account",
      providerSpecificData: { userId: "123", enabledModels: ["model-a"] },
    }]);

    const response = await connect();
    expect(response.status).toBe(200);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();

    const [id, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(id).toBe("existing-1");
    expect(update).not.toHaveProperty("name");
    expect(update.providerSpecificData).toMatchObject({
      userId: "123",
      enabledModels: ["model-a"],
      newApiOrigin: ORIGIN,
    });
  });

  it("surfaces an invalid management credential without echoing it", async () => {
    mocks.getAccount.mockResolvedValue({ ok: false, status: 401, message: "auth failed" });
    const response = await connect();
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).not.toContain(MANAGEMENT_TOKEN);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
});

describe("automatic inference-token selection and creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveClient.mockResolvedValue({ client: CLIENT, node: NODE });
    mocks.getAccount.mockResolvedValue({ ok: true, account: { id: "123", displayName: "Account", status: 1 } });
    mocks.retrieveTokenKey.mockResolvedValue({ ok: true, apiKey: FULL_KEY });
    mocks.validateInferenceKey.mockResolvedValue({ ok: true });
    mocks.fetchModels.mockResolvedValue({ ok: true, models: [{ id: "model-a" }] });
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.createProviderConnection.mockImplementation(async (data) => ({ id: "connection-1", ...data }));
    mocks.updateProviderConnection.mockImplementation(async (id, data) => ({ id, ...data }));
  });

  const createdName = () => mocks.createToken.mock.calls[0][2].name;

  it("creates a dedicated token when the account has none", async () => {
    mocks.listTokens.mockResolvedValue({ ok: true, tokens: [] });
    mocks.createToken.mockImplementation(async (_t, _u, { name }) => {
      // Upstream returns no id, so the flow re-lists and matches the unique name.
      mocks.listTokens.mockResolvedValue({ ok: true, tokens: [token({ id: 99, name })] });
      return { ok: true, name };
    });

    const response = await connect();
    expect(response.status).toBe(201);
    expect(mocks.createToken).toHaveBeenCalledTimes(1);
    expect(createdName()).toMatch(/^9Router Auto /);
    expect(mocks.retrieveTokenKey).toHaveBeenCalledWith(MANAGEMENT_TOKEN, "123", 99, null);
    expect((await response.json()).tokenCreated).toBe(true);
  });

  it("creates one when every existing token is unusable", async () => {
    const unusable = [
      token({ id: 1, status: 2 }),                                        // disabled
      token({ id: 2, expiredTime: Math.floor(Date.now() / 1000) - 10 }),  // expired
      token({ id: 3, unlimitedQuota: false, remainQuota: 0 }),            // exhausted
    ];
    mocks.listTokens.mockResolvedValue({ ok: true, tokens: unusable });
    mocks.createToken.mockImplementation(async (_t, _u, { name }) => {
      mocks.listTokens.mockResolvedValue({ ok: true, tokens: [...unusable, token({ id: 50, name })] });
      return { ok: true, name };
    });

    await connect();
    expect(mocks.createToken).toHaveBeenCalledTimes(1);
    // No unusable candidate was ever tried.
    expect(mocks.retrieveTokenKey).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveTokenKey.mock.calls[0][2]).toBe(50);
  });

  it("uses the only usable token without creating one", async () => {
    mocks.listTokens.mockResolvedValue({ ok: true, tokens: [token({ id: 7 })] });
    const response = await connect();
    expect(mocks.createToken).not.toHaveBeenCalled();
    expect(mocks.retrieveTokenKey.mock.calls[0][2]).toBe(7);
    expect((await response.json()).tokenCreated).toBe(false);
  });

  it("prefers the most recently accessed of several usable tokens", async () => {
    mocks.listTokens.mockResolvedValue({
      ok: true,
      tokens: [
        token({ id: 1, accessedTime: 100 }),
        token({ id: 2, accessedTime: 300 }),
        token({ id: 3, accessedTime: 200 }),
      ],
    });
    await connect();
    expect(mocks.retrieveTokenKey.mock.calls[0][2]).toBe(2);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it("moves to the next candidate when key retrieval fails", async () => {
    mocks.listTokens.mockResolvedValue({
      ok: true,
      tokens: [token({ id: 1, accessedTime: 300 }), token({ id: 2, accessedTime: 100 })],
    });
    mocks.retrieveTokenKey
      .mockResolvedValueOnce({ ok: false, status: 502, message: "unavailable" })
      .mockResolvedValueOnce({ ok: true, apiKey: FULL_KEY });

    await connect();
    expect(mocks.retrieveTokenKey.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(mocks.createProviderConnection.mock.calls[0][0].apiKey).toBe(FULL_KEY);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it("moves to the next candidate when inference validation fails", async () => {
    mocks.listTokens.mockResolvedValue({
      ok: true,
      tokens: [token({ id: 1, accessedTime: 300 }), token({ id: 2, accessedTime: 100 })],
    });
    mocks.validateInferenceKey
      .mockResolvedValueOnce({ ok: false, status: 401, message: "unavailable" })
      .mockResolvedValueOnce({ ok: true });

    await connect();
    expect(mocks.retrieveTokenKey.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it("creates a token when every usable candidate fails validation", async () => {
    const existing = [token({ id: 1, accessedTime: 300 }), token({ id: 2, accessedTime: 100 })];
    mocks.listTokens.mockResolvedValue({ ok: true, tokens: existing });
    mocks.validateInferenceKey.mockResolvedValue({ ok: false, status: 401, message: "unavailable" });
    mocks.createToken.mockImplementation(async (_t, _u, { name }) => {
      mocks.listTokens.mockResolvedValue({ ok: true, tokens: [...existing, token({ id: 60, name })] });
      mocks.validateInferenceKey.mockResolvedValue({ ok: true });
      return { ok: true, name };
    });

    const response = await connect();
    expect(response.status).toBe(201);
    expect(mocks.createToken).toHaveBeenCalledTimes(1);
  });

  it("tries an explicitly chosen token first, but still validates it", async () => {
    mocks.listTokens.mockResolvedValue({
      ok: true,
      tokens: [token({ id: 1, accessedTime: 300 }), token({ id: 2, accessedTime: 100 })],
    });
    await connect({ tokenId: 2 });
    expect(mocks.retrieveTokenKey.mock.calls[0][2]).toBe(2);
  });

  it("ignores an explicit choice that is not usable", async () => {
    mocks.listTokens.mockResolvedValue({
      ok: true,
      tokens: [token({ id: 1, accessedTime: 300 }), token({ id: 2, status: 2 })],
    });
    await connect({ tokenId: 2 });
    expect(mocks.retrieveTokenKey.mock.calls[0][2]).toBe(1);
  });

  it("fails without persisting when the created token cannot be located", async () => {
    mocks.listTokens.mockResolvedValue({ ok: true, tokens: [] });
    mocks.createToken.mockResolvedValue({ ok: true, name: "9Router Auto deadbeef" });

    const response = await connect();
    expect(response.status).toBe(502);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("fails without persisting when the created key is masked or unverifiable", async () => {
    mocks.listTokens.mockResolvedValue({ ok: true, tokens: [] });
    mocks.createToken.mockImplementation(async (_t, _u, { name }) => {
      mocks.listTokens.mockResolvedValue({ ok: true, tokens: [token({ id: 70, name })] });
      return { ok: true, name };
    });
    // retrieveTokenKey already rejects a masked value; simulate that rejection.
    mocks.retrieveTokenKey.mockResolvedValue({ ok: false, status: 502, message: "unavailable" });

    const response = await connect();
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
    expect(body).not.toContain(FULL_KEY);
    expect(body).not.toContain(MANAGEMENT_TOKEN);
  });

  it("surfaces a creation failure without leaking the management token", async () => {
    mocks.listTokens.mockResolvedValue({ ok: true, tokens: [] });
    mocks.createToken.mockResolvedValue({
      ok: false,
      status: 502,
      message: "Unable to create a Example API API token.",
    });

    const response = await connect();
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(body).not.toContain(MANAGEMENT_TOKEN);
  });
});
