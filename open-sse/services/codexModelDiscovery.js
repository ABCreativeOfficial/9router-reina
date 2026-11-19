/**
 * Account-scoped Codex model discovery. Codex itself loads /codex/models and
 * caches the response; this bridge does the same for model pickers and routing.
 * The bundled catalog remains available if discovery is offline.
 */
import { createHash } from "node:crypto";
import {
  CODEX_CLI_VERSION,
  CODEX_EXTENDED_CONTEXT_WINDOW,
  CODEX_KNOWN_MODEL_IDS,
  CODEX_MODEL_CAPABILITIES,
  CODEX_PUBLIC_MODEL_IDS,
  buildCodexChatModelEntries,
} from "../config/codexModels.js";
import { getProviderModels } from "../config/providerModels.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const CATALOG_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLI_VERSION}`;
const CACHE_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const VALID_SLUG = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const cacheByAccount = new Map();

const numeric = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

/** Translate the official model metadata; omit hidden/non-chat entries. */
export function parseCodexCatalog(data) {
  const rows = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
  const seen = new Set();
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const slug = item.slug || item.id;
    if (typeof slug !== "string" || !VALID_SLUG.test(slug) || seen.has(slug)) return [];
    if (item.visibility !== "list" || item.supported_in_api !== true) return [];
    seen.add(slug);

    const previous = CODEX_MODEL_CAPABILITIES[slug];
    const levels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
        .map((level) => typeof level === "string" ? level : level?.effort)
        .filter((level) => ["low", "medium", "high", "xhigh", "max", "ultra"].includes(level))
      : [];
    const reasoning = [...new Set(levels.length ? levels : previous?.reasoning || ["low", "medium", "high", "xhigh"])];
    const displayName = item.display_name || previous?.displayName || slug;
    const contextWindow = numeric(item.context_window, previous?.contextWindow || 272000);
    const maxContext = numeric(item.max_context_window, contextWindow);
    const fast = Array.isArray(item.service_tiers)
      ? item.service_tiers.some((tier) => tier?.id === "priority")
      : previous?.fast === true;
    const caps = {
      name: displayName.replace(/-/g, " "),
      displayName,
      defaultReasoning: reasoning.includes(item.default_reasoning_level)
        ? item.default_reasoning_level
        : previous?.defaultReasoning || reasoning[0],
      reasoning,
      fast,
      responsesLite: item.use_responses_lite === true || (item.use_responses_lite === undefined && previous?.responsesLite === true),
      extendedContext: maxContext >= CODEX_EXTENDED_CONTEXT_WINDOW,
      contextWindow,
      maxOutput: numeric(item.max_output_tokens, previous?.maxOutput || 128000),
      vision: Array.isArray(item.input_modalities)
        ? item.input_modalities.includes("image") : previous?.vision === true,
    };
    return [{ slug, caps }];
  });
}

/** Update the shared registry in place so existing module imports see new ids. */
export function registerCodexCatalogModels(catalog) {
  const models = getProviderModels("cx");
  for (const { slug, caps } of catalog) {
    const existing = CODEX_MODEL_CAPABILITIES[slug];
    const oldIds = existing ? new Set(buildCodexChatModelEntries(slug, existing).map((m) => m.id)) : null;
    if (oldIds) {
      for (let i = models.length - 1; i >= 0; i--) {
        if (oldIds.has(models[i].id)) models.splice(i, 1);
      }
    }
    CODEX_MODEL_CAPABILITIES[slug] = caps;
    if (!CODEX_PUBLIC_MODEL_IDS.includes(slug)) CODEX_PUBLIC_MODEL_IDS.push(slug);
    if (!CODEX_KNOWN_MODEL_IDS.includes(slug)) CODEX_KNOWN_MODEL_IDS.push(slug);
    models.push(...buildCodexChatModelEntries(slug, caps));
  }
}

function accountKey(credentials, token) {
  const id = credentials?.providerSpecificData?.workspaceId
    || credentials?.providerSpecificData?.chatgptAccountId
    || credentials?.providerSpecificData?.accountId
    || credentials?.connectionId || credentials?.id;
  // Never retain raw OAuth access tokens in an in-memory map key.
  return id ? String(id) : createHash("sha256").update(token).digest("hex");
}

/** Fetch once per account per TTL, sharing concurrent requests. Fails open. */
export async function resolveCodexLiveModels(credentials, { forceRefresh = false, proxyOptions = null } = {}) {
  const token = credentials?.accessToken;
  if (!token) return { models: [], warning: "No Codex access token" };
  const key = accountKey(credentials, token);
  const previous = cacheByAccount.get(key);
  if (previous?.pending) return previous.pending;
  if (!forceRefresh && previous?.expiresAt > Date.now()) return previous.result;

  const pending = (async () => {
    try {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        originator: "codex_cli_rs",
        "User-Agent": `codex_cli_rs/${CODEX_CLI_VERSION}`,
      };
      const accountId = credentials?.providerSpecificData?.workspaceId
        || credentials?.providerSpecificData?.chatgptAccountId
        || credentials?.providerSpecificData?.accountId;
      if (accountId) headers["ChatGPT-Account-ID"] = accountId;
      const response = await proxyAwareFetch(CATALOG_URL, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }, proxyOptions);
      if (!response.ok) throw Object.assign(new Error(`Codex model catalog HTTP ${response.status}`), { status: response.status });
      const catalog = parseCodexCatalog(await response.json());
      if (!catalog.length) throw new Error("Codex model catalog returned no visible models");
      registerCodexCatalogModels(catalog);
      const result = { models: catalog.flatMap(({ slug, caps }) => buildCodexChatModelEntries(slug, caps)) };
      cacheByAccount.set(key, { result, expiresAt: Date.now() + CACHE_MS });
      return result;
    } catch (error) {
      const result = previous?.result?.models?.length
        ? previous.result
        : { models: [], warning: error.message, status: error.status };
      cacheByAccount.set(key, { result, expiresAt: Date.now() + RETRY_MS });
      return result;
    }
  })();
  cacheByAccount.set(key, { ...previous, pending });
  return pending;
}
