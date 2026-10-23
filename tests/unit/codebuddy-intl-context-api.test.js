import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn(), state: { providerOverrides: {} } }));
vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

import { PATCH as patchSettings } from "../../src/app/api/settings/route.js";
import { PUT as putOverrides, GET as getOverrides } from "../../src/app/api/providers/[id]/overrides/route.js";

const defaults = { enabled: false, contextLimit: null, triggerThreshold: 0.95, safetyMargin: 0.05, outputReserveTokens: 4096, fallbackCompression: false, preferNativeCompaction: true, keepRecentTurns: 2 };
const params = { params: Promise.resolve({ id: "codebuddy-intl" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { providerOverrides: {} };
  mocks.getSettings.mockImplementation(async () => structuredClone(mocks.state));
  mocks.updateSettings.mockImplementation(async (patch) => {
    mocks.state = { ...mocks.state, ...structuredClone(patch) };
    return structuredClone(mocks.state);
  });
});

describe("CodeBuddy context settings trust boundaries", () => {
  it("validates and persists Intl settings through provider overrides", async () => {
    const response = await putOverrides(new Request("http://local/api/providers/codebuddy-intl/overrides", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers: {}, context: { ...defaults, enabled: true, contextLimit: 1048576 } }),
    }), params);
    expect(response.status).toBe(200);
    expect((await response.json()).context).toMatchObject({ enabled: true, contextLimit: 1048576 });
    const get = await getOverrides(new Request("http://local"), params);
    expect((await get.json()).context).toMatchObject({ enabled: true, contextLimit: 1048576 });
  });

  it("rejects context settings for other providers and invalid ranges", async () => {
    const wrongProvider = await putOverrides(new Request("http://local", { method: "PUT", body: JSON.stringify({ context: defaults }) }), { params: Promise.resolve({ id: "openai" }) });
    expect(wrongProvider.status).toBe(400);
    const badRange = await putOverrides(new Request("http://local", { method: "PUT", body: JSON.stringify({ context: { ...defaults, safetyMargin: 0.9 } }) }), params);
    expect(badRange.status).toBe(400);
  });

  it("validates context supplied through generic settings PATCH as well", async () => {
    const bad = await patchSettings(new Request("http://local/api/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerOverrides: { "codebuddy-intl": { context: { ...defaults, outputReserveTokens: -1 } } } }),
    }));
    expect(bad.status).toBe(400);
  });
});
