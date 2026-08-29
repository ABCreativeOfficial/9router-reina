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
const card = readFileSync(
  join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/NewApiQuotaCard.js"),
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

  it("publishes the referral code upward instead of owning a copy control", () => {
    expect(component).toContain("onReferralCodeChange");
    expect(component).toContain('onReferralCodeChange(state.status === "ready" ? state.affCode || "" : "")');
    expect(component).not.toContain("navigator.clipboard");
    expect(component).not.toContain('aria-label="Copy referral code"');
    expect(card).toContain('aria-label="Copy referral code"');
    expect(card).toContain("copy(referralCode, copyId)");
  });

  it("keeps referral fetch and Transfer All independent of the header copy action", () => {
    expect(component).toContain("onClick={transferAll}");
    const transferBlock = component.slice(component.indexOf("const transferAll"), component.indexOf("if (state.status === \"unsupported\")"));
    expect(transferBlock).not.toContain("onReferralCodeChange");
    expect(transferBlock).toContain("await onQuotaRefresh()");
  });

  it("does not invent referral signup URLs or provider-specific behavior", () => {
    expect(component).not.toMatch(/sign-up|register|profile/i);
    expect(component).not.toMatch(/gorouter|tabitoken/i);
    expect(component).not.toContain("providerOrigin");
    expect(component).not.toMatch(/localStorage|sessionStorage/);
  });
});
