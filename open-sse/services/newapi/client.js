import { proxyAwareFetch } from "../../utils/proxyFetch.js";

/**
 * Reusable New API management client (custom fork).
 *
 * QuantumNous/new-api deployments share one management surface: a
 * `{success, message, data}` envelope, `Authorization: Bearer <user token>` plus
 * `New-Api-User: <numeric id>` headers, and the same account/token/model routes.
 * This module holds that shared behavior; a deployment supplies its trusted
 * origin, label, and any endpoint/parsing quirks.
 *
 * The origin always comes from server-side configuration — never from a browser
 * request — so no caller can point management traffic at an arbitrary host.
 */

const DEFAULT_USER_AGENT = "9Router";
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_USER_ID_LENGTH = 64;
const MAX_TOKEN_LENGTH = 8192;

/** Default New API paths. A deployment may override any of them. */
export const NEW_API_DEFAULT_PATHS = Object.freeze({
  status: "/api/status",
  managementToken: "/api/user/token",
  account: "/api/user/self",
  models: "/api/user/models",
  usage: "/api/data/self",
  tokens: "/api/token/",
  inferenceModels: "/v1/models",
});

export function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  return cleaned.length <= maxLength ? cleaned : "";
}

/** New API account ids are numeric; anything else is not an identity. */
export function normalizeNewApiUserId(value) {
  const cleaned = cleanString(String(value ?? ""), MAX_USER_ID_LENGTH);
  return /^\d+$/.test(cleaned) ? cleaned : "";
}

/** A masked key (New API returns `abcd**********wxyz`) is never a usable credential. */
export function isMaskedNewApiKey(value) {
  return typeof value === "string" && value.includes("*");
}

function normalizeOrigin(origin) {
  const cleaned = cleanString(origin, 256).replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(cleaned)) {
    throw new Error("New API deployment origin must be a bare https origin");
  }
  return cleaned;
}

function safeTokenMetadata(item) {
  if (!item || typeof item !== "object") return null;
  const id = Number(item.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    name: cleanString(item.name, 200) || `Token ${id}`,
    maskedKey: cleanString(item.key, 200),
    status: Number(item.status),
    group: cleanString(item.group, 100),
    unlimitedQuota: item.unlimited_quota === true,
    modelLimitsEnabled: item.model_limits_enabled === true,
    remainQuota: Number.isFinite(Number(item.remain_quota)) ? Number(item.remain_quota) : null,
    usedQuota: Number.isFinite(Number(item.used_quota)) ? Number(item.used_quota) : null,
  };
}

/** Default `/api/user/models` shape: a bare string array. */
function parseModelIdList(data) {
  if (!Array.isArray(data)) return null;
  const ids = Array.from(new Set(
    data.filter((id) => typeof id === "string").map((id) => id.trim()).filter(Boolean),
  ));
  return ids.map((id) => ({ id, name: id }));
}

/** Default account normalization; a deployment may extend it. */
function parseAccount(raw, normalizedUserId) {
  return {
    id: normalizedUserId,
    displayName: cleanString(raw.display_name, 200),
    username: cleanString(raw.username, 200),
    group: cleanString(raw.group, 100),
    status: raw.status,
    quota: Number(raw.quota),
    usedQuota: Number(raw.used_quota),
    requestCount: Number(raw.request_count),
  };
}

/**
 * Build a management client for one New API deployment.
 *
 * @param {object} config
 * @param {string} config.origin      trusted https origin (server-side only)
 * @param {string} config.label       user-facing deployment name, used in messages
 * @param {object} [config.paths]     endpoint overrides, merged over NEW_API_DEFAULT_PATHS
 * @param {string} [config.userAgent]
 * @param {number} [config.timeoutMs]
 * @param {number} [config.activeStatus=1] account `status` value meaning "usable"
 * @param {number} [config.tokenPageSize=100]
 * @param {(raw: object, id: string) => object} [config.parseAccount]
 * @param {(data: unknown) => Array|null} [config.parseModels]
 */
