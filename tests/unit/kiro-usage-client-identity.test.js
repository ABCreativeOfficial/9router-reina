import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getKiroUsage } from "../../open-sse/services/usage/kiro.js";
import { KIRO_IDE_VERSION } from "../../open-sse/config/kiroClientIdentity.js";

afterEach(() => vi.resetAllMocks());

describe("Kiro quota client headers", () => {
  it("sends current IDE identity and API_KEY token type", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ usageBreakdownList: [] }),
    });
    await getKiroUsage("quota-token", { authMethod: "api_key" });
    const [, init] = proxyAwareFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toContain(`KiroIDE-${KIRO_IDE_VERSION}-`);
    expect(init.headers["X-Amz-User-Agent"]).toContain(`KiroIDE-${KIRO_IDE_VERSION}-`);
    expect(init.headers.tokentype).toBe("API_KEY");
  });

  it("keeps identity on fallback requests and external IdP token type", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "" })
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ usageBreakdownList: [] }) });

    await getKiroUsage("quota-token", { authMethod: "external_idp" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const [, init] of proxyAwareFetch.mock.calls) {
      expect(init.headers["User-Agent"]).toContain(`KiroIDE-${KIRO_IDE_VERSION}-`);
      expect(init.headers.TokenType).toBe("EXTERNAL_IDP");
    }
  });
});
