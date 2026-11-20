/**
 * Token Harbor free-tier + optional Pass allowance for 9router's existing
 * API-key Quota Tracker. Official endpoint: GET /api/cli/free-tier.
 *
 * Unlike a prepaid wallet, free allowance is a *percentage* over a rolling
 * seven-day window. Never report these percentages as USD or invent a dollar
 * cap. This is account-wide, so different keys for one account share limits.
 */

import { fetchWithTimeout, parseResetTime, U } from "./shared.js";

const { url: ALLOWANCE_URL } = U("tokenharbor");
const REQUEST_TIMEOUT_MS = 10000;

function percent(value) {
  const parsed = typeof value === "number" ? value :
    typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function positiveRequestCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function compactModelList(value) {
  if (!Array.isArray(value)) return [];
  // The live API can use bare ids (no :free suffix). Return the actual ids,
  // without rewriting them or granting any model entitlement on the router.
  const seen = new Set();
  const models = [];
  for (const model of value) {
    if (typeof model !== "string") continue;
    const id = model.trim();
    if (!id || id.length > 160 || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length === 100) break;
  }
  return models;
}

function validIsoDate(value) {
  if (!value) return null;
  const parsed = parseResetTime(value);
  return parsed && Number.isFinite(new Date(parsed).getTime()) ? parsed : null;
}

/**
 * Normalize only the documented contract fields. The endpoint also returns
 * experimental/internal fields (rpm_limit, unlocked, buffer_pct, etc.), which
 * must not become user-visible quota amounts or new client-side assumptions.
 */
export function normalizeTokenHarborAllowance(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const usedPct = percent(data.used_pct);
  if (usedPct === null) return null;

  const activePlan = data.on_plan === true;
  const planUsedPct = activePlan ? percent(data.plan_used_pct) : null;
  const activated = data.activated === true ? true : data.activated === false ? false : null;
  const resetAt = activated === false ? null : validIsoDate(data.reset_at ?? data.period_ends_at);
  const freeExhausted = data.exhausted === true;
  const passExhausted = data.plan_exhausted === true;
  const planName = activePlan && typeof data.plan_name === "string" && data.plan_name.trim()
    ? data.plan_name.trim().slice(0, 100)
    : "Token Harbor Free";

  const quotas = {
    "Free models (7d)": {
      used: usedPct,
      total: 100,
      remainingPercentage: freeExhausted ? 0 : 100 - usedPct,
      resetAt,
      unit: "%",
    },
  };

  if (activePlan && planUsedPct !== null) {
    quotas["Pass allowance (7d)"] = {
      used: planUsedPct,
      total: 100,
      remainingPercentage: passExhausted ? 0 : 100 - planUsedPct,
      resetAt,
      unit: "%",
    };
  }

  return {
    plan: planName,
    quotas,
    tokenharbor: {
      activated,
      resetAt,
      freeUsedPct: usedPct,
      freeExhausted,
      freeModelsEnabled: data.models_enabled === true ? true : data.models_enabled === false ? false : null,
      models: compactModelList(data.models),
      requestsUsed: positiveRequestCount(data.req_used),
      onPlan: activePlan,
      planName: activePlan ? planName : null,
      passUsedPct: planUsedPct,
      passExhausted: activePlan && passExhausted,
    },
  };
}

export async function getTokenHarborUsage(apiKey = null, proxyOptions = null, fetcher = fetchWithTimeout) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { message: "Token Harbor API key not available. Add a key to view free-tier quota." };

  try {
    const response = await fetcher(ALLOWANCE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }, REQUEST_TIMEOUT_MS, proxyOptions);

    if (response.status === 401) {
      return { message: "Token Harbor API key is invalid, expired or revoked (HTTP 401)." };
    }
    if (response.status === 403) {
      // Provider documents 403 for an email address that needs verification.
      const body = await response.json().catch(() => null);
      return { message: body?.error === "email_verification_required"
        ? "Token Harbor requires email verification before quota can be queried (HTTP 403)."
        : "Token Harbor denied access to free-tier allowance (HTTP 403)." };
    }
    if (!response.ok) {
      return { message: `Token Harbor allowance endpoint returned HTTP ${response.status}.` };
    }

    const payload = await response.json().catch(() => null);
    return normalizeTokenHarborAllowance(payload)
      ?? { message: "Token Harbor returned an invalid free-tier allowance response." };
  } catch {
    // Do not log/expose the key, response body or proxy credentials.
    return { message: "Token Harbor allowance request failed. Check your network/proxy and retry." };
  }
}
