import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null, directFetch = null, requestContext = null, requestPolicy = null, recoverRequest = null, redirect = undefined }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      let transformedBody = this.transformRequest(model, body, stream, credentials);
      if (typeof this.prepareRequest === "function") {
        transformedBody = this.prepareRequest(transformedBody, { model, requestContext, requestPolicy, log });
      }
      let headers = this.buildHeaders(credentials, stream, url, model, transformedBody);
      // User per-provider override wins over registry headers (blocked names filtered at the API)
      if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);
      // Optional post-override hook. buildHeaders runs before the merge, so an
      // executor that owns a required header family must re-assert it here —
      // otherwise an override written in a different case leaves two keys and
      // the fetch layer joins them into one comma-separated value.
      if (typeof this.finalizeHeaders === "function") {
        headers = this.finalizeHeaders(headers, {
          credentials,
          body: transformedBody,
          model,
          url,
          stream,
          providerOverrides,
        }) || headers;
      }

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within connection timeout
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal,
          ...(redirect ? { redirect } : {}),
          // Protocol adapters that need their own transport (opencode's TLS
          // fingerprint) override the direct path; proxies still take priority.
          ...(directFetch ? { directFetch } : {}),
        }, proxyOptions);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        // Provider-specific terminal request errors bypass generic retries. Inspect
        // only error bodies; never consume or buffer a successful SSE stream here.
        if (!response.ok && typeof this.prepareError === "function") {
          let errorBody = "";
          try { errorBody = await response.clone().text(); } catch { /* preserve original response */ }
          const preparedError = this.prepareError(response, errorBody);
          if (preparedError?.terminalRequestError) {
            let recoveredBody = null;
            if (typeof recoverRequest === "function" && preparedError.contextOverflow && requestContext && !requestContext.contextRecoveryTried) {
              requestContext.contextRecoveryTried = true;
              recoveredBody = await recoverRequest(response, transformedBody, preparedError);
            }
            if (recoveredBody && JSON.stringify(recoveredBody) !== JSON.stringify(transformedBody)) {
              const recoveryCtrl = new AbortController();
              const recoveryTimer = setTimeout(() => recoveryCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
              const recoverySignal = signal ? AbortSignal.any([signal, recoveryCtrl.signal]) : recoveryCtrl.signal;
              try {
                const recovered = await proxyAwareFetch(url, {
                  method: "POST", headers, body: JSON.stringify(recoveredBody), signal: recoverySignal,
                  ...(redirect ? { redirect } : {}),
                }, proxyOptions);
                await response.body?.cancel?.().catch?.(() => {});
                return { response: recovered, url, headers, transformedBody: recoveredBody, contextRecoveryRetry: true };
              } catch (error) {
                // A failed recovery attempt is terminal: return the original
                // upstream context error instead of retrying the same payload.
                log?.warn?.("CONTEXT", `codebuddy-intl recovery request failed: ${error.message}`);
                return { response, url, headers, transformedBody, contextRecoveryRetry: true };
              } finally {
                clearTimeout(recoveryTimer);
              }
            }
            return { response, url, headers, transformedBody, terminalRequestError: true };
          }
        }

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
