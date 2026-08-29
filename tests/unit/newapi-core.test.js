import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  NEW_API_DEFAULT_PATHS,
  createNewApiClient,
  isMaskedNewApiKey,
  normalizeNewApiUserId,
} from "../../open-sse/services/newapi/client.js";
import { convertNewApiQuota, getNewApiUsage } from "../../open-sse/services/newapi/usage.js";

const ORIGIN = "https://newapi.example";
const TOKEN = "management-token-fixture";
const USER_ID = "4242";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(overrides = {}) {
  return createNewApiClient({ origin: ORIGIN, label: "Example", ...overrides });
}

describe("New API client configuration", () => {
  it("derives endpoints from the trusted origin and rejects an untrusted one", () => {
    const api = client();
    expect(api.endpoints.account).toBe(`${ORIGIN}${NEW_API_DEFAULT_PATHS.account}`);
    expect(api.endpoints.inferenceModels).toBe(`${ORIGIN}/v1/models`);
    expect(api.origin).toBe(ORIGIN);

    // A browser-supplied value can never become the management target.
    for (const bad of ["http://newapi.example", "https://a.example/api", "not-a-url", ""]) {
      expect(() => createNewApiClient({ origin: bad, label: "Bad" })).toThrow(/https origin/);
    }
  });

  it("lets a deployment override endpoint paths", () => {
    const api = client({ paths: { account: "/api/v2/self" } });
    expect(api.endpoints.account).toBe(`${ORIGIN}/api/v2/self`);
    // Unspecified paths keep the New API defaults.
    expect(api.endpoints.tokens).toBe(`${ORIGIN}${NEW_API_DEFAULT_PATHS.tokens}`);
  });

  it("normalizes user ids and recognizes masked keys", () => {
    expect(normalizeNewApiUserId(" 42 ")).toBe("42");
    expect(normalizeNewApiUserId(42)).toBe("42");
    expect(normalizeNewApiUserId("abc")).toBe("");
    expect(normalizeNewApiUserId(null)).toBe("");
    expect(isMaskedNewApiKey("abcd**********wxyz")).toBe(true);
    expect(isMaskedNewApiKey("full-key")).toBe(false);
  });
});

