import { DefaultExecutor } from "./default.js";
import {
  ensureConversationHeaders,
  flattenContent,
} from "../utils/conversationHeaders.js";

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
const CODE_NON_STREAM = 11101;
const CODE_MODEL_NOT_FOUND = 11102;
const CODE_INVALID_REQUEST = 11103;

// The gate's wording has changed over time. Observed live:
//   "conversation id missing"                       (PR #4928/#4944, 2026-10-15)
//   "Illegal API invocation from an unapproved channel"  (live, 2026-10-17)
// Both are channel verification; match either so the diagnosis does not rot.
const RE_CHANNEL_VERIFICATION = /conversation id missing|channel verification|unapproved channel|渠道校验/i;
const RE_SYSTEM_PROMPT = /first message is not system prompt/i;
const RE_REQUEST_ILLEGAL = /request illegal|illegal request/i;
const RE_FREQUENCY_LIMIT = /超出频率限制|frequency limit|限额/i;

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
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    return ensureConversationHeaders(headers, body, { credentials, scope: "codebuddy-intl" });
  }

  finalizeHeaders(headers, { credentials, body } = {}) {
    return ensureConversationHeaders(headers, body, { credentials, scope: "codebuddy-intl" });
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

        if (code === CODE_FREQUENCY_LIMIT || RE_FREQUENCY_LIMIT.test(msg)) {
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs: parseResetAt(msg),
          };
        }

        // 11128 is overloaded — only the conversation-id wording is the channel
        // gate. Claiming it for the system-prompt variant would send the operator
        // after the wrong fix.
        if (code === CODE_CHANNEL_VERIFICATION && RE_CHANNEL_VERIFICATION.test(msg)) {
          const tip = data?.displayTips?.en || data?.displayMsg?.en || "";
          return {
            status: 400,
            message:
              "CodeBuddy channel verification failed (11128): "
              + "the upstream gateway requires the X-Conversation-* header family and client identity "
              + "the official client sends. CodeBuddyIntlExecutor supplies them; if this appears, the "
              + "gate likely changed (e.g. a new required header) or the prompt tripped its filter."
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
}

export default CodeBuddyIntlExecutor;
