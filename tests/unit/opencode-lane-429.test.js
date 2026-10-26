// Lane policy for the two OpenCode 429 shapes, plus the retry wiring.
//
// Probed live: 11 of 14 byte-identical glm-5.3-flash-free requests answered
//   429 {"error":{"type":"server_error","message":"Upstream request failed:
//        Endpoint is unavailable."}}
// then three in a row succeeded; a control model on the same lane was 6/6 clean.
// That is the gateway route, not the account — worth a bounded retry.
// A quota 429 is the opposite: account state, veto the retry, let the caller's
// lock/fallback handling own it.
import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { computeOpencodeRetryDelay, parseOpencodeError } = await import("../../open-sse/utils/opencodeLane.js");
const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
const { OpenCodeZenExecutor } = await import("../../open-sse/executors/opencode-zen.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");

const ROUTE_429 = JSON.stringify({
  error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." },
});
const QUOTA_429 = JSON.stringify({
  error: { type: "FreeUsageLimitError", message: "Free usage limit reached. Reset after 300s." },
});

function res(status, body = "") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    clone: () => ({ text: async () => body }),
    text: async () => body,
    body: null,
  };
}

beforeEach(() => fetchMock.mockReset());

describe("computeOpencodeRetryDelay", () => {
  it("retries the gateway-route 429 with a bounded backoff", async () => {
    const delay = await computeOpencodeRetryDelay(res(429, ROUTE_429), 1);
    expect(typeof delay).toBe("number");
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(3000);
    // Grows with the attempt, still bounded.
    const second = await computeOpencodeRetryDelay(res(429, ROUTE_429), 2);
    expect(second).toBeGreaterThanOrEqual(delay);
    expect(second).toBeLessThanOrEqual(3000);
  });

  it("vetoes a quota 429 — retrying only burns the window", async () => {
    expect(await computeOpencodeRetryDelay(res(429, QUOTA_429), 1)).toBe(false);
  });

  it("retries an unparseable 429 body as the dominant route shape", async () => {
    const broken = res(429, "");
    broken.clone = () => ({ text: async () => { throw new Error("stream closed"); } });
    expect(typeof await computeOpencodeRetryDelay(broken, 1)).toBe("number");
  });

  it("leaves non-429 statuses to the configured delay", async () => {
    expect(await computeOpencodeRetryDelay(res(503, "boom"), 1)).toBeUndefined();
    expect(await computeOpencodeRetryDelay(res(200, "{}"), 1)).toBeUndefined();
  });
});

describe("parseOpencodeError", () => {
  it("explains the route 429 while keeping the 429 status", () => {
    const parsed = parseOpencodeError(res(429, ROUTE_429), ROUTE_429);
    // Status stays 429 on purpose: clients treat it as retry-with-backoff, and
    // the account-lock path uses the status (503 would take a 30s cooldown).
    expect(parsed.status).toBe(429);
    expect(parsed.message).toMatch(/route unavailable/i);
    expect(parsed.message).toMatch(/not this account/i);
  });

  it("leaves a quota 429 as a plain rate-limit error", () => {
    const parsed = parseOpencodeError(res(429, QUOTA_429), QUOTA_429);
    expect(parsed.status).toBe(429);
    expect(parsed.message).toBe(QUOTA_429);
    expect(parsed.message).not.toMatch(/route unavailable/i);
  });

  it("passes other statuses through untouched", () => {
    expect(parseOpencodeError(res(400, "bad"), "bad")).toEqual({ status: 400, message: "bad" });
    expect(parseOpencodeError(res(401, ""), "").status).toBe(401);
  });
});

describe("registry retry config", () => {
  it.each(["opencode", "opencode-zen"])("%s declares a bounded 429 retry", (id) => {
    const retry = PROVIDERS[id].retry;
    expect(retry?.["429"]?.attempts).toBeGreaterThan(0);
    expect(retry["429"].attempts).toBeLessThanOrEqual(3);
  });

  it("both executors wire the hook", () => {
    expect(typeof new OpenCodeExecutor().computeRetryDelay).toBe("function");
    expect(typeof new OpenCodeZenExecutor().computeRetryDelay).toBe("function");
  });

  it("both executors classify errors", () => {
    expect(new OpenCodeExecutor().parseError(res(429, ROUTE_429), ROUTE_429).status).toBe(429);
    expect(new OpenCodeZenExecutor().parseError(res(429, ROUTE_429), ROUTE_429).message).toMatch(/route unavailable/i);
  });
});

describe("execute() — bounded retry, no retry loop on quota", () => {
  const creds = { connectionId: "opencode-lane-429-test" };
  const body = () => ({ model: "glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }], stream: true });

  // The loop itself is asserted with the wait stubbed to 0: the delay shape is
  // covered above, and 1.5s of real sleeps per case adds nothing.
  function fastExecutor() {
    const ex = new OpenCodeExecutor();
    ex.computeRetryDelay = () => 0;
    return ex;
  }

  it("recovers when the route flake clears (2 retries, then 200)", async () => {
    fetchMock
      .mockResolvedValueOnce(res(429, ROUTE_429))
      .mockResolvedValueOnce(res(429, ROUTE_429))
      .mockResolvedValueOnce(res(200, "{}"));
    const out = await fastExecutor().execute({ model: "glm-5.3-flash-free", body: body(), stream: true, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(PROVIDERS.opencode.retry["429"].attempts + 1).toBe(fetchMock.mock.calls.length);
    // TLS routing survives every bounded retry; proxy resolution still owns the fetch.
    const transports = fetchMock.mock.calls.map(([, options]) => options.directFetch);
    expect(transports.every((transport) => typeof transport === "function")).toBe(true);
    expect(new Set(transports).size).toBe(1);
  });

  it("returns the 429 after the bounded attempts are exhausted (no infinite loop)", async () => {
    fetchMock.mockResolvedValue(res(429, ROUTE_429));
    const out = await fastExecutor().execute({ model: "glm-5.3-flash-free", body: body(), stream: true, credentials: creds });
    expect(out.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(PROVIDERS.opencode.retry["429"].attempts + 1);
  });

  it("does not retry a quota 429 at all", async () => {
    fetchMock.mockResolvedValue(res(429, QUOTA_429));
    const out = await new OpenCodeExecutor().execute({ model: "glm-5.3-flash-free", body: body(), stream: true, credentials: creds });
    expect(out.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
