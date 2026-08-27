import { describe, expect, it } from "vitest";
import {
  buildAutoTokenName,
  isUsableNewApiToken,
  sortNewApiTokenCandidates,
} from "../../open-sse/services/newapi/tokenPolicy.js";

const NOW = 1_800_000_000; // unix seconds

/** Minimal token metadata, shaped like client.listTokens() returns. */
function token(overrides = {}) {
  return {
    id: 1,
    name: "Token 1",
    maskedKey: "abcd**********wxyz",
    status: 1,
    group: "",
    unlimitedQuota: true,
    modelLimitsEnabled: false,
    remainQuota: null,
    usedQuota: null,
    expiredTime: -1,
    accessedTime: null,
    createdTime: null,
    ...overrides,
  };
}

const usable = (t) => isUsableNewApiToken(t, { now: NOW });

describe("New API token usability", () => {
  it("accepts an enabled, non-expiring, unlimited token", () => {
    expect(usable(token())).toBe(true);
  });

  it("excludes a token that is not enabled", () => {
    for (const status of [0, 2, 3, 4]) {
      expect(usable(token({ status })), `status ${status}`).toBe(false);
    }
  });

  it("honors a deployment's own active status value", () => {
    expect(isUsableNewApiToken(token({ status: 7 }), { activeStatus: 7, now: NOW })).toBe(true);
    expect(isUsableNewApiToken(token({ status: 1 }), { activeStatus: 7, now: NOW })).toBe(false);
  });

  it("excludes an active token whose expiry has lapsed", () => {
    expect(usable(token({ expiredTime: NOW - 1 }))).toBe(false);
    expect(usable(token({ expiredTime: NOW + 3600 }))).toBe(true);
  });

  it("treats -1 and a missing expiry as never expiring", () => {
    expect(usable(token({ expiredTime: -1 }))).toBe(true);
    expect(usable(token({ expiredTime: null }))).toBe(true);
    expect(usable(token({ expiredTime: undefined }))).toBe(true);
  });

  it("excludes an exhausted finite balance but not an unlimited one", () => {
    expect(usable(token({ unlimitedQuota: false, remainQuota: 0 }))).toBe(false);
    expect(usable(token({ unlimitedQuota: false, remainQuota: -5 }))).toBe(false);
    expect(usable(token({ unlimitedQuota: false, remainQuota: 100 }))).toBe(true);
    // Unlimited: remain_quota is meaningless upstream, so it must not disqualify.
    expect(usable(token({ unlimitedQuota: true, remainQuota: 0 }))).toBe(true);
  });

  it("does not exclude a token merely because it has model limits", () => {
    // A restricted token is still a valid credential; 9Router has its own
    // per-account model policy.
    expect(usable(token({ modelLimitsEnabled: true }))).toBe(true);
  });

  it("keeps a token whose finite balance is unknown rather than guessing", () => {
    expect(usable(token({ unlimitedQuota: false, remainQuota: null }))).toBe(true);
  });
});

describe("New API token candidate ordering", () => {
  it("prefers the most recently accessed token", () => {
    const ids = sortNewApiTokenCandidates([
      token({ id: 1, accessedTime: 100 }),
      token({ id: 2, accessedTime: 300 }),
      token({ id: 3, accessedTime: 200 }),
    ], { now: NOW }).map((t) => t.id);
    expect(ids).toEqual([2, 3, 1]);
  });

  it("falls back to created_time when access times tie", () => {
    const ids = sortNewApiTokenCandidates([
      token({ id: 1, accessedTime: 100, createdTime: 10 }),
      token({ id: 2, accessedTime: 100, createdTime: 50 }),
    ], { now: NOW }).map((t) => t.id);
    expect(ids).toEqual([2, 1]);
  });

  it("falls back to id when both timestamps tie", () => {
    const ids = sortNewApiTokenCandidates([
      token({ id: 5, accessedTime: 100, createdTime: 10 }),
      token({ id: 9, accessedTime: 100, createdTime: 10 }),
    ], { now: NOW }).map((t) => t.id);
    expect(ids).toEqual([9, 5]);
  });

  it("sorts a missing timestamp last instead of treating it as epoch 0", () => {
    const ids = sortNewApiTokenCandidates([
      token({ id: 1, accessedTime: null, createdTime: 999 }),
      token({ id: 2, accessedTime: 1 }),
    ], { now: NOW }).map((t) => t.id);
    // A demonstrably-used token beats a never-used one.
    expect(ids).toEqual([2, 1]);
  });

  it("drops unusable tokens entirely", () => {
    const ids = sortNewApiTokenCandidates([
      token({ id: 1, status: 2, accessedTime: 999 }),
      token({ id: 2, expiredTime: NOW - 1, accessedTime: 998 }),
      token({ id: 3, unlimitedQuota: false, remainQuota: 0, accessedTime: 997 }),
      token({ id: 4, accessedTime: 1 }),
    ], { now: NOW }).map((t) => t.id);
    expect(ids).toEqual([4]);
  });

  it("returns an empty list rather than throwing on junk input", () => {
    expect(sortNewApiTokenCandidates(null)).toEqual([]);
    expect(sortNewApiTokenCandidates([])).toEqual([]);
  });
});

describe("auto-created token naming", () => {
  it("is recognizable and carries the unique suffix", () => {
    expect(buildAutoTokenName("a1b2c3d4")).toBe("9Router Auto a1b2c3d4");
  });

  it("strips unsafe characters and never produces a bare prefix", () => {
    expect(buildAutoTokenName("../../etc")).toBe("9Router Auto etc");
    expect(buildAutoTokenName("")).toBe("9Router Auto 1");
    expect(buildAutoTokenName(null)).toBe("9Router Auto 1");
  });

  it("stays inside the upstream 50-character name limit", () => {
    expect(buildAutoTokenName("f".repeat(64)).length).toBeLessThanOrEqual(50);
  });
});
