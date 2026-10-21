import { DefaultExecutor } from "./default.js";
import {
  ensureConversationHeaders,
  flattenContent,
} from "../utils/conversationHeaders.js";
import {
  CODEBUDDY_CHANNEL_MARKER,
  CODEBUDDY_ACCOUNT_RESTRICTED_MARKER,
} from "../config/errorConfig.js";
import {
  refreshCodebuddyIntlToken,
  REFRESH_UNAVAILABLE,
} from "../services/tokenRefresh.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 *
 * ## Channel verification (HTTP 400 code 11128 "conversation id missing")
 *
 * The intl gateway refuses a chat request that does not carry the official
 * client's conversation-correlation header family. A/B against the live gateway
 * (upstream PR #4944) shows the required set is exactly the three
 * `X-Conversation-*` headers — any two still answer 11128. `X-Request-ID` and
 * the W3C/B3 trace family are not part of the gate; they are sent because the
 * official client sends them, and they are derived from the same ids.
 *
 * Derivation rules live in `open-sse/utils/conversationHeaders.js` so a second
 * gated provider does not copy them.
 */

// The gateway's error vocabulary. 11128 is overloaded: it covers both the
// channel-verification variant and a body-shape variant, so the message decides.
const CODE_CHANNEL_VERIFICATION = 11128;
const CODE_FREQUENCY_LIMIT = 6004;
const CODE_TOO_MANY_REQUESTS = 14003;
const CODE_NON_STREAM = 11101;
const CODE_MODEL_NOT_FOUND = 11102;
const CODE_INVALID_REQUEST = 11103;
// 11140: the account itself is frozen, independent of the request body. Measured
// live as `403 {"code":11140,"msg":"Your account has been restricted due to
// unusual activity"}` once the channel gate has been satisfied (#5005 comment,
// 2026-10-18). Nothing client-side clears it; see the branch below.
const CODE_ACCOUNT_RESTRICTED = 11140;

// The gate's wording has changed over time. Observed live:
//   "conversation id missing"                       (PR #4928/#4944, 2026-10-15)
//   "Illegal API invocation from an unapproved channel"  (live, 2026-10-17)
//   "request illegal"                               (live, #5001/#5024, 2026-10-18)
// All three are the same gate; match any so the diagnosis does not rot.
const RE_CHANNEL_VERIFICATION = /conversation id missing|channel verification|unapproved channel|渠道校验/i;
const RE_SYSTEM_PROMPT = /first message is not system prompt/i;
const RE_REQUEST_ILLEGAL = /request illegal|illegal request/i;
const RE_FREQUENCY_LIMIT = /超出频率限制|frequency limit|限额/i;
const RE_TOO_MANY_REQUESTS = /too many requests|model busy/i;
const RE_ACCOUNT_RESTRICTED = /unusual activity|account (?:has been |is )?restricted|account restricted|账号.{0,6}(?:受限|异常|封禁)/i;

function parseResetAt(msg) {
  const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
  if (!match) return null;
  const [, dp, tp, rawTz] = match;
  const tz = rawTz
    ? (rawTz.includes(":") ? (rawTz.startsWith("+") ? rawTz : `+${rawTz}`) : `+${rawTz.padStart(2, "0")}:00`)
    : "+08:00";
  const dt = new Date(`${dp}T${tp}${tz}`);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

/**
 * The gateway's content filter rejects a system prompt that OPENS with the
 * Claude Code identity sentence. Live A/B (2026-10-17) against the real gateway:
 *
 *   "You are Claude Code, Anthropic's official CLI for Claude."            -> 400/11128
 *   "You are Claude Code."                                                -> 200
 *   "You are Claude Code, an interactive CLI tool."                       -> 200
 *   "You are Claude Code - Anthropic's official CLI for Claude."          -> 200
 *   "You are Claude." / "You are an interactive CLI tool built by …"      -> 200
 *   the same identity sentence placed LATER in the prompt                 -> 200
 *
 * So the trigger is one exact leading sentence — comma + "Anthropic's official
 * CLI" — not the words in general and not the length. The pattern below is
 * deliberately pinned to that measured form: a broader match would rewrite
 * prompts upstream accepts, which is the mistake the earlier "replace the whole
 * prompt" implementation made in a different shape.
 *
 * Only that opening sentence is neutralised; every other instruction (tool
 * policy, security rules, working directory, …) is preserved verbatim.
 */
const CLAUDE_IDENTITY_RE =
  /^\s*You are Claude Code,\s*Anthropic['’]s official CLI for Claude\.?[^\n]*(?:\r?\n)*/i;

const NEUTRAL_IDENTITY = "You are a helpful AI assistant that helps with software engineering tasks.";

export function neutralizeIdentityPrompt(text) {
  if (typeof text !== "string" || !text) return text;
  if (!CLAUDE_IDENTITY_RE.test(text)) return text;
  const rest = text.replace(CLAUDE_IDENTITY_RE, "").trimStart();
  return rest ? `${NEUTRAL_IDENTITY}\n\n${rest}` : NEUTRAL_IDENTITY;
}

/**
 * The gateway requires the first message to be a system prompt, but the request
 * that reaches this executor has already been translated: a Claude Code client
 * arrives as OpenAI shape with the CLI's full system prompt as `messages[0]`
 * (role "system"), and a developer message may follow. Both are kept.
 *
 * Only the things the gateway actually rejects are changed:
 *   1. no leading system message at all -> a neutral one is prepended;
 *   2. the opening Claude Code identity sentence -> neutralised (see above);
 *   3. a string `user` content -> typed text blocks (the shape the gateway parses).
 */
export function normalizeIntlMessages(messages) {
  const source = Array.isArray(messages) ? messages : [];

  // Developer instructions are OpenAI's newer name for the same thing; the
  // gateway only accepts "system", so fold leading ones into the system prompt.
  // A system/developer turn that appears later in the conversation is converted
  // to a user turn instead of being hoisted to the top: hoisting would reorder
  // instructions relative to the conversation they belong to.
  const leading = [];
  const rest = [];
  let leadingDone = false;
  for (const message of source) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "system" || message.role === "developer") {
      const text = flattenContent(message.content);
      if (!text) continue;
      if (!leadingDone) {
        leading.push(text);
        continue;
      }
      rest.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }

    leadingDone = true;
    rest.push(
      message.role === "user" && typeof message.content === "string"
        ? { ...message, content: [{ type: "text", text: message.content }] }
        : { ...message },
    );
  }

  const systemText = neutralizeIdentityPrompt(leading.join("\n\n").trim())
    || "You are CodeBuddy Code.";
  return [{ role: "system", content: systemText }, ...rest];
}

export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  // The gate runs in buildHeaders so a caller that invokes it directly (tests,
  // provider probes) also gets a valid request. finalizeHeaders re-runs it after
  // providerOverrides are merged, because that merge can introduce a duplicate
  // case-variant key or blank a required one.
  buildHeaders(credentials, stream = true, url, model, body = null) {
    // The gateway always streams, including when the downstream client wants JSON.
    const headers = super.buildHeaders(credentials, true, url, model, body);
    return ensureConversationHeaders(headers, body, { credentials, model, scope: "codebuddy-intl" });
  }

  finalizeHeaders(headers, { credentials, body, model } = {}) {
    return ensureConversationHeaders(headers, body, { credentials, model, scope: "codebuddy-intl" });
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // The gateway rejects a bare OpenAI shape (11101 invalid request): it needs a
    // leading system prompt and typed user content blocks. See normalizeIntlMessages.
    transformed.messages = normalizeIntlMessages(transformed.messages);

    return transformed;
  }

  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        const code = Number(data?.code);
        // The gate's wording may live in msg or in one of the display fields —
        // `{"msg":"request illegal","displayTips":{"en":"This call failed channel
        // verification…"}}` is the live shape. Classify on the whole record.
        const haystack = [msg, data?.displayTips?.en, data?.displayMsg?.en].filter(Boolean).join(" ");

        // Account restriction is checked before anything else and does not depend
        // on the HTTP status (measured as 403, but the body is the authority).
        // Upstream has frozen the account: no header, body or retry changes that,
        // and the real message must reach the caller rather than being flattened
        // into a generic "illegal request". ERROR_RULES maps the marker to a long
        // account-wide lock; the caller is expected to re-authorise upstream.
        if (code === CODE_ACCOUNT_RESTRICTED || RE_ACCOUNT_RESTRICTED.test(haystack)) {
          return {
            status: 403,
            message:
              `${CODEBUDDY_ACCOUNT_RESTRICTED_MARKER} (11140): upstream refused this account, not this request`
              + (msg ? ` — upstream said: ${msg}.` : ".")
              + " No retry, account fallback or header change clears a restriction;"
              + " the account needs recovery on codebuddy.ai (re-login or appeal) before it can be used again.",
          };
        }

        if (code === CODE_FREQUENCY_LIMIT || RE_FREQUENCY_LIMIT.test(msg)) {
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs: parseResetAt(msg),
          };
        }

        // 14003 "Model busy" is a per-model rate limit, not a channel failure
        // (#5041). Keep it a 429 so the existing backoff rules apply.
        if (code === CODE_TOO_MANY_REQUESTS || RE_TOO_MANY_REQUESTS.test(msg)) {
          return {
            status: 429,
            message: msg || "CodeBuddy upstream busy (14003)",
            resetsAtMs: parseResetAt(msg),
          };
        }

        // 11128 is overloaded — the message decides which variant this is.
        //
        // Channel verification: the gateway refuses the call because it does not
        // trust the client. The live wordings are "conversation id missing",
        // "Illegal API invocation from an unapproved channel", and — since the
        // 2026-10-15 gate — a bare "request illegal" whose explanation lives in
        // displayTips (#5001, #5024, #5041). The marker below is what ERROR_RULES
        // matches to give the connection a cooldown; without it the 400 falls into
        // the request-scoped catch-all (cooldownMs 0) and the block never expires.
        //
        // "request illegal" is read as the gate only when the record identifies
        // itself as a gate: under code 11128 (the measured shape) or alongside the
        // explicit channel wording. A plain 11103 "request illegal" stays
        // request-scoped below — cooling the account for a malformed body is the
        // behaviour the catch-all exists to prevent.
        const channelGate =
          (code === CODE_CHANNEL_VERIFICATION &&
            (RE_REQUEST_ILLEGAL.test(msg) || RE_CHANNEL_VERIFICATION.test(haystack))) ||
          (RE_REQUEST_ILLEGAL.test(msg) && RE_CHANNEL_VERIFICATION.test(haystack));
        if (channelGate && !RE_SYSTEM_PROMPT.test(msg)) {
          const tip = data?.displayTips?.en || data?.displayMsg?.en || "";
          return {
            status: 400,
            message:
              `${CODEBUDDY_CHANNEL_MARKER} failed (${code || 11128}): `
              + "the upstream gateway requires the X-Conversation-* header family and client identity "
              + "the official client sends. CodeBuddyIntlExecutor supplies them; if this appears, the "
              + "gate likely changed (e.g. a new required header), the prompt tripped its filter, or the "
              + "account/IP is temporarily blocked upstream."
              + (msg ? ` Upstream said: ${msg}.` : "")
              + (tip ? ` ${tip}` : ""),
          };
        }

        if (code === CODE_CHANNEL_VERIFICATION && RE_SYSTEM_PROMPT.test(msg)) {
          return {
            status: 400,
            message:
              "CodeBuddy rejected the request body shape (11128 \"first message is not system prompt\"): "
              + "the leading message must be a system prompt. CodeBuddyIntlExecutor.normalizeIntlMessages() "
              + "enforces that; a regression there (or a translator that dropped the system turn) is the cause.",
          };
        }

        if (code === CODE_MODEL_NOT_FOUND) {
          return {
            status: 404,
            // Include the code: it is the only way an operator can tell this
            // apart from a 404 raised by the router itself.
            message: `CodeBuddy model is not available for this account (11102)${msg ? `: ${msg}` : "."}`,
          };
        }

        if (code === CODE_NON_STREAM) {
          return {
            status: 400,
            message: msg || "CodeBuddy only supports streaming chat requests (11101).",
          };
        }

        if (code === CODE_INVALID_REQUEST || RE_REQUEST_ILLEGAL.test(msg)) {
          return {
            status: 400,
            message:
              `CodeBuddy rejected the request as illegal (${code || "request illegal"}): ${msg || "no message"}`
              + (data?.displayTips?.en ? ` Upstream said: ${data.displayTips.en}` : ""),
          };
        }
      } catch {
        // Non-JSON body — fall through to the default parser.
      }
    }
    return super.parseError(response, bodyText);
  }

  /**
   * Read-only probe used by chatCore before it treats a 401/403 as a token
   * problem. The response is a clone, so the real body stays available for
   * parseUpstreamError(). Classification is delegated to parseError() so the two
   * paths cannot drift.
   */
  async isAccountRestricted(response) {
    try {
      const text = await response.text();
      const parsed = this.parseError(response, text);
      return parsed?.status === 403
        && typeof parsed.message === "string"
        && parsed.message.includes(CODEBUDDY_ACCOUNT_RESTRICTED_MARKER);
    } catch {
      return false;
    }
  }

  /**
   * The shared refresher exists (reactive 401/403 path in chatCore used to fall
   * through DefaultExecutor, which has no entry for this provider and returned
   * null → refreshWithRetry burned 3 attempts and logged "All 3 retry attempts
   * failed" even though the token endpoint was never called).
   *
   * Delegating keeps one implementation: the same function the proactive and
   * background refresh paths use. A connection without a refresh token returns
   * the sentinel so the retry loop stops immediately instead of sleeping twice
   * for a capability this connection does not have.
   */
  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return REFRESH_UNAVAILABLE;
    try {
      const result = await refreshCodebuddyIntlToken(credentials.refreshToken, log);
      if (result?.accessToken) {
        log?.info?.("TOKEN", "codebuddy-intl refreshed");
      }
      return result;
    } catch (error) {
      log?.warn?.("TOKEN", `codebuddy-intl refresh error: ${error.message}`);
      return null;
    }
  }
}

export default CodeBuddyIntlExecutor;
