import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProviderConnection: vi.fn(),
  validate: vi.fn(),
  list: vi.fn(),
  retrieve: vi.fn(),
  validateInference: vi.fn(),
  models: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
}));

vi.mock("open-sse/services/gorouter.js", () => ({
  validateGoRouterManagementCredentials: mocks.validate,
  listGoRouterTokens: mocks.list,
  retrieveGoRouterTokenKey: mocks.retrieve,
  validateGoRouterInferenceKey: mocks.validateInference,
  fetchGoRouterModels: mocks.models,
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
    mocks.validate.mockResolvedValue({ ok: true, account: { id: "123", displayName: "Account", group: "default", status: 1 } });
    mocks.list.mockResolvedValue({ ok: true, tokens: [{ id: 7, name: "Reusable", maskedKey: "abcd**********wxyz", status: 1 }] });
    mocks.retrieve.mockResolvedValue({ ok: true, apiKey: "full-inference-key" });
    mocks.validateInference.mockResolvedValue({ ok: true });
    mocks.models.mockResolvedValue({ ok: true, models: [{ id: "model-a", name: "model-a" }] });
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
    expect(response.status).toBe(400);
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
});
