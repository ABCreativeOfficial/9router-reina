import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ account: null }));
vi.mock("@/lib/xingchi/hybridStore.js", () => ({
  getAccount: vi.fn(async () => state.account),
  listAccounts: vi.fn(async () => state.account ? [state.account] : []),
  saveAccount: vi.fn(async (item) => { state.account = item; return item; }),
  sealTokens: vi.fn((_id, value) => value),
  unsealTokens: vi.fn((_id, value) => value),
}));

import { checkinAccount } from "../../src/lib/xingchi/checkin.js";

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

describe("Xingchi Hybrid daily check-in (offline HTTP mocks)", () => {
  beforeEach(() => {
    state.account = { id: "account-1", email: "one@example.com", autoCheckin: false,
      sealed: { accessToken: "access-1", refreshToken: "refresh-1" } };
  });

  it("never calls Xingchi when automatic check-in is disabled", async () => {
    const fetchFn = vi.fn();
    expect(await checkinAccount("account-1", { fetchFn })).toEqual({ skipped: "disabled" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads provider status and avoids duplicate POST when already claimed", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ code: 0, data: {
      claimed_today: true, enabled: true, today: "2026-11-21", next_claim_at: "2026-11-22T00:00:00+08:00",
    } }));
    const result = await checkinAccount("account-1", { manual: true, fetchFn });
    expect(result.status).toBe("already_claimed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1].method).toBe("GET");
  });

  it("performs only one POST and stores next claim time when eligible", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { claimed_today: false, enabled: true } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { amount: 300,
        status: { claimed_today: true, next_claim_at: "2026-11-22T00:00:00+08:00" } } }));
    const result = await checkinAccount("account-1", { manual: true, fetchFn });
    expect(result).toEqual({ status: "success", amount: 300, nextClaimAt: "2026-11-22T00:00:00+08:00" });
    expect(fetchFn.mock.calls.map((c) => c[1].method)).toEqual(["GET", "POST"]);
    expect(state.account.lastReward).toBe(300);
  });

  it("rotates refresh tokens on 401, revalidates account identity, then proceeds", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: "INVALID_TOKEN" }, 401))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { access_token: "access-2", refresh_token: "refresh-2" } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { email: "one@example.com" } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { claimed_today: true, enabled: true, today: "2026-11-21" } }));
    const result = await checkinAccount("account-1", { manual: true, fetchFn });
    expect(result.status).toBe("already_claimed");
    expect(state.account.sealed).toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining("/user/checkin"), expect.stringContaining("/auth/refresh"),
      expect.stringContaining("/auth/me"), expect.stringContaining("/user/checkin"),
    ]);
  });

  it("refuses a refreshed token belonging to another email", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: "INVALID_TOKEN" }, 401))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { access_token: "access-2", refresh_token: "refresh-2" } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { email: "attacker@example.com" } }));
    await expect(checkinAccount("account-1", { manual: true, fetchFn })).rejects.toThrow(/identity differs/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
