import {
  fetchGoRouterStatus,
  getGoRouterAccount,
} from "../gorouter.js";
import { toFiniteNumber } from "./shared.js";

export function convertGoRouterQuota(rawQuota, status) {
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

export async function getGoRouterUsage(accessToken, providerSpecificData = {}, proxyOptions = null) {
  const userId = providerSpecificData?.userId;
  const [result, status] = await Promise.all([
    getGoRouterAccount(accessToken, userId, proxyOptions),
    fetchGoRouterStatus(proxyOptions),
  ]);

  if (!result.ok) return { plan: "GoRouter", message: result.message };

  const remaining = convertGoRouterQuota(result.account.quota, status);
  const used = convertGoRouterQuota(result.account.usedQuota, status);
  if (!remaining || !used) {
    return {
      plan: result.account.group || "GoRouter",
      message: "GoRouter quota conversion is unavailable.",
    };
  }

  const total = Math.max(0, remaining.value + used.value);
  const usedValue = Math.max(0, Math.min(used.value, total));
  const remainingPercentage = total > 0 ? (remaining.value / total) * 100 : 0;
  return {
    plan: result.account.group || "GoRouter",
    status: result.account.status,
    requestCount: result.account.requestCount,
    quotas: {
      [`Account Quota (${remaining.unit})`]: {
        used: usedValue,
        total,
        remainingPercentage,
        resetAt: null,
      },
    },
  };
}
