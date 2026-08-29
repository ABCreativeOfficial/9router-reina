import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://example.com";
const PROVIDER_ID = "openai-compatible-chat-example";
const CONNECTION_ID = "conn-1";
const TOKEN = "management-token-fixture";
const USER_ID = "4242";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  resolveClient: vi.fn(),
  resolveProxy: vi.fn(),
  getSelf: vi.fn(),
  transfer: vi.fn(),
  fetchStatus: vi.fn(),
}));

const node = { id: PROVIDER_ID, family: "new-api", name: "Example", newApi: { origin: ORIGIN } };
const connection = {
  id: CONNECTION_ID,
  provider: PROVIDER_ID,
  accessToken: TOKEN,
  providerSpecificData: { userId: USER_ID, newApiOrigin: ORIGIN, newApiLabel: "Example" },
};
const client = {
  getSelf: mocks.getSelf,
  transferAffiliateQuota: mocks.transfer,
  fetchStatus: mocks.fetchStatus,
};

vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getConnection }));
vi.mock("@/sse/services/newapiProvider", () => ({ resolveNewApiProviderClient: mocks.resolveClient }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveProxy }));

const service = await import("../../src/lib/newapi/referralService.js");
const route = await import("../../src/app/api/usage/[connectionId]/newapi-referral/route.js");

function self(overrides = {}) {
  return {
    ok: true,
    self: {
      userId: USER_ID,
      referralSupported: true,
      affCode: "abcd",
      affCount: 22,
      affQuota: 160000,
      affHistoryQuota: 440000,
      ...overrides,
    },
  };
}

function request(method = "GET", body) {
  return new Request(`https://router.example.com/api/usage/${CONNECTION_ID}/newapi-referral`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

const context = (connectionId = CONNECTION_ID) => ({ params: Promise.resolve({ connectionId }) });

beforeEach(() => {
  vi.clearAllMocks();
  service.__resetReferralTransfersForTest();
  mocks.getConnection.mockResolvedValue(connection);
  mocks.resolveClient.mockResolvedValue({ client, node });
  mocks.resolveProxy.mockResolvedValue({});
  mocks.getSelf.mockResolvedValue(self());
  mocks.transfer.mockResolvedValue({ ok: true });
  mocks.fetchStatus.mockResolvedValue({ quota_display_type: "USD", quota_per_unit: 1000 });
});

describe("New API referral status", () => {
  it("uses the persisted connection and authoritative provider definition", async () => {
    const result = await service.getNewApiReferralStatus(CONNECTION_ID);
    expect(result.referral).toMatchObject({
      supported: true,
      pendingQuota: 160000,
      totalEarnedQuota: 440000,
      invites: 22,
      affCode: "abcd",
    });
    expect(mocks.resolveClient).toHaveBeenCalledWith(PROVIDER_ID);
    expect(mocks.getSelf).toHaveBeenCalledWith(TOKEN, USER_ID, expect.any(Object));
  });

  it("rejects non-New-API connections", async () => {
    mocks.getConnection.mockResolvedValueOnce({ ...connection, providerSpecificData: {} });
    expect(await service.getNewApiReferralStatus(CONNECTION_ID)).toMatchObject({ ok: false, status: 404 });
    expect(mocks.getSelf).not.toHaveBeenCalled();
  });

  it("returns unsupported only for missing referral shape and preserves real errors", async () => {
    mocks.getSelf.mockResolvedValueOnce(self({ referralSupported: false }));
    expect((await service.getNewApiReferralStatus(CONNECTION_ID)).referral).toEqual({ supported: false });

    mocks.getSelf.mockResolvedValueOnce({ ok: false, status: 401, message: "Authentication failed." });
    expect(await service.getNewApiReferralStatus(CONNECTION_ID)).toMatchObject({ ok: false, status: 401 });
  });

  it("returns a redacted deployment-converted DTO", async () => {
    const response = await route.GET(request(), context());
    const payload = await response.json();
    expect(payload.data).toMatchObject({
      supported: true,
      pendingQuota: 160000,
      totalEarnedQuota: 440000,
      invites: 22,
      pending: { value: 160, unit: "USD" },
      totalEarned: { value: 440, unit: "USD" },
      canTransfer: true,
    });
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
  });
});

describe("New API referral transfer all", () => {
  it("reads fresh pending quota, sends that exact amount once, then refetches", async () => {
    mocks.getSelf
      .mockResolvedValueOnce(self({ affQuota: 175000 }))
      .mockResolvedValueOnce(self({ affQuota: 0 }));

    const result = await service.transferAllNewApiReferral(CONNECTION_ID);
    expect(result).toMatchObject({ transferred: true, transferredQuota: 175000 });
    expect(result.referral.pendingQuota).toBe(0);
    expect(mocks.transfer).toHaveBeenCalledWith(TOKEN, USER_ID, 175000, expect.any(Object));
    expect(mocks.transfer).toHaveBeenCalledTimes(1);
    expect(mocks.getSelf).toHaveBeenCalledTimes(2);
  });

  it("returns nothing_to_transfer without calling upstream mutation", async () => {
    mocks.getSelf.mockResolvedValueOnce(self({ affQuota: 0 }));
    expect(await service.transferAllNewApiReferral(CONNECTION_ID)).toMatchObject({
      ok: true,
      transferred: false,
      reason: "nothing_to_transfer",
    });
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("rejects any browser-selected amount or target field", async () => {
    for (const body of [{ quota: 1 }, { providerOrigin: ORIGIN }, { userId: USER_ID }]) {
      const response = await route.POST(request("POST", body), context());
      expect(response.status).toBe(400);
    }
    expect(mocks.getSelf).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("returns refreshed referral state and converted transferred amount", async () => {
    mocks.getSelf
      .mockResolvedValueOnce(self({ affQuota: 160000 }))
      .mockResolvedValueOnce(self({ affQuota: 0 }));
    const response = await route.POST(request("POST"), context());
    const payload = await response.json();
    expect(payload.data).toMatchObject({
      transferred: true,
      transferredQuota: 160000,
      transferredAmount: { value: 160, unit: "USD" },
      referral: { pendingQuota: 0, canTransfer: false },
    });
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
  });

  it("propagates safe business failure without retrying the transfer", async () => {
    mocks.transfer.mockResolvedValueOnce({ ok: false, status: 422, message: "Payment verification required." });
    const response = await route.POST(request("POST"), context());
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("Payment verification required.");
    expect(mocks.transfer).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent duplicate for one connection while allowing another", async () => {
    let release;
    mocks.getSelf.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(self()); }));
    const first = service.transferAllNewApiReferral(CONNECTION_ID);
    await vi.waitFor(() => expect(mocks.getSelf).toHaveBeenCalledTimes(1));
    expect(await service.transferAllNewApiReferral(CONNECTION_ID)).toMatchObject({
      ok: false,
      status: 409,
      code: "transfer_in_progress",
    });

    const other = { ...connection, id: "conn-2" };
    mocks.getConnection.mockImplementation((id) => Promise.resolve(id === "conn-2" ? other : connection));
    mocks.getSelf.mockResolvedValue(self({ affQuota: 0 }));
    expect(await service.transferAllNewApiReferral("conn-2")).toMatchObject({ ok: true });
    release();
    await first;
  });
});
