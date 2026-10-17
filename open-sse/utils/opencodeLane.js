// Shared policy for the OpenCode lanes (opencode / opencode-zen).
//
// ── The 429 has two causes, and they need opposite handling ──────────────
// Probed live on the free lane: 11 of 14 byte-identical
// `glm-5.3-flash-free` requests answered
//   429 {"error":{"type":"server_error","message":"Upstream request failed:
//        Endpoint is unavailable."}}
// and then three in a row succeeded, while a control model on the same lane was
// 6/6 clean. That is the GATEWAY ROUTE, not the account — the same request
// works a moment later, so a bounded retry turns the flake into an answer.
// A quota 429 (`FreeUsageLimitError`, "usage limit") is the opposite: it is
// account state, retrying only burns the window, and the caller's lock/fallback
// handling owns it. The retry hook vetoes it (false → BaseExecutor stops).
//
// Classification is separate from retry: BaseExecutor.tryRetry runs on the raw
// upstream status BEFORE parseError, so mapping the route 429 to a 503 for the
// client never changes which statuses get retried.
import { HTTP_STATUS } from "../config/runtimeConfig.js";

const MAX_RETRY_DELAY_MS = 3000;

// Bounded: `attempts` comes from the registry `retry` entry, so this only shapes
// the wait. Short waits keep a retried client request well inside its timeout.
export function opencodeRetryBackoff(attempt) {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

// Account state, not a transient route failure — never retry.
const RE_QUOTA_429 = /freeusagelimit|usage limit|quota/i;
// The gateway could not route the request. Retryable; not the caller's fault.
const RE_ROUTE_429 = /endpoint is unavailable|upstream request failed/i;

/**
 * BaseExecutor.computeRetryDelay hook.
 * @returns {number|false|undefined} delay in ms, false to veto the retry,
 *   undefined to use the configured delay (non-429 statuses).
 */
export async function computeOpencodeRetryDelay(response, attempt) {
  if (!response || response.status !== HTTP_STATUS.RATE_LIMITED) return undefined;
  let bodyText = "";
  try {
    bodyText = await response.clone().text();
  } catch {
    // Unreadable body: the free lane's dominant 429 is the route flake, so retry.
  }
  if (bodyText && RE_QUOTA_429.test(bodyText)) return false;
  return opencodeRetryBackoff(attempt);
}

/**
 * BaseExecutor.parseError hook.
 *
 * Classifies the gateway-route 429 in the message the client and the logs see,
 * while deliberately KEEPING the 429 status:
 *   - a client (Claude Code, any OpenAI SDK) treats 429 as retry-with-backoff,
 *     which is exactly right for a route flake; a 503 would tell it not to;
 *   - the account-lock path reads the status, and an unmatched 5xx takes the
 *     generic 30s transient cooldown while 429 takes the 2s rate-limit backoff.
 *     Claiming 503 here would lock a healthy keyed connection 15x longer for a
 *     failure that was never its fault.
 * Every other status keeps the default shape, so a genuine quota 429 still reads
 * as a rate limit.
 */
export function parseOpencodeError(response, bodyText) {
  const base = { status: response.status, message: bodyText || `HTTP ${response.status}` };
  if (response.status !== HTTP_STATUS.RATE_LIMITED || !bodyText) return base;
  if (RE_QUOTA_429.test(bodyText)) return base;
  if (!RE_ROUTE_429.test(bodyText)) return base;
  return {
    status: HTTP_STATUS.RATE_LIMITED,
    message:
      "OpenCode upstream route unavailable: the gateway answered 429 for this model after retries were "
      + "exhausted. This is a gateway-side routing/availability failure for the model, not this account's "
      + "rate limit — the same request succeeds moments later. Retry shortly or use another model. "
      + "Upstream said: " + bodyText.replace(/\s+/g, " ").slice(0, 300),
  };
}
