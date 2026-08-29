import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://example.com";
const PROVIDER_ID = "openai-compatible-chat-example";
const CONNECTION_ID = "conn-1";
const USER_ID = "4242";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  resolveClient: vi.fn(),
  resolveProxy: vi.fn(),
  listNodes: vi.fn(),
  getCheckinStatus: vi.fn(),
  performCheckin: vi.fn(),
  fetchStatus: vi.fn(),
  getSettings: vi.fn(),
}));

const node = {
  id: PROVIDER_ID,
  family: "new-api",
  name: "Example API",
  newApi: { origin: ORIGIN },
};
const connection = {
  id: CONNECTION_ID,
  provider: PROVIDER_ID,
  authType: "apikey",
  accessToken: "management-token-fixture",
  providerSpecificData: {
    userId: USER_ID,
    newApiOrigin: ORIGIN,
    newApiLabel: "Example API",
  },
};
const client = {
  label: "Example API",
  getCheckinStatus: mocks.getCheckinStatus,
  performCheckin: mocks.performCheckin,
  fetchStatus: mocks.fetchStatus,
};

vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getConnection }));
vi.mock("@/sse/services/newapiProvider", () => ({
  resolveNewApiProviderClient: mocks.resolveClient,
  listNewApiProviders: mocks.listNodes,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveProxy }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

const checkinRoute = await import("../../src/app/api/usage/[connectionId]/newapi-checkin/route.js");
const statusRoute = await import("../../src/app/api/new-api/checkin/status/route.js");
const credentialRoute = await import("../../src/app/api/new-api/checkin/credential/route.js");
const completeRoute = await import("../../src/app/api/new-api/checkin/complete/route.js");
const {
  BRIDGE_VERSION,
} = await import("../../src/lib/newapi/pairing.js");
const {
  CHECKIN_PROTOCOL,
  CHECKIN_TTL_MS,
  __getCheckinSessionForTest,
  __resetCheckinSessions,
} = await import("../../src/lib/newapi/checkin.js");

function usageRequest(method = "GET") {
  return new Request(`https://router.example.com/api/usage/${CONNECTION_ID}/newapi-checkin`, {
    method,
    headers: { host: "router.example.com", "x-forwarded-proto": "https" },
  });
}

function context(connectionId = CONNECTION_ID) {
  return { params: Promise.resolve({ connectionId }) };
}

async function startVerification() {
  mocks.performCheckin.mockResolvedValueOnce({ ok: true, status: "verification_required" });
  const response = await checkinRoute.POST(usageRequest("POST"), context());
  return (await response.json()).data.verification;
}

const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

function bridgeRequest(path, verification, overrides = {}, origin = EXTENSION_ORIGIN) {
  return new Request(`https://router.example.com/api/new-api/checkin/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-9Router-Bridge": BRIDGE_VERSION,
      origin,
      host: "router.example.com",
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({
      checkinId: verification.checkinId,
      checkinSecret: verification.checkinSecret,
      providerOrigin: ORIGIN,
      ...overrides,
    }),
  });
}

function credentialRequest(verification, overrides = {}, origin = EXTENSION_ORIGIN) {
  return bridgeRequest("credential", verification, overrides, origin);
}

function completeRequest(verification, overrides = {}, origin = EXTENSION_ORIGIN) {
  return bridgeRequest("complete", verification, overrides, origin);
}

async function leaseCredential(verification, overrides = {}, origin = EXTENSION_ORIGIN) {
  return credentialRoute.POST(credentialRequest(verification, overrides, origin));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  __resetCheckinSessions();
  mocks.getConnection.mockResolvedValue(connection);
  mocks.resolveClient.mockResolvedValue({ client, node });
  mocks.resolveProxy.mockResolvedValue({});
  mocks.listNodes.mockResolvedValue([node]);
  mocks.getSettings.mockResolvedValue({ baseUrl: "https://router.example.com" });
  mocks.fetchStatus.mockResolvedValue({ quota_display_type: "USD", quota_per_unit: 500000 });
  mocks.getCheckinStatus.mockResolvedValue({
    ok: true,
    checkin: {
      supported: true,
      enabled: true,
      checkedInToday: false,
      minQuota: 2500000,
      maxQuota: 5000000,
      checkinCount: 5,
      totalCheckins: 5,
      totalQuota: 17657431,
      records: [],
    },
  });
});

describe("New API connection check-in route", () => {
  it("rejects non-New-API connections and resolves only the persisted target", async () => {
    mocks.getConnection.mockResolvedValueOnce({ ...connection, providerSpecificData: {} });
    expect((await checkinRoute.GET(usageRequest(), context())).status).toBe(404);

    await checkinRoute.GET(usageRequest(), context());
    expect(mocks.resolveClient).toHaveBeenCalledWith(PROVIDER_ID);
    expect(mocks.getCheckinStatus).toHaveBeenCalledWith(
      connection.accessToken,
      USER_ID,
      expect.any(Object),
    );
  });

  it("returns redacted, deployment-formatted status", async () => {
    const response = await checkinRoute.GET(usageRequest(), context());
    const payload = await response.json();
    expect(payload.data).toMatchObject({
      supported: true,
      enabled: true,
      checkedInToday: false,
      minReward: { value: 5, unit: "USD" },
      maxReward: { value: 10, unit: "USD" },
    });
    expect(JSON.stringify(payload)).not.toContain(connection.accessToken);
  });

  it("returns fast-path success and already-checked-in as non-errors", async () => {
    mocks.performCheckin
      .mockResolvedValueOnce({ ok: true, status: "success", checkedInToday: true, quotaAwarded: 500000 })
      .mockResolvedValueOnce({ ok: true, status: "already_checked_in", checkedInToday: true });

    const success = await (await checkinRoute.POST(usageRequest("POST"), context())).json();
    expect(success.data).toMatchObject({ status: "success", quotaAwarded: { value: 1, unit: "USD" } });
    const already = await (await checkinRoute.POST(usageRequest("POST"), context())).json();
    expect(already.data).toMatchObject({ status: "already_checked_in", checkedInToday: true });
  });

  it("creates a hashed v2 session with a non-secret provider launch URL", async () => {
    const verification = await startVerification();
    expect(verification.protocol).toBe("newapi-checkin-v2");
    expect(verification.protocol).toBe(CHECKIN_PROTOCOL);
    expect(verification.providerOrigin).toBe(ORIGIN);
    expect(verification.providerLabel).toBe("Example API");
    expect(verification.launchUrl).toContain(`9router_checkin_protocol=${CHECKIN_PROTOCOL}`);
    expect(verification.launchUrl).toContain(`9router_checkin_id=${verification.checkinId}`);
    expect(verification.launchUrl).toContain("9router_provider_label=Example+API");
    expect(verification.launchUrl).toContain("9router_router_origin=");
    expect(verification.launchUrl).toContain("#");
    expect(verification.launchUrl).not.toContain("?");
    expect(verification.launchUrl).not.toContain(verification.checkinSecret);
    expect(verification.launchUrl).not.toContain(USER_ID);
    expect(verification.launchUrl).not.toContain(connection.accessToken);
    expect(verification.checkinSecret.length).toBeGreaterThanOrEqual(43);
    expect(verification.expiresAt - Date.now()).toBeLessThanOrEqual(CHECKIN_TTL_MS);

    const stored = __getCheckinSessionForTest(verification.checkinId);
    expect(stored).toMatchObject({
      protocol: "newapi-checkin-v2",
      connectionId: CONNECTION_ID,
      providerId: PROVIDER_ID,
      providerOrigin: ORIGIN,
      routerOrigin: "https://router.example.com",
      userId: USER_ID,
      status: "pending",
    });
    expect(stored.checkinSecretHash).toBeInstanceOf(Buffer);
    expect(JSON.stringify(stored)).not.toContain(verification.checkinSecret);
  });
});

describe("newapi-checkin-v2 credential lease", () => {
  it("answers preflight only for a strict Chrome extension origin", async () => {
    const allowed = credentialRoute.OPTIONS(new Request(
      "https://router.example.com/api/new-api/checkin/credential",
      { method: "OPTIONS", headers: { origin: EXTENSION_ORIGIN } },
    ));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(allowed.headers.get("vary")).toBe("Origin");

    const provider = credentialRoute.OPTIONS(new Request(
      "https://router.example.com/api/new-api/checkin/credential",
      { method: "OPTIONS", headers: { origin: ORIGIN } },
    ));
    expect(provider.status).toBe(403);
    expect(provider.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns only the target PAT identity once, with no-store", async () => {
    const verification = await startVerification();
    const response = await leaseCredential(verification);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toEqual({
      success: true,
      data: {
        providerOrigin: ORIGIN,
        userId: USER_ID,
        managementToken: connection.accessToken,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("inference");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(__getCheckinSessionForTest(verification.checkinId).status).toBe("processing");

    const duplicate = await leaseCredential(verification);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).not.toContain(connection.accessToken);
  });

  it("rejects wrong secret, provider web origin and provider retargeting", async () => {
    let verification = await startVerification();
    expect((await leaseCredential(verification, { checkinSecret: "forged" })).status).toBe(403);

    verification = await startVerification();
    expect((await leaseCredential(verification, {}, ORIGIN)).status).toBe(403);

    verification = await startVerification();
    expect((await leaseCredential(verification, { providerOrigin: "https://evil.example" })).status).toBe(403);
    expect(__getCheckinSessionForTest(verification.checkinId).status).toBe("pending");
  });

  it("re-resolves authoritative connection identity before consuming the lease", async () => {
    const verification = await startVerification();
    mocks.getConnection.mockResolvedValueOnce({
      ...connection,
      providerSpecificData: { ...connection.providerSpecificData, userId: "9999" },
    });
    const rejected = await leaseCredential(verification);
    expect(rejected.status).toBe(404);
    expect(await rejected.text()).not.toContain(connection.accessToken);
    expect(__getCheckinSessionForTest(verification.checkinId).status).toBe("pending");
  });

  it("rejects expired and non-v2 sessions", async () => {
    let verification = await startVerification();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + CHECKIN_TTL_MS + 1);
    expect((await leaseCredential(verification)).status).toBe(403);
    vi.useRealTimers();

    verification = await startVerification();
    __getCheckinSessionForTest(verification.checkinId).protocol = "newapi-checkin-v1";
    expect((await leaseCredential(verification)).status).toBe(403);
  });
});

describe("newapi-checkin-v2 completion", () => {
  it("status never returns the secret", async () => {
    const verification = await startVerification();
    const response = await statusRoute.GET(new Request(
      `https://router.example.com/api/new-api/checkin/status?id=${verification.checkinId}`,
    ));
    const body = await response.text();
    expect(body).toContain("pending");
    expect(body).not.toContain(verification.checkinSecret);
  });

  it("independently confirms provider status, rejects retargeting and ignores no client reward", async () => {
    const verification = await startVerification();
    await leaseCredential(verification);
    mocks.getCheckinStatus.mockResolvedValueOnce({
      ok: true,
      checkin: { supported: true, enabled: true, checkedInToday: true, records: [] },
    });
    const response = await completeRoute.POST(completeRequest(verification));
    expect(response.status).toBe(200);
    expect(mocks.getCheckinStatus).toHaveBeenCalled();
    expect((await response.json()).data).toEqual({ status: "success", checkedInToday: true });

    const mismatch = await startVerification();
    await leaseCredential(mismatch);
    const rejected = await completeRoute.POST(completeRequest(mismatch, { providerOrigin: "https://evil.example" }));
    expect(rejected.status).toBe(403);

    const clientData = await startVerification();
    await leaseCredential(clientData);
    for (const extra of [{ quotaAwarded: 999999 }, { checkedInToday: true }, { turnstile: "secret" }]) {
      const invalid = await completeRoute.POST(completeRequest(clientData, extra));
      expect(invalid.status).toBe(400);
    }
  });

  it("rejects Turnstile tokens, expiry and duplicate completion", async () => {
    let verification = await startVerification();
    expect((await completeRoute.POST(completeRequest(verification, { turnstile: "secret" }))).status).toBe(400);

    verification = await startVerification();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + CHECKIN_TTL_MS + 1);
    expect((await completeRoute.POST(completeRequest(verification))).status).toBe(403);
    vi.useRealTimers();

    verification = await startVerification();
    await leaseCredential(verification);
    mocks.getCheckinStatus.mockResolvedValue({
      ok: true,
      checkin: { supported: true, enabled: true, checkedInToday: true, records: [] },
    });
    expect((await completeRoute.POST(completeRequest(verification))).status).toBe(200);
    expect((await completeRoute.POST(completeRequest(verification))).status).toBe(403);
  });

  it("requires a processing lease, then independently confirms provider state", async () => {
    const pending = await startVerification();
    const premature = await completeRoute.POST(completeRequest(pending));
    expect(premature.status).toBe(403);
    expect((await premature.json()).errorCode).toBe("invalid_state");

    const verification = await startVerification();
    await leaseCredential(verification);
    const response = await completeRoute.POST(completeRequest(verification));
    expect(response.status).toBe(409);
    expect((await response.json()).errorCode).toBe("checkin_not_confirmed");
  });
});
