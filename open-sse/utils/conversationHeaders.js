import { createHash, randomBytes } from "node:crypto";

/**
 * Conversation-correlation headers for gateways that verify the request came
 * from their official client (CodeBuddy Intl / WorkBuddy AI: HTTP 400 code
 * 11128 "conversation id missing").
 *
 * Shape is capture-verified against the official desktop client:
 *   X-Conversation-ID          dashed UUIDv7
 *   X-Conversation-Request-ID  32 hex (mirrored by X-Root-Request-ID)
 *   X-Conversation-Message-ID  32 hex (separate from the request id)
 *   X-Request-ID               mirrors X-Conversation-Request-ID (IDE 4.12.1)
 *   X-Trace-ID / traceparent / b3 / X-B3-* — one trace per request
 *
 * Upstream keeps no history under the conversation id, so the id only has to be
 * stable across retries and later turns of one conversation, never across
 * conversations. That is why it is memoised per session key with a TTL instead
 * of being derived from a fake UUIDv7 timestamp: a digest-derived timestamp can
 * land years in the future and would fail any upstream sanity check on the
 * version-7 timestamp field.
 */

const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 5000;

// sessionKey -> { id, lastUsed }
const conversationStore = new Map();

// Monotonic UUIDv7 clock (RFC 9562 §6.2, method 1): same-millisecond calls get
// an incrementing 12-bit sequence so burst traffic cannot collide.
let lastTimestamp = 0;
let sequence = 0;