describe("New API management requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the New API management headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { id: 4242, status: 1, display_name: "Account", username: "login", group: "default" },
    }));

    const result = await client().getAccount(TOKEN, USER_ID);
    expect(result.ok).toBe(true);
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/user/self`);
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(options.headers["New-Api-User"]).toBe(USER_ID);
    expect(options.redirect).toBe("error");
  });

  it("refuses to call upstream without both credentials", async () => {
    const api = client();
    expect((await api.getAccount("", USER_ID)).status).toBe(400);
    expect((await api.getAccount(TOKEN, "not-numeric")).status).toBe(400);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("labels errors with the deployment name and never echoes the token", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    const result = await client().getAccount(TOKEN, USER_ID);
    expect(result.message).toBe("Example management authentication failed.");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("rejects an account id that disagrees with the requested id", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 9999, status: 1 } }));
    const result = await client().getAccount(TOKEN, USER_ID);
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result.message).toMatch(/does not match/i);
  });

  it("honors a deployment-specific active status value", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 4242, status: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 4242, status: 7 } }));

    const api = client({ activeStatus: 7 });
    expect((await api.getAccount(TOKEN, USER_ID)).ok).toBe(false);
    expect((await api.getAccount(TOKEN, USER_ID)).ok).toBe(true);
  });

  it("accepts a deployment account parser", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { id: 4242, status: 1, nickname: "Custom" },
    }));

    const api = client({ parseAccount: (raw, id) => ({ id, displayName: raw.nickname }) });
    expect((await api.getAccount(TOKEN, USER_ID)).account).toEqual({ id: USER_ID, displayName: "Custom" });
  });
});

describe("New API token handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns masked metadata only from the token list", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        items: [
          { id: 7, name: "reusable", key: "abcd**********wxyz", status: 1, group: "default", unlimited_quota: true },
          { id: 0, name: "invalid" },
        ],
      },
    }));

    const result = await client().listTokens(TOKEN, USER_ID);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).toMatchObject({ id: 7, name: "reusable", maskedKey: "abcd**********wxyz" });
    expect(proxyAwareFetch.mock.calls[0][0]).toBe(`${ORIGIN}/api/token/?p=1&size=100`);
  });

  it("retrieves a full key by POST and refuses a masked one", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: "full-inference-key" }));
    const ok = await client().retrieveTokenKey(TOKEN, USER_ID, 7);
    expect(ok).toEqual({ ok: true, apiKey: "full-inference-key" });
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/token/7/key`);
    expect(options.method).toBe("POST");

    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: "abcd**********wxyz" }));
    const masked = await client().retrieveTokenKey(TOKEN, USER_ID, 7);
    expect(masked.ok).toBe(false);
    expect(masked).not.toHaveProperty("apiKey");
  });

  it("rejects an invalid token id without a request", async () => {
    expect((await client().retrieveTokenKey(TOKEN, USER_ID, 0)).status).toBe(400);
    expect((await client().retrieveTokenKey(TOKEN, USER_ID, "abc")).status).toBe(400);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("validates a retrieved key against the inference surface, not the management one", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));
    const result = await client().validateInferenceKey("full-inference-key");
    expect(result.ok).toBe(true);
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/v1/models`);
    expect(options.headers.Authorization).toBe("Bearer full-inference-key");
    expect(options.headers["New-Api-User"]).toBeUndefined();
  });
});

describe("New API model discovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses, trims and dedupes the default string-array shape", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: ["model-a", " model-b ", "model-a", "", 42],
    }));

    const result = await client().fetchModels(TOKEN, USER_ID);
    expect(result.models).toEqual([
      { id: "model-a", name: "model-a" },
      { id: "model-b", name: "model-b" },
    ]);
  });

  it("reports an unexpected payload instead of inventing models", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { models: [] } }));
    const result = await client().fetchModels(TOKEN, USER_ID);
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(result.message).toMatch(/invalid model list/i);
  });

  it("accepts a deployment model parser for a fork with a different shape", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { data: [{ id: "obj-model" }] },
    }));

    const api = client({
      parseModels: (data) => (Array.isArray(data?.data) ? data.data.map((m) => ({ id: m.id, name: m.id })) : null),
    });
    expect((await api.fetchModels(TOKEN, USER_ID)).models).toEqual([{ id: "obj-model", name: "obj-model" }]);
  });
});

describe("New API daily check-in", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes a successful status response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        enabled: true,
        min_quota: 2500000,
        max_quota: 5000000,
        stats: {
          checked_in_today: false,
          checkin_count: 5,
          total_checkins: 5,
          total_quota: 17657431,
          records: [{ checkin_date: "2026-08-28", quota_awarded: 3035199 }],
        },
      },
    }));

    const result = await client().getCheckinStatus(TOKEN, USER_ID);
    expect(result).toMatchObject({
      ok: true,
      checkin: {
        supported: true,
        enabled: true,
        checkedInToday: false,
        minQuota: 2500000,
        maxQuota: 5000000,
        checkinCount: 5,
        records: [{ checkinDate: "2026-08-28", quotaAwarded: 3035199 }],
      },
    });
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toMatch(`${ORIGIN}/api/user/checkin?month=`);
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(options.headers["New-Api-User"]).toBe(USER_ID);
  });

  it("keeps enabled false supported and treats only 404 as unsupported", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { enabled: false, stats: {} } }))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 404))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 401));

    expect((await client().getCheckinStatus(TOKEN, USER_ID)).checkin)
      .toMatchObject({ supported: true, enabled: false });
    expect((await client().getCheckinStatus(TOKEN, USER_ID)).checkin)
      .toEqual({ supported: false });
    const auth = await client().getCheckinStatus(TOKEN, USER_ID);
    expect(auth).toMatchObject({ ok: false, status: 401 });
  });

  it("normalizes success, already checked in and Turnstile verification", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { quota_awarded: 3203479 } }))
      .mockResolvedValueOnce(jsonResponse({ success: false, message: "Already checked in today" }))
      .mockResolvedValueOnce(jsonResponse({ success: false, message: "Turnstile verification required" }));

    expect(await client().performCheckin(TOKEN, USER_ID)).toMatchObject({
      ok: true,
      status: "success",
      checkedInToday: true,
      quotaAwarded: 3203479,
    });
    expect(await client().performCheckin(TOKEN, USER_ID)).toMatchObject({
      ok: true,
      status: "already_checked_in",
      checkedInToday: true,
    });
    expect(await client().performCheckin(TOKEN, USER_ID)).toMatchObject({
      ok: true,
      status: "verification_required",
      checkedInToday: false,
    });
    expect(proxyAwareFetch.mock.calls[0][0]).toBe(`${ORIGIN}/api/user/checkin`);
    expect(proxyAwareFetch.mock.calls[0][1].method).toBe("POST");
  });
});

describe("New API status and quota conversion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads public status without management headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { quota_display_type: "USD", quota_per_unit: 500000 },
    }));

    const status = await client().fetchStatus();
    expect(status).toMatchObject({ quota_per_unit: 500000 });
    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/status`);
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("returns null when status is unusable, so callers stay honest", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: false }, 500));
    expect(await client().fetchStatus()).toBeNull();
  });

  it("converts by the deployment's quota_per_unit rather than a magic divisor", () => {
    expect(convertNewApiQuota(250000, { quota_display_type: "USD", quota_per_unit: 500000 }))
      .toEqual({ value: 0.5, unit: "USD" });
    expect(convertNewApiQuota(250000, { quota_display_type: "USD", quota_per_unit: 250000 }))
      .toEqual({ value: 1, unit: "USD" });
  });

  it("applies CNY and CUSTOM display modes and refuses an unusable config", () => {
    expect(convertNewApiQuota(500000, { quota_display_type: "CNY", quota_per_unit: 500000, usd_exchange_rate: 7 }))
      .toEqual({ value: 7, unit: "CNY" });
    expect(convertNewApiQuota(500000, {
      quota_display_type: "CUSTOM",
      quota_per_unit: 500000,
      custom_currency_exchange_rate: 3,
      custom_currency_symbol: "¤",
    })).toEqual({ value: 3, unit: "¤" });

    expect(convertNewApiQuota(500000, { quota_display_type: "TOKENS" })).toEqual({ value: 500000, unit: "quota units" });
    expect(convertNewApiQuota(10, { quota_display_type: "USD", quota_per_unit: 0 })).toBeNull();
    expect(convertNewApiQuota(10, null)).toBeNull();
    expect(convertNewApiQuota(-1, { quota_display_type: "USD", quota_per_unit: 500000 })).toBeNull();
    expect(convertNewApiQuota(500000, { quota_display_type: "CNY", quota_per_unit: 500000 })).toBeNull();
  });
});

