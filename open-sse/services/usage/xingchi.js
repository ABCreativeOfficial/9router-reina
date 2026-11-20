/**
 * Xingchi (Sub2API) API-key usage adapter for the existing Quota Tracker.
 *
 * GET /v1/usage is authoritative for wallet/subscription/key quotas; the
 * separate /v1/sub2api/billing probe is OPTIONAL and reports the configured
 * billing rate, not a balance. Never derive a quota cap from wallet spending.
 * All calls run server-side through 9router's existing proxy/timeout helper.
 */

import { fetchWithTimeout, U } from "./shared.js";

const { url: USAGE_URL, billingUrl: BILLING_URL } = U("xingchi");
const FETCH_TIMEOUT_MS = 10000;

function finite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, 120) || fallback : fallback;
}

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function usageCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    requests: finite(value.requests),
    inputTokens: finite(value.input_tokens),
    outputTokens: finite(value.output_tokens),
    totalTokens: finite(value.total_tokens),
    cacheReadTokens: finite(value.cache_read_tokens),
    cacheWriteTokens: finite(value.cache_write_tokens ?? value.cache_creation_tokens),
    cost: finite(value.cost),
    actualCost: finite(value.actual_cost),
  };
}

function pushLimit(quotas, name, source, unit, resetAt = null) {
  if (!source || typeof source !== "object") return;
  const limit = finite(source.limit);
  if (limit === null || limit <= 0) return; // unknown/unlimited is NOT 0% remaining
  const used = finite(source.used) ?? 0;
  quotas[name] = {
    used: Math.max(0, used),
    total: limit,
    unit,
    resetAt: timestamp(resetAt ?? source.reset_at ?? source.resetAt),
  };
}

/** Parse the four Sub2API modes without confusing an absolute USD balance
 * with a percentage or a replenishing time-window quota. */
export function normalizeXingchiUsage(data, billing = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.isValid === false || data.error) return null;

  const unit = text(data.unit, "USD").toUpperCase();
  const plan = text(data.planName, "Xingchi API");
  const quota = data.quota && typeof data.quota === "object" ? data.quota : null;
  const subscription = data.subscription && typeof data.subscription === "object" ? data.subscription : null;
  const rateLimits = Array.isArray(data.rate_limits) ? data.rate_limits : [];
  const balance = finite(data.balance);
  const remaining = finite(data.remaining);
  const mode = text(data.mode, "unknown");
  const quotas = {};

  if (quota) {
    pushLimit(quotas, `API Key quota (${unit})`, quota, text(quota.unit, unit).toUpperCase());
  }

  if (subscription) {
    for (const [label, prefix] of [["Daily", "daily"], ["Weekly", "weekly"], ["Monthly", "monthly"]]) {
      pushLimit(quotas, `${label} subscription (${unit})`, {
        used: subscription[`${prefix}_usage_usd`],
        limit: subscription[`${prefix}_limit_usd`],
      }, unit, subscription[`${prefix}_reset_at`] ?? subscription[`${prefix}_resets_at`]);
    }
  }

  for (const [index, window] of rateLimits.entries()) {
    const label = text(window?.window, `Window ${index + 1}`);
    pushLimit(quotas, `Rate limit (${label})`, window, text(window?.unit, unit).toUpperCase());
  }

  // "unrestricted" is the wallet mode on the verified Xingchi response.
  // Follow the New API account-progress convention: current balance divided
  // by (balance + cumulative ACTUAL spend). This shows the proportion of the
  // recorded balance/spend history, NOT a guaranteed original deposit cap:
  // top-ups or refunds can change the historical baseline.
  const isWallet = !quota && !subscription && rateLimits.length === 0 &&
    (mode === "unrestricted" || /钱包|wallet/i.test(plan));
  const actualSpent = finite(data.usage?.total?.actual_cost);
  if (isWallet && balance !== null && balance >= 0) {
    if (actualSpent !== null && actualSpent >= 0) {
      const recordedTotal = balance + actualSpent;
      if (Number.isFinite(recordedTotal)) {
        quotas[`Balance (${unit})`] = {
          used: actualSpent,
          total: recordedTotal,
          remainingPercentage: recordedTotal > 0 ? (balance / recordedTotal) * 100 : 0,
          remainingAmount: balance,
          isWalletBalance: true,
          unit,
          resetAt: null,
        };
      }
    }
    // Some deployments omit actual_cost. Without real charged spending we
    // cannot calculate a meaningful ratio; show the balance without a bar.
    if (!quotas[`Balance (${unit})`]) {
      quotas[`Balance (${unit})`] = {
        used: 0, total: balance, remainingPercentage: 100,
        resetAt: null, isCreditBalance: true, currency: unit,
      };
    }
  }

  const billingRate = billing?.object === "sub2api.key_billing"
    ? finite(billing.effective_rate_multiplier)
    : null;
  const modelStats = Array.isArray(data.model_stats)
    ? data.model_stats.slice(0, 30).filter((m) => m && typeof m === "object")
      .map((m) => ({ model: text(m.model), ...usageCounts(m) }))
      .filter((m) => m.model)
    : [];

  return {
    plan,
    quotas,
    xingchi: {
      plan,
      mode,
      unit,
      balance: isWallet ? balance : null,
      remaining,
      today: usageCounts(data.usage?.today),
      total: usageCounts(data.usage?.total),
      models: modelStats,
      billingRate,
      billingScope: billingRate === null ? null : text(billing.billing_scope),
    },
  };
}

async function request(url, apiKey, proxyOptions, fetcher) {
  return fetcher(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    // Prevent accidentally serving cached, potentially outdated quota data.
    cache: "no-store",
  }, FETCH_TIMEOUT_MS, proxyOptions);
}

export async function getXingchiUsage(apiKey = null, proxyOptions = null, fetcher = fetchWithTimeout) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { message: "Xingchi API key not available. Add a key to view quota." };

  // Billing is advisory: don't hide a valid balance when this endpoint is
  // unavailable, slower, or disabled on a particular Sub2API deployment.
  const [usageResult, billingResult] = await Promise.allSettled([
    request(USAGE_URL, key, proxyOptions, fetcher),
    request(BILLING_URL, key, proxyOptions, fetcher),
  ]);

  if (usageResult.status === "rejected") {
    return { message: "Xingchi usage request failed. Check connection/proxy and retry." };
  }

  const usageResponse = usageResult.value;
  if (usageResponse.status === 401 || usageResponse.status === 403) {
    return { message: `Xingchi usage authentication/access denied (HTTP ${usageResponse.status}).` };
  }
  if (!usageResponse.ok) {
    return { message: `Xingchi usage endpoint returned HTTP ${usageResponse.status}.` };
  }

  const data = await usageResponse.json().catch(() => null);
  if (!data || data.isValid === false || data.error) {
    return { message: "Xingchi usage response is invalid or API key is not accepted." };
  }

  let billing = null;
  if (billingResult.status === "fulfilled" && billingResult.value.ok) {
    billing = await billingResult.value.json().catch(() => null);
  }
  return normalizeXingchiUsage(data, billing)
    ?? { message: "Xingchi returned an unsupported usage response." };
}