export function createNewApiClient(config) {
  const origin = normalizeOrigin(config?.origin);
  const label = cleanString(config?.label, 100) || "New API";
  const paths = { ...NEW_API_DEFAULT_PATHS, ...(config?.paths || {}) };
  const userAgent = cleanString(config?.userAgent, 200) || DEFAULT_USER_AGENT;
  const timeoutMs = Number.isFinite(config?.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const activeStatus = Number.isFinite(config?.activeStatus) ? config.activeStatus : 1;
  const tokenPageSize = Number.isFinite(config?.tokenPageSize) ? config.tokenPageSize : 100;
  const accountParser = typeof config?.parseAccount === "function" ? config.parseAccount : parseAccount;
  const modelParser = typeof config?.parseModels === "function" ? config.parseModels : parseModelIdList;

  const endpoints = Object.freeze(
    Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, `${origin}${path}`])),
  );

  const managementHeaders = (accessToken, userId) => ({
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "New-Api-User": userId,
    "User-Agent": userAgent,
  });

  async function requestJson(url, { accessToken, userId, method = "GET", proxyOptions = null } = {}) {
    const token = cleanString(accessToken, MAX_TOKEN_LENGTH);
    const normalizedUserId = normalizeNewApiUserId(userId);
    if (!token || !normalizedUserId) {
      return { ok: false, status: 400, message: `${label} management credentials are required.` };
    }

    try {
      const response = await proxyAwareFetch(url, {
        method,
        headers: managementHeaders(token, normalizedUserId),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }, proxyOptions);
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success !== true) {
        return {
          ok: false,
          status: response.status,
          message: response.status === 401 || response.status === 403
            ? `${label} management authentication failed.`
            : `${label} API request failed.`,
        };
      }
      return { ok: true, status: response.status, data: payload.data };
    } catch {
      return { ok: false, status: 502, message: `Unable to reach ${label}.` };
    }
  }

  async function getAccount(accessToken, userId, proxyOptions = null) {
    const normalizedUserId = normalizeNewApiUserId(userId);
    const result = await requestJson(endpoints.account, {
      accessToken,
      userId: normalizedUserId,
      proxyOptions,
    });
    if (!result.ok) return result;

    const raw = result.data;
    if (!raw || typeof raw !== "object") {
      return { ok: false, status: 502, message: `${label} returned an invalid account response.` };
    }
    // The server-side id is authoritative: a caller cannot claim another account.
    if (normalizeNewApiUserId(raw.id) !== normalizedUserId) {
      return { ok: false, status: 403, message: `${label} account ID does not match.` };
    }
    if (raw.status !== activeStatus) {
      return { ok: false, status: 403, message: `${label} account is disabled.` };
    }

    return { ok: true, account: accountParser(raw, normalizedUserId) };
  }

  async function listTokens(accessToken, userId, proxyOptions = null) {
    const result = await requestJson(`${endpoints.tokens}?p=1&size=${tokenPageSize}`, {
      accessToken,
      userId,
      proxyOptions,
    });
    if (!result.ok) return result;
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    return { ok: true, tokens: items.map(safeTokenMetadata).filter(Boolean) };
  }

  async function retrieveTokenKey(accessToken, userId, tokenId, proxyOptions = null) {
    const id = Number(tokenId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { ok: false, status: 400, message: `Selected ${label} token is invalid.` };
    }

    const result = await requestJson(`${endpoints.tokens}${id}/key`, {
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
    if (!key || isMaskedNewApiKey(key)) {
      return { ok: false, status: 502, message: `Selected ${label} token is unavailable.` };
    }
    return { ok: true, apiKey: key };
  }

  /** Prove a retrieved key actually authenticates against the inference surface. */
  async function validateInferenceKey(apiKey, proxyOptions = null) {
    const key = cleanString(apiKey, MAX_TOKEN_LENGTH);
    if (!key) return { ok: false, status: 400, message: `${label} API key is required.` };
    try {
      const response = await proxyAwareFetch(endpoints.inferenceModels, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${key}`,
          "User-Agent": userAgent,
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }, proxyOptions);
      if (!response.ok) {
        return { ok: false, status: response.status, message: `Selected ${label} token is unavailable.` };
      }
      return { ok: true };
    } catch {
      return { ok: false, status: 502, message: `Unable to validate ${label} API key.` };
    }
  }

  async function fetchModels(accessToken, userId, proxyOptions = null) {
    const result = await requestJson(endpoints.models, { accessToken, userId, proxyOptions });
    if (!result.ok) return result;
    const models = modelParser(result.data);
    if (!models) {
      return { ok: false, status: 502, message: `${label} returned an invalid model list.` };
    }
    return { ok: true, models };
  }

  /** Public deployment config (quota display type, quota_per_unit, exchange rates). */
  async function fetchStatus(proxyOptions = null) {
    try {
      const response = await proxyAwareFetch(endpoints.status, {
        headers: { Accept: "application/json", "User-Agent": userAgent },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }, proxyOptions);
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success !== true || !payload.data) return null;
      return payload.data;
    } catch {
      return null;
    }
  }

  return {
    origin,
    label,
    endpoints,
    activeStatus,
    requestJson,
    getAccount,
    listTokens,
    retrieveTokenKey,
    validateInferenceKey,
    fetchModels,
    fetchStatus,
  };
}
