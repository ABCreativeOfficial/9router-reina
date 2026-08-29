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
    const generic = parent.slice(parent.indexOf("if (isNewApi)"));
    expect(generic).not.toContain("<NewApiCheckin");
    expect(generic).not.toContain("<NewApiReferral");
    expect(generic).toContain("<QuotaTable");
  });

  it("reuses the standard tracker card structure as its visual base", () => {
    for (const marker of [
      'padding="none"',
      'className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}',
      'className="px-3 py-2 border-b border-black/10 dark:border-white/10"',
      'className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden"',
      'className="text-sm font-semibold text-text-primary capitalize truncate"',
      'className="px-2 py-1.5"',
      '<QuotaTable quotas={quotas} compact sortMode="default" />',
    ]) expect(card).toContain(marker);
    expect(parent).toContain("quotas={visibleQuotas}");
  });

  it("keeps the standard header actions and wires existing behavior", () => {
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

  it("appends check-in as a compact status row after the quota body", () => {
    expect(card.indexOf("<QuotaTable")).toBeLessThan(card.indexOf("<NewApiCheckin"));
    expect(card.indexOf("<NewApiCheckin")).toBeLessThan(card.indexOf("<NewApiReferral"));
    expect(checkin).toContain("embedded ? (");
    expect(checkin).toContain("✓ Checked in today");
    expect(checkin).toContain("+{reward}");
    expect(checkin).toContain("flex-wrap");
  });

  it("uses a flat referral footer rather than a nested card", () => {
    expect(referral).toContain("if (footer)");
    expect(referral).toContain("border-t border-black/10");
    expect(referral).toContain("Referral rewards");
    expect(referral).toContain("Transfer All →");
    expect(referral).toContain('aria-label="Copy referral code"');
    expect(referral).toContain("formatAmount(state.pending)");
    expect(referral).toContain("formatAmount(state.totalEarned)");
  });

  it("collapses zero pending into a compact footer with the code still copyable", () => {
    const zero = referral.slice(referral.indexOf("if (footer && !state.canTransfer)"), referral.indexOf("if (footer) {"));
    expect(zero).toContain("No rewards yet");
    expect(zero).toContain("referralCode");
    expect(zero).not.toContain("Transfer All");
    expect(zero).not.toContain("disabled=");
  });
});
