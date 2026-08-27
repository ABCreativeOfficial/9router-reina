import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProviderConnection: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { TABITOKEN_ORIGIN, tabitokenClient } from "../../open-sse/services/tabitoken.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_APIKEY_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { POST } from "../../src/app/api/providers/tabitoken/bootstrap/route.js";

const MANAGEMENT_TOKEN = "management-token-fixture";
const USER_ID = "8080";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function request(body) {
  return new Request("http://localhost/api/providers/tabitoken/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ACCOUNT = {
  id: Number(USER_ID),
  status: 1,
  display_name: "Tabi Account",
  username: "tabi-login",
  group: "default",
  quota: 300000,
  used_quota: 200000,
  request_count: 12,
};

/** Queue the management calls one full onboarding makes, in order. */
function queueConnectFlow({ account = ACCOUNT, tokens, models = ["model-a"] } = {}) {
  const tokenList = tokens || [{ id: 5, name: "9router", key: "abcd**********wxyz", status: 1 }];
  mocks.proxyAwareFetch
    .mockResolvedValueOnce(jsonResponse({ success: true, data: account }))            // /api/user/self
    .mockResolvedValueOnce(jsonResponse({ success: true, data: { items: tokenList } })) // /api/token/
    .mockResolvedValueOnce(jsonResponse({ success: true, data: "full-inference-key" })) // /api/token/{id}/key
    .mockResolvedValueOnce(jsonResponse({ success: true, data: models }))              // /api/user/models
    .mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));                // /v1/models
}

describe("TabiToken registry and inference", () => {
  const entry = REGISTRY.find((provider) => provider.id === "tabitoken");

  it("registers as a native OpenAI-compatible apikey provider with a unique alias", () => {
    expect(entry).toMatchObject({
      id: "tabitoken",
      alias: "tbt",
      category: "apikey",
      passthroughModels: true,
      features: { usage: true, usageApikey: true },
    });

    const aliasTokens = REGISTRY.flatMap((provider) => [
      provider.alias,
      provider.uiAlias,
      ...(provider.aliases || []),
    ].filter(Boolean));
    expect(aliasTokens.filter((token) => token === "tbt")).toHaveLength(1);
    expect(new Set(REGISTRY.map((provider) => provider.id)).size).toBe(REGISTRY.length);
  });

  it("routes inference through the shared OpenAI transport using apiKey only", () => {
    expect(PROVIDERS.tabitoken).toMatchObject({
      format: "openai",
      baseUrl: `${TABITOKEN_ORIGIN}/v1/chat/completions`,
    });

    // No TabiToken-specific executor: the default one must pick apiKey over the
    // management token, or inference would authenticate with the wrong credential.
    const headers = new DefaultExecutor("tabitoken").buildHeaders({
      apiKey: "inference-key",
      accessToken: MANAGEMENT_TOKEN,
    });
    expect(headers.Authorization).toBe("Bearer inference-key");
    expect(headers.Authorization).not.toContain(MANAGEMENT_TOKEN);
  });

  it("is eligible for the existing API-key quota tracker", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("tabitoken");
    expect(USAGE_APIKEY_PROVIDERS).toContain("tabitoken");
  });
});

describe("TabiToken management surface", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives every endpoint from the trusted server-side origin", () => {
    expect(tabitokenClient.origin).toBe(TABITOKEN_ORIGIN);
    expect(tabitokenClient.endpoints).toMatchObject({
      account: `${TABITOKEN_ORIGIN}/api/user/self`,
      models: `${TABITOKEN_ORIGIN}/api/user/models`,
      tokens: `${TABITOKEN_ORIGIN}/api/token/`,
      status: `${TABITOKEN_ORIGIN}/api/status`,
      inferenceModels: `${TABITOKEN_ORIGIN}/v1/models`,
    });
  });

  it("sends the New API management headers", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: ACCOUNT }));
    const result = await tabitokenClient.getAccount(MANAGEMENT_TOKEN, USER_ID);

    expect(result.ok).toBe(true);
    expect(result.account).toMatchObject({ id: USER_ID, displayName: "Tabi Account", username: "tabi-login" });
    const [url, options] = mocks.proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${TABITOKEN_ORIGIN}/api/user/self`);
    expect(options.headers.Authorization).toBe(`Bearer ${MANAGEMENT_TOKEN}`);
    expect(options.headers["New-Api-User"]).toBe(USER_ID);
  });

  it("parses the dynamic model list without hardcoding ids", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: ["model-a", " model-b ", "model-a", ""],
    }));

    const result = await tabitokenClient.fetchModels(MANAGEMENT_TOKEN, USER_ID);
    expect(result.models).toEqual([
      { id: "model-a", name: "model-a" },
      { id: "model-b", name: "model-b" },
    ]);
    // The registry ships no models, so the catalog can only come from upstream.
    expect(REGISTRY.find((p) => p.id === "tabitoken").models).toEqual([]);
  });

  it("never accepts a masked key as an inference credential", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: "abcd**********wxyz" }));
    const result = await tabitokenClient.retrieveTokenKey(MANAGEMENT_TOKEN, USER_ID, 5);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("apiKey");
  });
});

describe("TabiToken quota", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes through the shared New API usage core and the standard dispatcher", async () => {
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ACCOUNT }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { quota_display_type: "USD", quota_per_unit: 500000 },
      }));

    const usage = await getUsageForProvider({
      provider: "tabitoken",
      apiKey: "inference-key",
      accessToken: MANAGEMENT_TOKEN,
      providerSpecificData: { userId: USER_ID },
    });

    expect(usage).toMatchObject({ plan: "default", status: 1, requestCount: 12 });
    expect(usage.quotas["Account Quota (USD)"]).toMatchObject({
      used: 0.4,
      total: 1,
      remainingPercentage: 60,
    });
    // Quota reads use the management token; the inference key must not appear.
    expect(mocks.proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${MANAGEMENT_TOKEN}`);
    expect(JSON.stringify(usage)).not.toContain("inference-key");

    // The generic Quota Tracker parser handles it; no provider-specific UI case.
    expect(parseQuotaData("tabitoken", usage)[0]).toMatchObject({ used: 0.4, total: 1 });
  });
});

