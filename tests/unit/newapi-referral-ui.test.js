import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const component = readFileSync(
  join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/NewApiReferral.js"),
  "utf8",
);
const parent = readFileSync(
  join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js"),
  "utf8",
);

describe("New API referral UI contract", () => {
  it("mounts through the dedicated per-account New API card branch", () => {
    expect(parent).toContain("const isNewApi = isNewApiConnection(conn)");
    expect(parent).toContain("if (isNewApi)");
    expect(parent).toContain("<NewApiQuotaCard");
    expect(component).toContain("footer = false");
  });

  it("renders live referral metrics and transfer-all states", () => {
    for (const marker of [
      "Referral Rewards",
      "Pending",
      "Total Earned",
      "Invites",
      "Transfer All to Balance",
      "Nothing to transfer",
      'state.status === "unsupported"',
      'state.status === "loading"',
      'state.status === "error"',
      "disabled={!state.canTransfer || state.transferring}",
    ]) expect(component).toContain(marker);
  });

  it("posts no browser-selected amount and suppresses double clicks", () => {
    expect(component).toContain("const transferInFlight = useRef(false)");
    expect(component).toContain("if (transferInFlight.current) return");
    expect(component).toContain('fetch(`/api/usage/${connection.id}/newapi-referral`, { method: "POST" })');
    expect(component).not.toMatch(/body:\s*JSON\.stringify/);
  });

  it("updates referral, refreshes normal quota, then emits one terminal toast", () => {
    const update = component.indexOf("setState({ status: \"ready\", ...result.referral");
    const quota = component.indexOf("await onQuotaRefresh()", update);
    const toast = component.indexOf("notify.success(", quota);
    expect(update).toBeGreaterThan(-1);
    expect(quota).toBeGreaterThan(update);
    expect(toast).toBeGreaterThan(quota);
    expect(component.match(/notify\.success\(/g)).toHaveLength(1);
    expect(component.match(/notify\.error\(/g)).toHaveLength(1);
  });

  it("copies exactly the visible referral code with local feedback", () => {
    expect(component).toContain("navigator.clipboard.writeText(state.affCode)");
    expect(component).toContain('aria-label="Copy referral code"');
    expect(component).toContain('setCopyState("copied")');
    expect(component).toContain('setCopyState("failed")');
    expect(component).toContain('setTimeout(() => setCopyState("idle"), 1800)');
    expect(component).toContain('copyState === "copied" ? "Copied" : state.affCode');
    expect(component).toContain("focus-visible:outline");
  });

  it("keeps copy local and independent from Transfer All", () => {
    const copyStart = component.indexOf("const copyReferralCode");
    const transferStart = component.indexOf("const transferAll");
    const copyBlock = component.slice(copyStart, transferStart);
    expect(copyBlock).not.toContain("notify.success");
    expect(copyBlock).not.toContain("notify.error");
    expect(copyBlock).not.toContain("transferAll");
    expect(component).toContain("onClick={transferAll}");
  });

  it("does not invent referral signup URLs or provider-specific behavior", () => {
    expect(component).not.toMatch(/sign-up|register|profile/i);
    expect(component).not.toMatch(/gorouter|tabitoken/i);
    expect(component).not.toContain("providerOrigin");
    expect(component).not.toMatch(/localStorage|sessionStorage/);
  });
});
