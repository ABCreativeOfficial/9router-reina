// "[TOKEN_REFRESH] All 3 retry attempts failed" was reported for codebuddy-intl
// even though its token endpoint was never called: CodeBuddyIntlExecutor
// inherited DefaultExecutor.refreshCredentials, which has no refresher for this
// provider and returns null, so refreshWithRetry() spent three attempts (two
// sleeps) on a capability the connection does not have and logged a failure that
// blamed the token.
//
// The fix has two halves:
//   1. the executor delegates to the real CodeBuddy Intl refresher;
//   2. a provider with nothing to refresh returns REFRESH_UNAVAILABLE, which
//      refreshWithRetry() treats as final instead of retrying.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  refreshWithRetry,
  isRefreshUnavailable,
  REFRESH_UNAVAILABLE,
} from "../../open-sse/services/tokenRefresh.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

function makeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("refreshWithRetry — no-refresh sentinel", () => {
  it("stops after one call and does not log 'All N retry attempts failed'", async () => {
    const log = makeLog();
    const refreshFn = vi.fn().mockResolvedValue(REFRESH_UNAVAILABLE);

    const started = Date.now();
    const result = await refreshWithRetry(refreshFn, 3, log);
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    expect(refreshFn).toHaveBeenCalledTimes(1);
    // The old path slept 1s + 2s between the pointless attempts.
    expect(elapsed).toBeLessThan(900);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      expect.stringMatching(/no token refresh/i),
    );
  });

  it("still retries a genuine transient failure", async () => {
    const log = makeLog();
    const refreshFn = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accessToken: "fresh" });

    const result = await refreshWithRetry(refreshFn, 3, log);

    expect(result).toEqual({ accessToken: "fresh" });
    expect(refreshFn).toHaveBeenCalledTimes(3);
  });

  it("still reports exhausted retries when the refresh really fails", async () => {
    const log = makeLog();
    const refreshFn = vi.fn().mockResolvedValue(null);

    const result = await refreshWithRetry(refreshFn, 2, log);

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith("TOKEN_REFRESH", "All 2 retry attempts failed");
  });
});

describe("CodeBuddyIntlExecutor.refreshCredentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the sentinel when the connection has no refresh token", async () => {
    const result = await new CodeBuddyIntlExecutor().refreshCredentials({ accessToken: "a" }, makeLog());
    expect(isRefreshUnavailable(result)).toBe(true);
  });

  it("delegates to the CodeBuddy Intl token endpoint and maps the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new CodeBuddyIntlExecutor()
      .refreshCredentials({ refreshToken: "old-refresh" }, makeLog());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.codebuddy.ai/v2/plugin/auth/token/refresh");
    expect(init.headers["X-Refresh-Token"]).toBe("old-refresh");
    expect(result).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    });
  });

  it("lets refreshWithRetry treat a tokenless connection as final", async () => {
    const executor = new CodeBuddyIntlExecutor();
    const log = makeLog();
    const calls = [];
    const refreshFn = vi.fn(async () => {
      calls.push(1);
      return executor.refreshCredentials({ accessToken: "a" }, log);
    });

    const result = await refreshWithRetry(refreshFn, 3, log);

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });
});
