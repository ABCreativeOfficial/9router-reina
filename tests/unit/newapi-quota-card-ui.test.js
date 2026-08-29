import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const card = readFileSync(join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/NewApiQuotaCard.js"), "utf8");
const parent = readFileSync(join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js"), "utf8");
const checkin = readFileSync(join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/NewApiCheckin.js"), "utf8");
const referral = readFileSync(join(ROOT, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/NewApiReferral.js"), "utf8");

describe("New API quota card presentation", () => {
  it("branches New API into a dedicated card while preserving the generic card path", () => {
    expect(parent).toContain("const isNewApi = isNewApiConnection(conn)");
    expect(parent).toContain("if (isNewApi)");
    expect(parent).toContain("<NewApiQuotaCard");
    expect(parent).toContain("<QuotaTable");
    expect(parent.indexOf("if (isNewApi)")).toBeLessThan(parent.indexOf("<Card", parent.indexOf("if (isNewApi)")));
    const generic = parent.slice(parent.indexOf("if (isNewApi)"));
    expect(generic).not.toContain("<NewApiCheckin");
    expect(generic).not.toContain("<NewApiReferral");
    expect(generic).toContain("<QuotaTable");
  });

  it("makes label-first account balance and the existing meter semantics the focus", () => {
    expect(card).toContain("Account balance");
    expect(card).toContain("Math.max(0, total - used)");
    expect(card).toContain("getRemainingPercentage(quota)");
    expect(card).toContain('role="progressbar"');
    expect(card).toContain("balance.percentage}%");
    expect(card).toContain("tabular-nums");
    expect(card.indexOf("Account balance")).toBeLessThan(card.indexOf("formatBalance(balance.amount"));
    expect(card.indexOf("balance.percentage}%")).toBeLessThan(card.indexOf("formatBalance(balance.amount"));
    expect(card).not.toContain("quota{");
    expect(card).not.toContain("<QuotaTable");
  });

  it("keeps header actions and wires existing check-in/referral behavior", () => {
    for (const marker of [
      'aria-label="Refresh quota"',
      'aria-label="Edit connection"',
      'aria-label="Delete connection"',
      "<Toggle",
      "<NewApiCheckin",
      "embedded",
      "<NewApiReferral",
      "footer",
      "onQuotaRefresh={onRefresh}",
    ]) expect(card).toContain(marker);
  });

  it("renders a breathable wrap-safe checked-in row with converted reward", () => {
    expect(checkin).toContain("embedded ? (");
    expect(checkin).toContain("✓ Checked in today");
    expect(checkin).toContain("+{reward}");
    expect(checkin).toContain("flex-wrap");
    expect(checkin).toContain("py-3.5");
  });

  it("uses a flat responsive referral footer rather than a nested card", () => {
    expect(referral).toContain("if (footer)");
    expect(referral).toContain("border-t border-black/10");
    expect(referral).toContain("sm:grid-cols-3");
    expect(referral).toContain("Referral rewards");
    expect(referral).toContain("Transfer All →");
    expect(referral).toContain('aria-label="Copy referral code"');
    expect(referral).toContain("formatAmount(state.pending)");
    expect(referral).toContain("formatAmount(state.totalEarned)");
  });

  it("collapses zero pending into a muted one-line footer", () => {
    const zero = referral.slice(referral.indexOf("if (footer && !state.canTransfer)"), referral.indexOf("if (footer) {"));
    expect(zero).toContain("No rewards yet");
    expect(zero).toContain("referralCode");
    expect(zero).not.toContain("Transfer All");
    expect(zero).not.toContain("disabled=");
  });
});
