import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  GOROUTER_ENDPOINTS,
  fetchGoRouterModels,
  isMaskedGoRouterKey,
  listGoRouterTokens,
  retrieveGoRouterTokenKey,
  validateGoRouterInferenceKey,
  validateGoRouterManagementCredentials,
} from "../../open-sse/services/gorouter.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { convertGoRouterQuota } from "../../open-sse/services/usage/gorouter.js";
import {
  USAGE_APIKEY_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GoRouter registry and inference", () => {
  const entry = REGISTRY.find((provider) => provider.id === "gorouter");

  it("registers one unique native alias", () => {
    expect(entry).toMatchObject({
      id: "gorouter",
      alias: "gor",
      category: "apikey",
      passthroughModels: true,
      features: { usage: true, usageApikey: true },
    });
    expect(entry.alias).not.toBe("gr");
    expect(REGISTRY.filter((provider) => provider.alias === "gor")).toHaveLength(1);
    expect(new Set(REGISTRY.map((provider) => provider.id)).size).toBe(REGISTRY.length);
  });

  it("uses the OpenAI-compatible runtime and apiKey for inference", () => {
    expect(PROVIDERS.gorouter).toMatchObject({
      format: "openai",
      baseUrl: "https://gorouter.app/v1/chat/completions",
    });
    const executor = new DefaultExecutor("gorouter");
    const headers = executor.buildHeaders({
      apiKey: "inference-key",
      accessToken: "management-token",
    });
    expect(headers.Authorization).toBe("Bearer inference-key");
    expect(headers.Authorization).not.toContain("management-token");
  });

  it("is eligible for the existing API-key quota tracker", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("gorouter");
    expect(USAGE_APIKEY_PROVIDERS).toContain("gorouter");
  });
});

describe("GoRouter management client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates account identity and sends management headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { id: 123, status: 1, display_name: "Account", group: "default", quota: 5, used_quota: 2, request_count: 3 },
    }));

    const result = await validateGoRouterManagementCredentials("management-token", "123");
    expect(result.ok).toBe(true);
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(GOROUTER_ENDPOINTS.account);
    expect(options.headers.Authorization).toBe("Bearer management-token");
    expect(options.headers["New-Api-User"]).toBe("123");
  });

  it("rejects wrong user, disabled account, unsuccessful and malformed responses", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 999, status: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 123, status: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ success: false, message: "no" }, 401))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: null }));

    expect((await validateGoRouterManagementCredentials("token", "123")).message).toMatch(/does not match/i);
    expect((await validateGoRouterManagementCredentials("token", "123")).message).toMatch(/disabled/i);
    expect((await validateGoRouterManagementCredentials("token", "123")).message).toMatch(/authentication/i);
    expect((await validateGoRouterManagementCredentials("token", "123")).message).toMatch(/invalid account/i);
  });

  it("returns safe token metadata and never treats a mask as a key", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { items: [{ id: 7, name: "Reusable", key: "abcd**********wxyz", status: 1, group: "default", unlimited_quota: true }] },
    }));
    const listed = await listGoRouterTokens("management-token", "123");
    expect(listed.tokens[0]).toMatchObject({ id: 7, name: "Reusable", maskedKey: "abcd**********wxyz" });
    expect(isMaskedGoRouterKey(listed.tokens[0].maskedKey)).toBe(true);

    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: "abcd**********wxyz" }));
    const retrieved = await retrieveGoRouterTokenKey("management-token", "123", 7);
    expect(retrieved.ok).toBe(false);
    expect(retrieved).not.toHaveProperty("apiKey");
  });

  it("retrieves the full selected key server-side", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: "full-inference-key" }));
    const result = await retrieveGoRouterTokenKey("management-token", "123", 7);
    expect(result).toEqual({ ok: true, apiKey: "full-inference-key" });
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${GOROUTER_ENDPOINTS.tokens}7/key`);
    expect(options.method).toBe("POST");
  });

  it("validates the retrieved key against the inference API", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));
    const result = await validateGoRouterInferenceKey("full-inference-key");
    expect(result.ok).toBe(true);
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://gorouter.app/v1/models");
    expect(options.headers.Authorization).toBe("Bearer full-inference-key");
  });

  it("parses dynamic model IDs without a hardcoded catalog", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: ["model-a", " model-b ", "model-a", ""],
    }));
    const result = await fetchGoRouterModels("management-token", "123");
    expect(result.models).toEqual([
      { id: "model-a", name: "model-a" },
      { id: "model-b", name: "model-b" },
    ]);
  });
});

describe("GoRouter quota", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses deployment quota_per_unit instead of a magic divisor", () => {
    expect(convertGoRouterQuota(250000, { quota_display_type: "USD", quota_per_unit: 500000 })).toEqual({ value: 0.5, unit: "USD" });
    expect(convertGoRouterQuota(250000, { quota_display_type: "USD", quota_per_unit: 250000 })).toEqual({ value: 1, unit: "USD" });
    expect(convertGoRouterQuota(10, { quota_display_type: "USD", quota_per_unit: 0 })).toBeNull();
  });

  it("normalizes remaining, used, total, percentage, request count and status", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 123, status: 1, group: "default", quota: 300000, used_quota: 200000, request_count: 9 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { quota_display_type: "USD", quota_per_unit: 500000 } }));

    const usage = await getUsageForProvider({
      provider: "gorouter",
      apiKey: "inference-key",
      accessToken: "management-token",
      providerSpecificData: { userId: "123" },
    });
    expect(usage).toMatchObject({ plan: "default", status: 1, requestCount: 9 });
    expect(usage.quotas["Account Quota (USD)"]).toMatchObject({
      used: 0.4,
      total: 1,
      remainingPercentage: 60,
    });
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer management-token");
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).not.toContain("inference-key");

    const rows = parseQuotaData("gorouter", usage);
    expect(rows[0]).toMatchObject({ used: 0.4, total: 1 });
  });
});
