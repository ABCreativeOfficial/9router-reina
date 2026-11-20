/**
 * Xingchi API-key model discovery, modeled after Codex's model_catalog_url flow:
 * GET the configured catalog endpoint with Bearer credentials and Codex request
 * headers, cache successful catalogs per key, and retain the last good catalog
 * when a refresh fails. Never cache or log API-key plaintext.
 */
import { createHash } from "node:crypto";
import { CODEX_CLI_VERSION } from "../config/codexModels.js";
import { getProviderModels } from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const CACHE_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 8000;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const cache = new Map();

export function parseXingchiCatalog(data) {
  // /v1/models normally returns {data:[{id}]}; Codex-native catalogs return
  // {models:[{slug,display_name}]}. Some compatible gateways return an object map.
  const source = Array.isArray(data) ? data : data?.data ?? data?.models ?? data?.results;
  const entries = Array.isArray(source)
    ? source
    : source && typeof source === "object"
      ? Object.entries(source).map(([key, info]) => typeof info === "object" && info !== null ? { id: key, ...info } : { id: key })
      : [];
  const seen = new Set();
  return entries.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = item.slug || item.id || item.model || item.model_id;
    if (typeof id !== "string" || !MODEL_ID.test(id) || seen.has(id)) return [];
    if (item.visibility === "hide" || item.supported_in_api === false) return [];
    seen.add(id);
    const name = item.display_name || item.displayName || item.name || id;
    const contextWindow = item.context_window || item.contextWindow || item.limit?.context;
    const maxOutput = item.max_output_tokens || item.maxOutput || item.limit?.output;
    return [{
      id,
      name: typeof name === "string" ? name : id,
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(Number.isFinite(maxOutput) && maxOutput > 0 ? { maxOutput } : {}),
    }];
  });
}

const offlineModels = () => getProviderModels("xc").map((model) => ({ ...model }));

export async function resolveXingchiModels(connection, {
  forceRefresh = false,
  proxyOptions = null,
  fetchFn = proxyAwareFetch,
} = {}) {
  const apiKey = connection?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { models: offlineModels(), warning: "Xingchi API key is not configured." };
  }

  const key = createHash("sha256").update(apiKey).digest("hex");
  const existing = cache.get(key);
  if (existing?.pending) return existing.pending;
  if (!forceRefresh && existing?.expiresAt > Date.now()) return existing.result;

  const pending = (async () => {
    try {
      const url = new URL(PROVIDERS.xingchi.validateUrl);
      url.searchParams.set("client_version", CODEX_CLI_VERSION);
      const response = await fetchFn(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...PROVIDERS.xingchi.headers,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }, proxyOptions);
      if (!response.ok) throw new Error(`Xingchi model catalog HTTP ${response.status}`);
      const models = parseXingchiCatalog(await response.json());
      if (models.length === 0) throw new Error("Xingchi model catalog returned no usable model IDs");
      const result = { models };
      cache.set(key, { result, expiresAt: Date.now() + CACHE_MS });
      return result;
    } catch (error) {
      const fallback = existing?.result?.models?.length ? existing.result.models : offlineModels();
      const result = { models: fallback, warning: `Live catalog unavailable: ${error.message}. Using saved or built-in models.` };
      cache.set(key, { result, expiresAt: Date.now() + RETRY_MS });
      return result;
    }
  })();
  cache.set(key, { ...existing, pending });
  return pending;
}

export function clearXingchiCatalogCacheForTests() {
  cache.clear();
}
