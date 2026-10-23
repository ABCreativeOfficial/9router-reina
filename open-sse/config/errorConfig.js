// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Account-level restriction (CodeBuddy 11140 / "unusual activity"): upstream has
// frozen the *account*, not the request. Reported blocks lasted 11h+ and users
// describe them as bans (#5041, #5001); the fix is an official recovery, not a
// retry. Finite on purpose — the lock is visible in the dashboard and clearable,
// and an infinite one would survive a genuine upstream unban.
export const ACCOUNT_RESTRICTED_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Message markers CodeBuddyIntlExecutor.parseError() writes into its diagnostic
// text. ERROR_RULES matches on message text, so both sides share this vocabulary
// instead of each duplicating the other's prose: the executor imports the marker,
// the rule below matches it, and a reworded message cannot silently stop matching.
export const CODEBUDDY_CHANNEL_MARKER = "codebuddy channel verification";
export const CODEBUDDY_ACCOUNT_RESTRICTED_MARKER = "codebuddy account restricted";
export const CODEBUDDY_CONTEXT_OVERFLOW_MARKER = "codebuddy-intl context_overflow request-scoped";

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- CodeBuddy Intl. Both markers are emitted only by that executor's
  // parseError(), so matching on them cannot catch another provider's error.
  // No `provider` field on purpose: the account-selection path calls
  // checkFallbackError with the resolved provider id, while the combo path calls
  // it without one — a provider-scoped rule would silently stop applying there.
  //
  // 11140: the account is frozen, and no retry, account fallback or header change
  // clears it (#5041 measured both accounts gated identically). Lock the account
  // out of rotation for a long, finite window instead of re-firing refused
  // requests at it. `accountScoped` makes the lock cover every model, because
  // every model on a frozen account is refused identically.
  { text: CODEBUDDY_ACCOUNT_RESTRICTED_MARKER, cooldownMs: ACCOUNT_RESTRICTED_COOLDOWN_MS, accountScoped: true },
  // 11128 channel verification: provider-scoped, NOT request-scoped. #5024 shows
  // the identical payload succeeding minutes later while every session stays
  // blocked — the account is not healthy, so keeping it in rotation is what keeps
  // it broken. Without this rule the 400 lands in the unmatched-4xx catch-all at
  // cooldownMs 0, so the block never gets a chance to expire. The overloaded
  // sibling "first message is not system prompt" is genuinely request-scoped and
  // carries no marker, so it keeps cooldownMs 0.
  { text: CODEBUDDY_CHANNEL_MARKER, backoff: true, accountScoped: true },

  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  // Intl gateway blocks affect the account/IP, so let the connection back off.
  { provider: "codebuddy-intl", text: "request illegal", backoff: true },
  { provider: "codebuddy-intl", text: "conversation id missing", backoff: true },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "insufficient credit",      backoff: true },
  { text: "credit balance is too low", backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