function dashed(buf) {
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 9562 UUIDv7 with a real millisecond timestamp and monotonic sequence. */
export function uuid7() {
  let ms = Date.now();
  if (ms <= lastTimestamp) {
    sequence += 1;
    if (sequence > 0x0fff) {
      lastTimestamp += 1;
      sequence = 0;
      ms = lastTimestamp;
    } else {
      ms = lastTimestamp;
    }
  } else {
    lastTimestamp = ms;
    sequence = 0;
  }

  const buf = randomBytes(16);
  buf[0] = Math.floor(ms / 2 ** 40) & 0xff;
  buf[1] = Math.floor(ms / 2 ** 32) & 0xff;
  buf[2] = Math.floor(ms / 2 ** 24) & 0xff;
  buf[3] = Math.floor(ms / 2 ** 16) & 0xff;
  buf[4] = Math.floor(ms / 2 ** 8) & 0xff;
  buf[5] = ms & 0xff;
  buf[6] = 0x70 | ((sequence >> 8) & 0x0f); // version 7 + high sequence bits
  buf[7] = sequence & 0xff;
  buf[8] = (buf[8] & 0x3f) | 0x80; // RFC variant
  return dashed(buf);
}

/** UUIDv7 as 32 lowercase hex (the client's request/message id shape). */
export function uuid7Hex() {
  return uuid7().replace(/-/g, "");
}

/** Read a header case-insensitively from a plain object or a fetch Headers. */
export function readHeader(headers, name) {
  if (typeof headers?.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" ? value.trim() : "";
  }
  if (!headers || typeof headers !== "object") return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

/** Write a header, updating a case-variant key instead of adding a duplicate. */
export function writeHeader(headers, name, value) {
  if (typeof headers?.set === "function") {
    headers.set(name, value);
    return;
  }
  if (!headers || typeof headers !== "object") return;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  headers[key || name] = value;
}

/**
 * Collapse case-variant duplicates, keeping the last value.
 *
 * `providerOverrides` is merged with `Object.assign` after the executor builds
 * its headers. A user override written as `x-conversation-id` would therefore
 * leave both that key and our `X-Conversation-ID`; undici joins them into one
 * comma-separated value, corrupting the id. Dedupe runs before the family is
 * (re)validated so the override still wins, but only once.
 */
export function dedupeHeaders(headers) {
  if (typeof headers?.set === "function" || !headers || typeof headers !== "object") return headers;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const existing = Object.keys(out).find((k) => k.toLowerCase() === key.toLowerCase());
    if (existing && existing !== key) delete out[existing];
    out[key] = value;
  }
  return out;
}

/** Canonical dashed form for a UUID supplied as 32 hex; other values pass through. */
export function toDashedUuid(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^[0-9a-f]{32}$/i.test(raw)) {
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`.toLowerCase();
  }
  return raw;
}

/** 32-hex form for a dashed UUID; other values pass through. */
export function toHex32(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw.replace(/-/g, "").toLowerCase();
  }
  return raw;
}

function sha16(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// Claude Code carries its conversation id in metadata.user_id as `_session_<uuid>`
// or as JSON `{ "session_id": "..." }`.
function sessionFromUserId(userId) {
  if (typeof userId !== "string" || !userId) return "";
  const match = userId.match(/_session_([a-f0-9-]+)$/i);
  if (match) return match[1];
  if (userId[0] === "{") {
    try {
      const parsed = JSON.parse(userId);
      return typeof parsed?.session_id === "string" ? parsed.session_id : "";
    } catch {
      return "";
    }
  }
  return "";
}

/** Flatten OpenAI-style message content (string or typed blocks) to text. */
export function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Text of the opening user message, used to separate conversations that share a connection. */
export function firstUserText(body) {
  const items = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.input)
      ? body.input
      : [];
  const firstUser = items.find((item) => item?.role === "user");
  return flattenContent(firstUser?.content);
}

/**
 * Conversation key. An explicit client session is authoritative; otherwise the
 * opening user message identifies the conversation.
 *
 * Deliberately excludes the connection id: the same conversation continues on
 * another account after failover, and the gateway expects the id to stay put.
 * Upstream keeps no history under this id, so two session-less conversations
 * that open with the same text sharing a correlation id is harmless.
 *
 * No key means "nothing stable to derive from" and the caller gets a fresh UUIDv7.
 */
export function conversationKey({ credentials = null, body = null, scope = "" } = {}) {
  const headers = credentials?.rawHeaders;
  const explicit = firstNonEmpty(
    readHeader(headers, "x-claude-code-session-id"),
    sessionFromUserId(body?.metadata?.user_id),
    readHeader(headers, "x-session-id"),
    readHeader(headers, "session-id"),
    readHeader(headers, "x-amp-thread-id"),
    typeof body?.session_id === "string" ? body.session_id : "",
    typeof body?.prompt_cache_key === "string" ? body.prompt_cache_key : "",
    typeof body?.conversation_id === "string" ? body.conversation_id : "",
  );
  if (explicit) return `client|${scope}|${explicit}`;

  // `_clientSessionId` is set by the translator from the *source* body/headers,
  // so it survives translation to OpenAI shape (metadata is dropped there).
  const captured = typeof credentials?._clientSessionId === "string"
    ? credentials._clientSessionId.trim()
    : "";
  if (/^(claude|antigravity):/i.test(captured)) return `client|${scope}|${captured}`;

  const text = firstUserText(body);
  return text ? `conv|${scope}|${sha16(text)}` : "";
}

/** Stable UUIDv7 for a conversation key, memoised with a TTL and a hard cap. */
export function stableConversationId(key) {
  if (!key) return "";
  const now = Date.now();
  const existing = conversationStore.get(key);
  if (existing) {
    existing.lastUsed = now;
    return existing.id;
  }
  if (conversationStore.size >= MAX_CONVERSATIONS) {
    conversationStore.delete(conversationStore.keys().next().value);
  }
  const id = uuid7();
  conversationStore.set(key, { id, lastUsed: now });
  return id;
}

/** Test-only: clear the conversation memo. */
export function resetConversationStore() {
  conversationStore.clear();
  lastTimestamp = 0;
  sequence = 0;
}

const cleanup = setInterval(() => {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  for (const [key, entry] of conversationStore) {
    if (entry.lastUsed < cutoff) conversationStore.delete(key);
  }
}, 30 * 60 * 1000);
if (cleanup.unref) cleanup.unref();

/**
 * Attach (or repair) the conversation / trace header family.
 *
 * Idempotent: a second pass over an already-filled bag rotates nothing. Values
 * supplied by the caller or a provider override are preserved when non-empty;
 * blanks count as absent, and dashed/hex UUID forms are normalised to the shape
 * the official client uses.
 */
export function ensureConversationHeaders(headers, body = null, options = {}) {
  const bag = dedupeHeaders(headers) || {};
  const { credentials = null, scope = "codebuddy-intl", model = null } = options;
  const key = conversationKey({ credentials, body, scope });

  const conversationId = toDashedUuid(readHeader(bag, "X-Conversation-ID"))
    || stableConversationId(key)
    || uuid7();
  writeHeader(bag, "X-Conversation-ID", conversationId);

  // IDE 4.12.1 buildModelRequestHeaders uses the request id for both fields,
  // independently of the message id. Preserve explicit caller/override values.
  const requestId = toHex32(readHeader(bag, "X-Conversation-Request-ID"))
    || toHex32(readHeader(bag, "X-Request-ID"))
    || uuid7Hex();
  writeHeader(bag, "X-Conversation-Request-ID", requestId);
  if (!readHeader(bag, "X-Root-Request-ID")) {
    writeHeader(bag, "X-Root-Request-ID", requestId);
  }

  const messageId = toHex32(readHeader(bag, "X-Conversation-Message-ID")) || uuid7Hex();
  writeHeader(bag, "X-Conversation-Message-ID", messageId);
  if (!readHeader(bag, "X-Request-ID")) {
    writeHeader(bag, "X-Request-ID", requestId);
  }
  // TencentAPIImpl supplies the model header for chat and streaming chat.
  const modelId = typeof model === "string" ? model.trim() : "";
  if (modelId && !readHeader(bag, "X-Model-ID")) writeHeader(bag, "X-Model-ID", modelId);

  const traceId = readHeader(bag, "X-Trace-ID")
    || readHeader(bag, "X-B3-TraceId")
    || uuid7Hex();
  const spanId = readHeader(bag, "X-B3-SpanId") || randomBytes(8).toString("hex");
  if (!readHeader(bag, "X-Trace-ID")) writeHeader(bag, "X-Trace-ID", traceId);
  if (!readHeader(bag, "X-B3-TraceId")) writeHeader(bag, "X-B3-TraceId", traceId);
  if (!readHeader(bag, "X-B3-SpanId")) writeHeader(bag, "X-B3-SpanId", spanId);
  if (!readHeader(bag, "traceparent")) {
    writeHeader(bag, "traceparent", `00-${traceId}-${spanId}-01`);
  }
  if (!readHeader(bag, "b3")) writeHeader(bag, "b3", `${traceId}-${spanId}-1`);
  if (!readHeader(bag, "X-B3-Sampled")) writeHeader(bag, "X-B3-Sampled", "1");

  return bag;
}
