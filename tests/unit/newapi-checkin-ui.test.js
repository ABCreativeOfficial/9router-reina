import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const component = readFileSync(
  join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/NewApiCheckin.js"),
  "utf8",
);
const providerLimits = readFileSync(
  join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js"),
  "utf8",
);

describe("New API check-in UI contract", () => {
  it("mounts only for dynamic New API connections", () => {
    expect(providerLimits).toContain("isNewApiConnection(conn) &&");
    expect(providerLimits).toContain("<NewApiCheckin");
  });

  it("covers supported, checked-in, fast-path and verification states", () => {
    for (const marker of [
      '!data.supported ? "unsupported"',
      '!data.enabled ? "disabled"',
      'data.checkedInToday ? "checked_in"',
      'result.status === "verification_required"',
      'verification?.protocol !== "newapi-checkin-v2"',
      'window.postMessage({',
      'source: "9router-newapi-checkin"',
      'type: "CHECKIN_SESSION"',
      'checkinSecret: verification.checkinSecret',
      'window.location.origin',
      'window.open(verification.launchUrl',
      '/api/new-api/checkin/status?id=',
      'await Promise.all([onQuotaRefresh(), fetchStatus()])',
      'next === "error" || next === "expired"',
      "✓ Checked in today",
    ]) expect(component).toContain(marker);
  });

  it("keeps the v2 secret in runtime-only router messaging", () => {
    expect(component).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(component).not.toContain("newapi-checkin-v1");
    expect(component).not.toContain("verification.loginUrl");
  });

  it("uses the persisted dynamic label indirectly and never an internal-id label", () => {
    expect(component).not.toContain("openai-compatible-chat-");
    expect(component).not.toMatch(/gorouter|tabitoken/i);
  });
});
