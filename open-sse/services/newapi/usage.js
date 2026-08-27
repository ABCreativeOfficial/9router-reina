import { toFiniteNumber } from "../usage/shared.js";

/**
 * Reusable New API quota normalization (custom fork).
 *
 * New API stores balances in opaque "quota units" and renders them through the
 * deployment's own `/api/status` config: `quota_per_unit` units make one USD, and
 * CNY/CUSTOM display modes then apply an advertised exchange rate. Reproducing
 * that here — rather than hardcoding a divisor — keeps a fork with a different
 * `quota_per_unit` from being misreported.
 *
 * `null` means "cannot convert honestly"; callers surface a message instead of a
 * misleading number.
 */

/**
 * Convert raw quota units into the deployment's display currency.
 * @param {number|string} rawQuota
 * @param {object|null} status  `/api/status` data
 * @returns {{ value: number, unit: string }|null}
 */
export function convertNewApiQuota(rawQuota, status) {
  const quota = toFiniteNumber(rawQuota, Number.NaN);
  if (!Number.isFinite(quota) || quota < 0) return null;

  const displayType = String(status?.quota_display_type || "USD").toUpperCase();
  if (displayType === "TOKENS") {
    return { value: quota, unit: "quota units" };
  }

  const quotaPerUnit = toFiniteNumber(status?.quota_per_unit, Number.NaN);
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return null;

  const usd = quota / quotaPerUnit;
  if (displayType === "CNY") {
    const rate = toFiniteNumber(status?.usd_exchange_rate, Number.NaN);
    return Number.isFinite(rate) && rate > 0 ? { value: usd * rate, unit: "CNY" } : null;
  }
  if (displayType === "CUSTOM") {
    const rate = toFiniteNumber(status?.custom_currency_exchange_rate, Number.NaN);
    const symbol = typeof status?.custom_currency_symbol === "string"
      ? status.custom_currency_symbol.trim()
      : "";
    return Number.isFinite(rate) && rate > 0 && symbol
      ? { value: usd * rate, unit: symbol }
      : null;
  }
  return { value: usd, unit: "USD" };
}

/**
 * Build the 9Router usage payload for one New API account.
 *
 * `account.quota` is the remaining balance and `account.usedQuota` is lifetime
 * spend, so total is their sum and the percentage is derived from remaining —
 * never from `used/total`, which would read backwards for a credit pot.
 *
 * @param {object} client   from createNewApiClient
 * @param {string} accessToken management token
 * @param {object} providerSpecificData  must carry `userId`
 * @param {object|null} proxyOptions
 * @param {string} [quotaLabel="Account Quota"]
 */
export async function getNewApiUsage(client, accessToken, providerSpecificData = {}, proxyOptions = null, quotaLabel = "Account Quota") {
  const userId = providerSpecificData?.userId;
  const [result, status] = await Promise.all([
    client.getAccount(accessToken, userId, proxyOptions),
    client.fetchStatus(proxyOptions),
  ]);

  if (!result.ok) return { plan: client.label, message: result.message };

  const remaining = convertNewApiQuota(result.account.quota, status);
  const used = convertNewApiQuota(result.account.usedQuota, status);
  if (!remaining || !used) {
    return {
      plan: result.account.group || client.label,
      message: `${client.label} quota conversion is unavailable.`,
    };
  }

  const total = Math.max(0, remaining.value + used.value);
  const usedValue = Math.max(0, Math.min(used.value, total));
  const remainingPercentage = total > 0 ? (remaining.value / total) * 100 : 0;
  return {
    plan: result.account.group || client.label,
    status: result.account.status,
    requestCount: result.account.requestCount,
    quotas: {
      [`${quotaLabel} (${remaining.unit})`]: {
        used: usedValue,
        total,
        remainingPercentage,
        resetAt: null,
      },
    },
  };
}