describe("New API usage payload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives total from remaining plus lifetime used, with a remaining-based percentage", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 4242, status: 1, group: "default", quota: 300000, used_quota: 200000, request_count: 9 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { quota_display_type: "USD", quota_per_unit: 500000 },
      }));

    const usage = await getNewApiUsage(client(), TOKEN, { userId: USER_ID });
    expect(usage).toMatchObject({ plan: "default", status: 1, requestCount: 9 });
    expect(usage.quotas["Account Quota (USD)"]).toMatchObject({
      used: 0.4,
      total: 1,
      remainingPercentage: 60,
      resetAt: null,
    });
    expect(JSON.stringify(usage)).not.toContain(TOKEN);
  });

  it("uses a caller-supplied quota row label", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 4242, status: 1, quota: 500000, used_quota: 0 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { quota_display_type: "USD", quota_per_unit: 500000 },
      }));

    const usage = await getNewApiUsage(client(), TOKEN, { userId: USER_ID }, null, "Balance");
    expect(Object.keys(usage.quotas)).toEqual(["Balance (USD)"]);
  });

  it("reports a message instead of a misleading number when conversion is impossible", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 4242, status: 1, group: "vip", quota: 300000, used_quota: 200000 },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 500));

    const usage = await getNewApiUsage(client(), TOKEN, { userId: USER_ID });
    expect(usage.quotas).toBeUndefined();
    expect(usage).toMatchObject({ plan: "vip" });
    expect(usage.message).toMatch(/conversion is unavailable/i);
  });

  it("surfaces a management failure as a message", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    const usage = await getNewApiUsage(client(), TOKEN, { userId: USER_ID });
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toMatch(/authentication failed/i);
  });
});
