import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

const {
  isAcceptableCompletionOrigin,
  isLoopbackOrigin,
  readRequestOrigin,
  resolveRouterOrigin,
} = await import("../../src/lib/newapi/routerOrigin.js");

function request(headers) {
  return new Request("http://placeholder.invalid/api/new-api/pair/start", { headers });
}

describe("router origin resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    mocks.getSettings.mockResolvedValue({});
  });

  it("reads a remote HTTPS origin from the forwarded headers", async () => {
    const origin = await resolveRouterOrigin(request({
      host: "router.example.com",
      "x-forwarded-proto": "https",
    }));
    expect(origin).toBe("https://router.example.com");
  });

  it("honours x-forwarded-host over host", () => {
    expect(readRequestOrigin(request({
      host: "internal:3000",
      "x-forwarded-host": "public.example.com",
      "x-forwarded-proto": "https",
    }))).toBe("https://public.example.com");
  });

  it("takes only the first hop of a proto chain", () => {
    expect(readRequestOrigin(request({
      host: "router.example.com",
      "x-forwarded-proto": "https, http",
    }))).toBe("https://router.example.com");
  });

  it("prefers a configured base URL over request headers", async () => {
    mocks.getSettings.mockResolvedValue({ baseUrl: "https://configured.example/" });
    expect(await resolveRouterOrigin(request({ host: "other.example" }))).toBe("https://configured.example");
  });

  it("falls back through the env contract", async () => {
    process.env.BASE_URL = "https://from-env.example";
    expect(await resolveRouterOrigin(request({ host: "other.example" }))).toBe("https://from-env.example");

    delete process.env.BASE_URL;
    process.env.NEXT_PUBLIC_BASE_URL = "https://from-public-env.example";
    expect(await resolveRouterOrigin(request({ host: "other.example" }))).toBe("https://from-public-env.example");
  });

  it("still resolves when settings are unavailable", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db down"));
    expect(await resolveRouterOrigin(request({
      host: "router.example.com",
      "x-forwarded-proto": "https",
    }))).toBe("https://router.example.com");
  });

  it("does not assume localhost", async () => {
    const origin = await resolveRouterOrigin(request({
      host: "9router.mydomain.tld",
      "x-forwarded-proto": "https",
    }));
    expect(origin).not.toContain("localhost");
    expect(origin).toBe("https://9router.mydomain.tld");
  });
});

describe("completion origin acceptance", () => {
  it("recognizes loopback in its usual spellings", () => {
    for (const origin of ["http://localhost:20128", "http://127.0.0.1:20128", "http://[::1]:20128"]) {
      expect(isLoopbackOrigin(origin), origin).toBe(true);
    }
    expect(isLoopbackOrigin("https://router.example.com")).toBe(false);
    expect(isLoopbackOrigin("garbage")).toBe(false);
  });

  it("accepts the exact paired origin", () => {
    expect(isAcceptableCompletionOrigin("https://router.example.com", "https://router.example.com")).toBe(true);
  });

  it("accepts a loopback arrival for a remotely-paired router", () => {
    // Pairing state is per-process memory, so the secret is the real boundary;
    // this check only catches a misconfigured bridge.
    expect(isAcceptableCompletionOrigin("https://router.example.com", "http://localhost:20128")).toBe(true);
  });

  it("accepts a host match when the scheme was not forwarded", () => {
    // A reverse proxy that forwards Host but not X-Forwarded-Proto makes an https
    // deployment read as http; refusing that would 403 every completion.
    expect(isAcceptableCompletionOrigin("https://router.example.com", "http://router.example.com")).toBe(true);
  });

  it("refuses a different non-loopback host", () => {
    expect(isAcceptableCompletionOrigin("https://router.example.com", "https://evil.example")).toBe(false);
    expect(isAcceptableCompletionOrigin("https://router.example.com", "https://sub.router.example.com")).toBe(false);
  });

  it("does not gate when no router origin could be resolved", () => {
    expect(isAcceptableCompletionOrigin("", "https://anything.example")).toBe(true);
  });
});
