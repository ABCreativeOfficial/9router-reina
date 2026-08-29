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
  it("mounts through the dedicated dynamic New API card", () => {
    expect(providerLimits).toContain("const isNewApi = isNewApiConnection(conn)");
    expect(providerLimits).toContain("if (isNewApi)");
    expect(providerLimits).toContain("<NewApiQuotaCard");
    expect(component).toContain("embedded = false");
  });

  it("covers push completion, polling fallback and fast-path states", () => {
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
      'window.addEventListener("message", handleCompletion)',
      'data?.type !== "CHECKIN_COMPLETED"',
      'data?.checkinId !== session.checkinId',
      'event.source !== window',
      'event.origin !== window.location.origin',
      'void confirmInteractiveSuccess(session.checkinId)',
      '/api/new-api/checkin/status?id=',
      'if (await confirmInteractiveSuccess(session.checkinId)) return',
      'next === "error" || next === "expired"',
      "✓ Checked in today",
    ]) expect(component).toContain(marker);
  });

  it("dedupes one interactive claim while allowing later claim ids", () => {
    expect(component).toContain("const completedToastIds = useRef(new Set())");
    expect(component).toContain("const completionPromises = useRef(new Map())");
    expect(component).toContain("completionPromises.current.get(checkinId)");
    expect(component).toContain("completedToastIds.current.has(checkinId)");
    expect(component).toContain("completedToastIds.current.add(checkinId)");
    expect(component).toContain("completionPromises.current.delete(checkinId)");
  });

  it("authoritatively confirms before immediate quota refresh and one toast", () => {
    const confirmStart = component.indexOf("const authoritative = await fetchStatus()");
    const confirmed = component.indexOf('authoritative.checkedInToday !== true');
    const quotaRefresh = component.indexOf("await onQuotaRefresh()", confirmed);
    const toast = component.indexOf('notify.success("Provider confirmed today\'s check-in."', quotaRefresh);
    expect(confirmStart).toBeGreaterThan(-1);
    expect(confirmed).toBeGreaterThan(confirmStart);
    expect(quotaRefresh).toBeGreaterThan(confirmed);
    expect(toast).toBeGreaterThan(quotaRefresh);
  });

  it("preserves a separate single fast-path success toast", () => {
    expect(component).toContain('if (result.status === "success")');
    expect(component).toContain('notify.success(reward ? `Reward added: ${reward}`');
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
