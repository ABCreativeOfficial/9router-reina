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

function completeRequest(verification, overrides = {}) {
  return new Request("https://router.example.com/api/new-api/checkin/complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-9Router-Bridge": BRIDGE_VERSION,
      origin: ORIGIN,
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

  it("creates a hashed, short-lived newapi-checkin-v1 session from persisted state", async () => {
    const verification = await startVerification();
    expect(verification.protocol).toBe(CHECKIN_PROTOCOL);
    expect(verification.providerOrigin).toBe(ORIGIN);
    expect(verification.providerLabel).toBe("Example API");
    expect(verification.loginUrl).toContain(`9router_checkin_protocol=${CHECKIN_PROTOCOL}`);
    expect(verification.loginUrl).toContain("#");
    expect(verification.loginUrl).not.toContain("?");
    expect(verification.checkinSecret.length).toBeGreaterThanOrEqual(43);
    expect(verification.expiresAt - Date.now()).toBeLessThanOrEqual(CHECKIN_TTL_MS);

    const stored = __getCheckinSessionForTest(verification.checkinId);
    expect(stored.checkinSecretHash).toBeInstanceOf(Buffer);
    expect(JSON.stringify(stored)).not.toContain(verification.checkinSecret);
  });
});

describe("newapi-checkin-v1 completion", () => {
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
    mocks.getCheckinStatus.mockResolvedValueOnce({
      ok: true,
      checkin: { supported: true, enabled: true, checkedInToday: true, records: [] },
    });
    const response = await completeRoute.POST(completeRequest(verification, { quotaAwarded: 999999 }));
    expect(response.status).toBe(200);
    expect(mocks.getCheckinStatus).toHaveBeenCalled();
    expect((await response.json()).data).toEqual({ status: "success", checkedInToday: true });

    const mismatch = await startVerification();
    const rejected = await completeRoute.POST(completeRequest(mismatch, { providerOrigin: "https://evil.example" }));
    expect(rejected.status).toBe(403);
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
    mocks.getCheckinStatus.mockResolvedValue({
      ok: true,
      checkin: { supported: true, enabled: true, checkedInToday: true, records: [] },
    });
    expect((await completeRoute.POST(completeRequest(verification))).status).toBe(200);
    expect((await completeRoute.POST(completeRequest(verification))).status).toBe(403);
  });

  it("fails when the extension claim is not confirmed by provider state", async () => {
    const verification = await startVerification();
    const response = await completeRoute.POST(completeRequest(verification));
    expect(response.status).toBe(409);
    expect((await response.json()).errorCode).toBe("checkin_not_confirmed");
  });
});
