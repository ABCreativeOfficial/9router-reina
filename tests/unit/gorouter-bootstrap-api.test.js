import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProviderConnection: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  validate: vi.fn(),
  list: vi.fn(),
  retrieve: vi.fn(),
  validateInference: vi.fn(),
  models: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("open-sse/services/gorouter.js", () => ({
  // The bootstrap binding now talks to the shared New API client object, so the
  // mock mirrors that surface rather than the old per-function exports.
  gorouterClient: {
    label: "GoRouter",
    activeStatus: 1,
    getAccount: mocks.validate,
    listTokens: mocks.list,
    retrieveTokenKey: mocks.retrieve,
    validateInferenceKey: mocks.validateInference,
    fetchModels: mocks.models,
  },
}));

import { POST } from "../../src/app/api/providers/gorouter/bootstrap/route.js";

function request(body) {
  return new Request("http://localhost/api/providers/gorouter/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GoRouter bootstrap API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validate.mockResolvedValue({ ok: true, account: { id: "123", displayName: "Account", username: "acct-login", group: "default", status: 1 } });
    mocks.list.mockResolvedValue({ ok: true, tokens: [{ id: 7, name: "Reusable", maskedKey: "abcd**********wxyz", status: 1 }] });
    mocks.retrieve.mockResolvedValue({ ok: true, apiKey: "full-inference-key" });
    mocks.validateInference.mockResolvedValue({ ok: true });
    mocks.models.mockResolvedValue({ ok: true, models: [{ id: "model-a", name: "model-a" }] });
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.updateProviderConnection.mockImplementation(async (id, data) => ({ id, provider: "gorouter", ...data }));
    mocks.createProviderConnection.mockResolvedValue({ id: "connection-1", provider: "gorouter", name: "Account", authType: "apikey" });
  });

  it("returns metadata only during token selection", async () => {
    const response = await POST(request({ managementToken: "management-token", userId: "123", action: "inspect" }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.tokens[0]).toMatchObject({ id: 7, maskedKey: "abcd**********wxyz" });
    expect(JSON.stringify(data)).not.toContain("management-token");
    expect(JSON.stringify(data)).not.toContain("full-inference-key");
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("retrieves and persists selected inference key server-side", async () => {
    const response = await POST(request({
      managementToken: "management-token",
      userId: "123",
      tokenId: 7,
      name: "GoRouter A",
      action: "connect",
    }));
    const data = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "gorouter",
      authType: "apikey",
      name: "GoRouter A",
      apiKey: "full-inference-key",
      accessToken: "management-token",
      providerSpecificData: { userId: "123" },
    }));
    expect(JSON.stringify(data)).not.toContain("management-token");
    expect(JSON.stringify(data)).not.toContain("full-inference-key");
  });

  it("rejects inactive selection and never creates tokens automatically", async () => {
    mocks.list.mockResolvedValue({ ok: true, tokens: [{ id: 7, status: 0, maskedKey: "masked" }] });
    const response = await POST(request({ managementToken: "token", userId: "123", tokenId: 7, action: "connect" }));
    // 409 + needs_token_creation: creating a token is an explicit user action.
    expect(response.status).toBe(409);
    expect((await response.json()).state).toBe("needs_token_creation");
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("returns safe management-auth failures", async () => {
    mocks.validate.mockResolvedValue({ ok: false, status: 401, message: "GoRouter management authentication failed." });
    const response = await POST(request({ managementToken: "secret", userId: "123" }));
    const data = await response.json();
    expect(response.status).toBe(401);
    expect(data.error).toMatch(/authentication failed/i);
    expect(JSON.stringify(data)).not.toContain("secret");
  });

  it("reports needs_token_creation when the account has no usable token", async () => {
    mocks.list.mockResolvedValue({ ok: true, tokens: [{ id: 7, status: 0, maskedKey: "masked" }] });
    const response = await POST(request({ managementToken: "management-token", userId: "123", action: "inspect" }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.state).toBe("needs_token_creation");
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("reconnect updates the existing account instead of creating a duplicate", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "existing-1",
        provider: "gorouter",
        name: "GoRouter A",
        providerSpecificData: { userId: "123", enabledModels: ["model-a"] },
      },
    ]);

    const response = await POST(request({
      managementToken: "management-token",
      userId: "123",
      tokenId: 7,
      action: "connect",
    }));

    expect(response.status).toBe(200);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("existing-1", expect.objectContaining({
      apiKey: "full-inference-key",
      accessToken: "management-token",
      // enabledModels must survive: providerSpecificData is a shallow replace.
      providerSpecificData: { userId: "123", enabledModels: ["model-a"] },
    }));
  });

  it("add-account keeps a different account's connection intact", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "other-1", provider: "gorouter", name: "Account", providerSpecificData: { userId: "999" } },
    ]);

    const response = await POST(request({
      managementToken: "management-token",
      userId: "123",
      tokenId: 7,
      name: "Account",
      action: "connect",
    }));

    expect(response.status).toBe(201);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    // Name collision would silently overwrite the other account under the repo's
    // name-only apikey dedup, so the new connection gets a distinct name.
    const created = mocks.createProviderConnection.mock.calls[0][0];
    expect(created.providerSpecificData).toEqual({ userId: "123" });
    expect(created.name).not.toBe("Account");
  });

  describe("new connection naming", () => {
    const connect = () => POST(request({
      managementToken: "management-token",
      userId: "123",
      tokenId: 7,
      action: "connect",
    }));

    it("names a new account from display_name, ignoring the token name", async () => {
      mocks.list.mockResolvedValue({ ok: true, tokens: [{ id: 7, name: "9router", status: 1 }] });

      expect((await connect()).status).toBe(201);
      expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("Account");
    });

    it("falls back to username when display_name is empty", async () => {
      mocks.validate.mockResolvedValue({
        ok: true,
        account: { id: "123", displayName: "", username: "acct-login", group: "default", status: 1 },
      });
      mocks.list.mockResolvedValue({ ok: true, tokens: [{ id: 7, name: "9router", status: 1 }] });

      await connect();
      expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("acct-login");
    });

    it("falls back to GoRouter <userId> when the account has no names", async () => {
      mocks.validate.mockResolvedValue({
        ok: true,
        account: { id: "123", displayName: "", username: "", group: "default", status: 1 },
      });
      mocks.list.mockResolvedValue({ ok: true, tokens: [{ id: 7, name: "9router", status: 1 }] });

      await connect();
      expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("GoRouter 123");
    });

    it("still uniquifies a generated name that already exists", async () => {
      mocks.getProviderConnections.mockResolvedValue([
        { id: "other-1", provider: "gorouter", name: "Account", providerSpecificData: { userId: "999" } },
      ]);
      mocks.list.mockResolvedValue({ ok: true, tokens: [{ id: 7, name: "9router", status: 1 }] });

      await connect();
      expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("Account (2)");
    });

    it("reconnect preserves a user-customized connection name", async () => {
      mocks.getProviderConnections.mockResolvedValue([
        {
          id: "existing-1",
          provider: "gorouter",
          name: "My Custom Name",
          providerSpecificData: { userId: "123" },
        },
      ]);

      const response = await POST(request({
        managementToken: "management-token",
        userId: "123",
        tokenId: 7,
        name: "Account",
        action: "connect",
      }));

      expect(response.status).toBe(200);
      expect(mocks.createProviderConnection).not.toHaveBeenCalled();
      expect(mocks.updateProviderConnection.mock.calls[0][1]).not.toHaveProperty("name");
    });
  });
});
