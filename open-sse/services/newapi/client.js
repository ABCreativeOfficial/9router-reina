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
  checkin: "/api/user/checkin",
  affiliateTransfer: "/api/user/aff_transfer",
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

/** A New API timestamp is unix seconds; -1 on `expired_time` means "never". */
function optionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function isAlreadyCheckedIn(message) {
  return /already|checked[\s_-]*in\s+today|今日.*签|已.*签/i.test(String(message || ""));
}

function isVerificationRequired(message) {
  return /turnstile|captcha|verification|人机|验证/i.test(String(message || ""));
}

function normalizeCheckinRecord(record) {
  if (!record || typeof record !== "object") return null;
  const checkinDate = cleanString(record.checkin_date, 32);
  const quotaAwarded = optionalNumber(record.quota_awarded);
  if (!checkinDate) return null;
  return { checkinDate, quotaAwarded };
}

function normalizeCheckinStatus(data) {
  if (!data || typeof data !== "object") return null;
  const stats = data.stats && typeof data.stats === "object" ? data.stats : {};
  return {
    supported: true,
    enabled: data.enabled === true,
    checkedInToday: stats.checked_in_today === true,
    minQuota: optionalNumber(data.min_quota),
    maxQuota: optionalNumber(data.max_quota),
    checkinCount: optionalNumber(stats.checkin_count),
    totalCheckins: optionalNumber(stats.total_checkins),
    totalQuota: optionalNumber(stats.total_quota),
    records: Array.isArray(stats.records) ? stats.records.map(normalizeCheckinRecord).filter(Boolean) : [],
  };
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
    remainQuota: optionalNumber(item.remain_quota),
    usedQuota: optionalNumber(item.used_quota),
    // Selection metadata. Absent/garbage values stay null so the caller's sort
    // can fall back rather than treating a missing timestamp as epoch 0.
    expiredTime: optionalNumber(item.expired_time),
    accessedTime: optionalNumber(item.accessed_time),
    createdTime: optionalNumber(item.created_time),
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

function parseSelf(raw, normalizedUserId) {
  const hasReferralFields = ["aff_quota", "aff_history_quota", "aff_count"]
    .every((key) => Object.hasOwn(raw, key));
  return {
    userId: normalizedUserId,
    quota: optionalNumber(raw.quota),
    usedQuota: optionalNumber(raw.used_quota),
    referralSupported: hasReferralFields,
    affCode: cleanString(raw.aff_code, 200),
    affCount: optionalNumber(raw.aff_count),
    affQuota: optionalNumber(raw.aff_quota),
    affHistoryQuota: optionalNumber(raw.aff_history_quota),
  };
}

function sanitizeBusinessMessage(value, fallback) {
  const message = cleanString(value, 300);
  if (!message || /bearer|authorization|access[_ -]?token|refresh[_ -]?token|api[_ -]?key/i.test(message)) {
    return fallback;
  }
  return message;
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

  async function requestJson(url, { accessToken, userId, method = "GET", body = null, proxyOptions = null } = {}) {
    const token = cleanString(accessToken, MAX_TOKEN_LENGTH);
    const normalizedUserId = normalizeNewApiUserId(userId);
    if (!token || !normalizedUserId) {
      return { ok: false, status: 400, message: `${label} management credentials are required.` };
    }

    try {
      const headers = managementHeaders(token, normalizedUserId);
      if (body !== null) headers["Content-Type"] = "application/json";
      const response = await proxyAwareFetch(url, {
        method,
        headers,
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
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

  async function getSelf(accessToken, userId, proxyOptions = null) {
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
    if (normalizeNewApiUserId(raw.id) !== normalizedUserId) {
      return { ok: false, status: 403, message: `${label} account ID does not match.` };
    }
    return { ok: true, status: result.status, self: parseSelf(raw, normalizedUserId), raw };
  }

  async function getAccount(accessToken, userId, proxyOptions = null) {
    const normalizedUserId = normalizeNewApiUserId(userId);
    const result = await getSelf(accessToken, normalizedUserId, proxyOptions);
    if (!result.ok) return result;
    const raw = result.raw;
    if (raw.status !== activeStatus) {
      return { ok: false, status: 403, message: `${label} account is disabled.` };
    }
    return { ok: true, account: accountParser(raw, normalizedUserId) };
  }

  async function transferAffiliateQuota(accessToken, userId, quota, proxyOptions = null) {
    const amount = Number(quota);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { ok: false, status: 400, message: "Referral transfer amount must be a positive integer." };
    }

    const token = cleanString(accessToken, MAX_TOKEN_LENGTH);
    const normalizedUserId = normalizeNewApiUserId(userId);
    if (!token || !normalizedUserId) {
      return { ok: false, status: 400, message: `${label} management credentials are required.` };
    }

    try {
      const response = await proxyAwareFetch(endpoints.affiliateTransfer, {
        method: "POST",
        headers: {
          ...managementHeaders(token, normalizedUserId),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ quota: amount }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }, proxyOptions);
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success !== true) {
        const fallback = response.status === 401 || response.status === 403
          ? `${label} management authentication failed.`
          : `${label} referral transfer was refused.`;
        return {
          ok: false,
          status: response.status >= 400 ? response.status : 422,
          message: sanitizeBusinessMessage(payload?.message, fallback),
        };
      }
      return { ok: true, status: response.status };
    } catch {
      return {
        ok: false,
        status: 502,
        ambiguous: true,
        message: `${label} referral transfer result is unknown. Refresh before retrying.`,
      };
    }
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

  async function getCheckinStatus(accessToken, userId, proxyOptions = null) {
    const result = await requestJson(`${endpoints.checkin}?month=${encodeURIComponent(currentMonth())}`, {
      accessToken,
      userId,
      proxyOptions,
    });
    if (!result.ok) {
      return result.status === 404
        ? { ok: true, status: result.status, checkin: { supported: false } }
        : result;
    }
    const checkin = normalizeCheckinStatus(result.data);
    return checkin
      ? { ok: true, status: result.status, checkin }
      : { ok: false, status: 502, message: `${label} returned an invalid check-in response.` };
  }

  async function performCheckin(accessToken, userId, proxyOptions = null) {
    const token = cleanString(accessToken, MAX_TOKEN_LENGTH);
    const normalizedUserId = normalizeNewApiUserId(userId);
    if (!token || !normalizedUserId) {
      return { ok: false, status: 400, message: `${label} management credentials are required.` };
    }

    try {
      const response = await proxyAwareFetch(endpoints.checkin, {
        method: "POST",
        headers: managementHeaders(token, normalizedUserId),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }, proxyOptions);
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success === true) {
        return {
          ok: true,
          status: "success",
          checkedInToday: true,
          quotaAwarded: optionalNumber(payload.data?.quota_awarded),
        };
      }

      const message = cleanString(payload?.message, 500);
      if (isAlreadyCheckedIn(message)) {
        return { ok: true, status: "already_checked_in", checkedInToday: true };
      }
      if (isVerificationRequired(message)) {
        return { ok: true, status: "verification_required", checkedInToday: false };
      }
      return {
        ok: false,
        status: response.status,
        message: response.status === 401 || response.status === 403
          ? `${label} management authentication failed.`
          : `${label} check-in failed.`,
      };
    } catch {
      return { ok: false, status: 502, message: `Unable to reach ${label}.` };
    }
  }

  /**
   * Create a token dedicated to 9Router.
   *
   * Upstream `POST /api/token/` (QuantumNous/new-api `controller.AddToken`) returns
   * only `{success, message}` — no id and no key — so the caller must re-list and
   * match on the unique name it supplied. `expired_time: -1` means never expires;
   * `unlimited_quota: true` makes `remain_quota` irrelevant. `group: ""` inherits
   * the account's own group, so no deployment-specific group is hardcoded.
   * `model_limits`/`allow_ips` are upstream *strings*, not arrays.
   */
  async function createToken(accessToken, userId, { name, proxyOptions = null } = {}) {
    const tokenName = cleanString(name, 50);
    if (!tokenName) {
      return { ok: false, status: 400, message: `${label} token name is required.` };
    }
    const result = await requestJson(endpoints.tokens, {
      accessToken,
      userId,
      method: "POST",
      body: {
        name: tokenName,
        expired_time: -1,
        unlimited_quota: true,
        remain_quota: 0,
        model_limits_enabled: false,
        model_limits: "",
        allow_ips: "",
        group: "",
      },
      proxyOptions,
    });
    if (!result.ok) {
      return { ok: false, status: result.status || 502, message: `Unable to create a ${label} API token.` };
    }
    return { ok: true, name: tokenName };
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
    getSelf,
    getAccount,
    transferAffiliateQuota,
    listTokens,
    createToken,
    retrieveTokenKey,
    validateInferenceKey,
    fetchModels,
    getCheckinStatus,
    performCheckin,
    fetchStatus,
  };
}
