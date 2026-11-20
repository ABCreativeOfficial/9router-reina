/**
 * Shared, read-only Xingchi API-key probe for Add Key and saved-connection
 * tests. /v1/usage is authenticated and was verified with a real key; the
 * model catalog is a fallback, not the sole proof of account access.
 * No inference request, quota consumption, or logging of credentials.
 */
import { CODEX_CLI_VERSION } from "../config/codexModels.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { parseXingchiCatalog } from "./xingchiModels.js";

const TIMEOUT_MS = 10000;

function probeError(status) {
  if (status === 401) return "Xingchi API key is invalid or expired (401)";
  if (status === 403) return "Xingchi rejected this key or client (403); check access permissions";
  return `Xingchi verification returned HTTP ${status}`;
}

function authFailure(status) {
  return status === 401 || status === 403;
}

/**
 * @param {string} apiKey
 * @param {{fetchFn?: Function, proxyOptions?: object}} options
 * @returns {Promise<{valid: boolean, error: string|null, inconclusive?: boolean}>}
 */
export async function probeXingchiApiKey(apiKey, { fetchFn = proxyAwareFetch, proxyOptions = null } = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { valid: false, error: "Xingchi API key is required" };

  const config = PROVIDERS.xingchi;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
    ...(config.headers || {}),
  };
  const requestOptions = () => ({
    method: "GET",
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let lastError = "Xingchi verification endpoint is unavailable";

  // Authenticated account usage verifies the *key* without making a model
  // call. A 200 response with isValid:false is still a rejected credential.
  try {
    const usage = await fetchFn(config.usage.url, requestOptions(), proxyOptions);
    if (authFailure(usage.status)) return { valid: false, error: probeError(usage.status) };
    if (usage.ok) {
      const data = await usage.json().catch(() => null);
      if (data?.isValid === false || data?.error) {
        return { valid: false, error: "Xingchi rejected the API key" };
      }
      if (data?.isValid === true) return { valid: true, error: null };
      lastError = "Xingchi usage returned an unrecognized response";
    } else {
      lastError = probeError(usage.status);
    }
  } catch {
    lastError = "Xingchi usage endpoint could not be reached";
  }

  // Older installations may not implement /v1/usage. Match Codex's catalog
  // client_version/header flow as a non-consuming fallback, and require an
  // actual model list (not just an arbitrary 200 response).
  try {
    const url = new URL(config.validateUrl);
    url.searchParams.set("client_version", CODEX_CLI_VERSION);
    const models = await fetchFn(url.toString(), requestOptions(), proxyOptions);
    if (authFailure(models.status)) return { valid: false, error: probeError(models.status) };
    if (models.ok) {
      const data = await models.json().catch(() => null);
      if (parseXingchiCatalog(data).length > 0) return { valid: true, error: null };
      lastError = "Xingchi model catalog returned no usable models";
    } else {
      lastError = probeError(models.status);
    }
  } catch {
    // Preserve the more specific usage failure when the catalog also fails.
  }

  return { valid: false, error: lastError, inconclusive: true };
}
