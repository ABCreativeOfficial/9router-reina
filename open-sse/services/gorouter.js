import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const GOROUTER_ORIGIN = "https://gorouter.app";
export const GOROUTER_ENDPOINTS = Object.freeze({
  status: `${GOROUTER_ORIGIN}/api/status`,
  managementToken: `${GOROUTER_ORIGIN}/api/user/token`,
  account: `${GOROUTER_ORIGIN}/api/user/self`,
  models: `${GOROUTER_ORIGIN}/api/user/models`,
  usage: `${GOROUTER_ORIGIN}/api/data/self`,
  tokens: `${GOROUTER_ORIGIN}/api/token/`,
});

const USER_AGENT = "9Router";
const TIMEOUT_MS = 10000;
const MAX_USER_ID_LENGTH = 64;
const MAX_TOKEN_LENGTH = 8192;

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  return cleaned.length <= maxLength ? cleaned : "";
}

export function normalizeGoRouterUserId(value) {
  const cleaned = cleanString(String(value ?? ""), MAX_USER_ID_LENGTH);
  return /^\d+$/.test(cleaned) ? cleaned : "";
}

function managementHeaders(accessToken, userId) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "New-Api-User": userId,
    "User-Agent": USER_AGENT,
  };
}

async function requestJson(url, { accessToken, userId, method = "GET", proxyOptions = null } = {}) {
  const token = cleanString(accessToken, MAX_TOKEN_LENGTH);
  const normalizedUserId = normalizeGoRouterUserId(userId);
  if (!token || !normalizedUserId) {
    return { ok: false, status: 400, message: "GoRouter management credentials are required." };
  }

  try {
    const response = await proxyAwareFetch(url, {
      method,
      headers: managementHeaders(token, normalizedUserId),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, proxyOptions);
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      return {
        ok: false,
        status: response.status,
        message: response.status === 401 || response.status === 403
          ? "GoRouter management authentication failed."
          : "GoRouter API request failed.",
      };
    }
    return { ok: true, status: response.status, data: payload.data };
  } catch {
    return { ok: false, status: 502, message: "Unable to reach GoRouter." };
  }
}

export async function getGoRouterAccount(accessToken, userId, proxyOptions = null) {
  const normalizedUserId = normalizeGoRouterUserId(userId);
  const result = await requestJson(GOROUTER_ENDPOINTS.account, {
    accessToken,
    userId: normalizedUserId,
    proxyOptions,
  });
  if (!result.ok) return result;

  const account = result.data;
  if (!account || typeof account !== "object") {
    return { ok: false, status: 502, message: "GoRouter returned an invalid account response." };
  }
  if (normalizeGoRouterUserId(account.id) !== normalizedUserId) {
    return { ok: false, status: 403, message: "GoRouter account ID does not match." };
  }
  if (account.status !== 1) {
    return { ok: false, status: 403, message: "GoRouter account is disabled." };
  }

  return {
    ok: true,
    account: {
      id: normalizedUserId,
      displayName: cleanString(account.display_name, 200),
      group: cleanString(account.group, 100),
      status: account.status,
      quota: Number(account.quota),
      usedQuota: Number(account.used_quota),
      requestCount: Number(account.request_count),
    },
  };
}

export async function validateGoRouterManagementCredentials(accessToken, userId, proxyOptions = null) {
  return getGoRouterAccount(accessToken, userId, proxyOptions);
}

function safeTokenMetadata(item) {
  if (!item || typeof item !== "object") return null;
  const id = Number(item.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const maskedKey = cleanString(item.key, 200);
  return {
    id,
    name: cleanString(item.name, 200) || `Token ${id}`,
    maskedKey,
    status: Number(item.status),
    group: cleanString(item.group, 100),
    unlimitedQuota: item.unlimited_quota === true,
    modelLimitsEnabled: item.model_limits_enabled === true,
    remainQuota: Number.isFinite(Number(item.remain_quota)) ? Number(item.remain_quota) : null,
    usedQuota: Number.isFinite(Number(item.used_quota)) ? Number(item.used_quota) : null,
  };
}

export function isMaskedGoRouterKey(value) {
  return typeof value === "string" && value.includes("*");
}

export async function listGoRouterTokens(accessToken, userId, proxyOptions = null) {
  const result = await requestJson(`${GOROUTER_ENDPOINTS.tokens}?p=1&size=100`, {
    accessToken,
    userId,
    proxyOptions,
  });
  if (!result.ok) return result;
  const items = Array.isArray(result.data?.items) ? result.data.items : [];
  return { ok: true, tokens: items.map(safeTokenMetadata).filter(Boolean) };
}

export async function retrieveGoRouterTokenKey(accessToken, userId, tokenId, proxyOptions = null) {
  const id = Number(tokenId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, status: 400, message: "Selected GoRouter token is invalid." };
  }

  const result = await requestJson(`${GOROUTER_ENDPOINTS.tokens}${id}/key`, {
    accessToken,
    userId,
    method: "POST",
    proxyOptions,
  });
  if (!result.ok) return result;

  const key = typeof result.data === "string"
    ? result.data.trim()
    : typeof result.data?.key === "string"
      ? result.data.key.trim()
      : "";
  if (!key || isMaskedGoRouterKey(key)) {
    return { ok: false, status: 502, message: "Selected GoRouter token is unavailable." };
  }
  return { ok: true, apiKey: key };
}

export async function validateGoRouterInferenceKey(apiKey, proxyOptions = null) {
  const key = cleanString(apiKey, MAX_TOKEN_LENGTH);
  if (!key) return { ok: false, status: 400, message: "GoRouter API key is required." };
  try {
    const response = await proxyAwareFetch(`${GOROUTER_ORIGIN}/v1/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
        "User-Agent": USER_AGENT,
      },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, proxyOptions);
    if (!response.ok) {
      return { ok: false, status: response.status, message: "Selected GoRouter token is unavailable." };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 502, message: "Unable to validate GoRouter API key." };
  }
}

export async function fetchGoRouterModels(accessToken, userId, proxyOptions = null) {
  const result = await requestJson(GOROUTER_ENDPOINTS.models, {
    accessToken,
    userId,
    proxyOptions,
  });
  if (!result.ok) return result;
  if (!Array.isArray(result.data)) {
    return { ok: false, status: 502, message: "GoRouter returned an invalid model list." };
  }

  const ids = Array.from(new Set(
    result.data
      .filter((id) => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean),
  ));
  return { ok: true, models: ids.map((id) => ({ id, name: id })) };
}

export async function fetchGoRouterStatus(proxyOptions = null) {
  try {
    const response = await proxyAwareFetch(GOROUTER_ENDPOINTS.status, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, proxyOptions);
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true || !payload.data) return null;
    return payload.data;
  } catch {
    return null;
  }
}