describe("TabiToken onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.createProviderConnection.mockImplementation(async (data) => ({ id: "connection-1", ...data }));
    mocks.updateProviderConnection.mockImplementation(async (id, data) => ({ id, provider: "tabitoken", ...data }));
  });

  it("returns masked metadata only when inspecting", async () => {
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ACCOUNT }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { items: [{ id: 5, name: "9router", key: "abcd**********wxyz", status: 1 }] },
      }));

    const response = await POST(request({ managementToken: MANAGEMENT_TOKEN, userId: USER_ID, action: "inspect" }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.state).toBe("ready");
    expect(data.tokens[0]).toMatchObject({ id: 5, maskedKey: "abcd**********wxyz" });
    expect(JSON.stringify(data)).not.toContain(MANAGEMENT_TOKEN);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("persists the credential split and names a new account from its identity", async () => {
    queueConnectFlow();

    const response = await POST(request({
      managementToken: MANAGEMENT_TOKEN,
      userId: USER_ID,
      tokenId: 5,
      action: "connect",
    }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "tabitoken",
      authType: "apikey",
      // Account identity, never the "9router" token name.
      name: "Tabi Account",
      apiKey: "full-inference-key",
      accessToken: MANAGEMENT_TOKEN,
      providerSpecificData: { userId: USER_ID },
    }));
    expect(JSON.stringify(data)).not.toContain(MANAGEMENT_TOKEN);
    expect(JSON.stringify(data)).not.toContain("full-inference-key");
  });

  it("falls back to username then TabiToken <userId> for a new account name", async () => {
    queueConnectFlow({ account: { ...ACCOUNT, display_name: "" } });
    await POST(request({ managementToken: MANAGEMENT_TOKEN, userId: USER_ID, tokenId: 5, action: "connect" }));
    expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe("tabi-login");

    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.createProviderConnection.mockImplementation(async (data) => ({ id: "connection-2", ...data }));
    queueConnectFlow({ account: { ...ACCOUNT, display_name: "", username: "" } });
    await POST(request({ managementToken: MANAGEMENT_TOKEN, userId: USER_ID, tokenId: 5, action: "connect" }));
    expect(mocks.createProviderConnection.mock.calls[0][0].name).toBe(`TabiToken ${USER_ID}`);
  });

  it("reconnects in place, preserving the custom name and enabledModels", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "existing-1",
        provider: "tabitoken",
        name: "My Custom Name",
        providerSpecificData: { userId: USER_ID, enabledModels: ["model-a"] },
      },
    ]);
    queueConnectFlow();

    const response = await POST(request({
      managementToken: MANAGEMENT_TOKEN,
      userId: USER_ID,
      tokenId: 5,
      name: "Ignored",
      action: "connect",
    }));

    expect(response.status).toBe(200);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
    const [id, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(id).toBe("existing-1");
    expect(update).not.toHaveProperty("name");
    expect(update.providerSpecificData).toEqual({ userId: USER_ID, enabledModels: ["model-a"] });
  });

  it("rejects a mismatched account before touching credentials", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { ...ACCOUNT, id: 9999 },
    }));

    const response = await POST(request({ managementToken: MANAGEMENT_TOKEN, userId: USER_ID, action: "inspect" }));
    expect(response.status).toBe(403);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("requires explicit token creation instead of creating one silently", async () => {
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ACCOUNT }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { items: [{ id: 5, status: 0 }] } }));

    const response = await POST(request({
      managementToken: MANAGEMENT_TOKEN,
      userId: USER_ID,
      tokenId: 5,
      action: "connect",
    }));

    expect(response.status).toBe(409);
    expect((await response.json()).state).toBe("needs_token_creation");
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("surfaces an invalid management credential without echoing it", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    const response = await POST(request({ managementToken: MANAGEMENT_TOKEN, userId: USER_ID }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toMatch(/authentication failed/i);
    expect(JSON.stringify(data)).not.toContain(MANAGEMENT_TOKEN);
  });
});
