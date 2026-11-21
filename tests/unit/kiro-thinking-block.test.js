/**
 * Kiro thinking-block + token-budget regressions.
 *
 * Every fact here is live-measured against the upstream (Kiro free tier,
 * claude-sonnet-4.5) on 2026-11-21, plus the shipped IDE 1.5.11 bundle:
 *
 *  - `additionalModelRequestFields` is rejected for 4.5 with
 *    `REQUEST_BODY_INVALID`; thinking is enabled only by the
 *    `<thinking_mode>enabled</thinking_mode>` prompt prefix.
 *  - Reasoning therefore arrives as a literal `<thinking>…</thinking>` block
 *    inside `assistantResponseEvent.content` — NOT as `reasoningContentEvent`.
 *  - Replaying that reasoning as `assistantResponseMessage.reasoningContent`
 *    is rejected with `THINKING_SIGNATURE_INVALID`; replaying it as the raw
 *    `<thinking>` text inside `content` is accepted.
 */
import { describe, expect, it } from "vitest";
import {
  KIRO_THINKING_CLOSE_TAG,
  KIRO_THINKING_OPEN_TAG,
  KIRO_MEASURED_MAX_INPUT_TOKENS,
  KIRO_MEASURED_MAX_OUTPUT_TOKENS,
  KIRO_DEFAULT_MAX_TOKENS,
  resolveKiroMaxTokens,
} from "../../open-sse/config/kiroConstants.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

describe("Kiro maxTokens resolution", () => {
  it("forwards the client ceiling instead of pinning 32000", () => {
    expect(resolveKiroMaxTokens({ max_tokens: 100 })).toBe(100);
    expect(resolveKiroMaxTokens({ max_tokens: 2000 })).toBe(2000);
  });

  it("accepts the OpenAI Responses spelling and clamps to the measured ceiling", () => {
    expect(resolveKiroMaxTokens({ max_completion_tokens: 4096 })).toBe(4096);
    expect(resolveKiroMaxTokens({ max_tokens: 10_000_000 })).toBe(KIRO_MEASURED_MAX_OUTPUT_TOKENS);
  });

  it("falls back to the previous default when the client sends nothing", () => {
    expect(resolveKiroMaxTokens({})).toBe(KIRO_DEFAULT_MAX_TOKENS);
    expect(resolveKiroMaxTokens({ max_tokens: 0 })).toBe(KIRO_DEFAULT_MAX_TOKENS);
    expect(resolveKiroMaxTokens({ max_tokens: -5 })).toBe(KIRO_DEFAULT_MAX_TOKENS);
    expect(resolveKiroMaxTokens({ max_tokens: "abc" })).toBe(KIRO_DEFAULT_MAX_TOKENS);
  });

  it("declares a window no larger than what upstream enforces", () => {
    // Measured: ~156k accepted, 312k rejected with CONTENT_LENGTH_EXCEEDS_THRESHOLD.
    expect(KIRO_MEASURED_MAX_INPUT_TOKENS).toBeLessThanOrEqual(250_000);
    expect(KIRO_MEASURED_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(64_000);
  });
});

describe("Kiro thinking block stripping", () => {
  it("opens with a shorter literal than it closes", () => {
    // The off-by-one that left a stray ">" on the client's answer.
    expect(KIRO_THINKING_OPEN_TAG.length).toBe(KIRO_THINKING_CLOSE_TAG.length - 1);
  });

  /** Drive a synthetic upstream EventStream through the executor's parser. */
  async function strip(contentChunks) {
    const { crc32 } = await import("../../open-sse/utils/awsEventStream.js");
    const frames = contentChunks.map((content) => {
      // AWS EventStream header: [nameLen 1B][name][type=7 1B][valueLen 2B BE][value]
      const name = Buffer.from(":event-type", "utf8");
      const value = Buffer.from("assistantResponseEvent", "utf8");
      const headers = Buffer.alloc(1 + name.length + 1 + 2 + value.length);
      let o = 0;
      headers[o++] = name.length;
      name.copy(headers, o); o += name.length;
      headers[o++] = 7;
      headers.writeUInt16BE(value.length, o); o += 2;
      value.copy(headers, o);

      const payload = Buffer.from(JSON.stringify({ content }), "utf8");
      const total = 12 + headers.length + payload.length + 4;
      const frame = Buffer.alloc(total);
      frame.writeUInt32BE(total, 0);
      frame.writeUInt32BE(headers.length, 4);
      frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
      headers.copy(frame, 12);
      payload.copy(frame, 12 + headers.length);
      frame.writeUInt32BE(crc32(frame.subarray(0, total - 4)), total - 4);
      return frame;
    });

    const stream = new ReadableStream({
      start(c) { for (const f of frames) c.enqueue(new Uint8Array(f)); c.close(); },
    });
    const executor = new KiroExecutor();
    const out = executor.transformEventStreamToSSE(new Response(stream, { status: 200 }), "claude-sonnet-4.5", {});
    const text = await new Response(out.body).text();
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean)
      .map((e) => e.choices?.[0]?.delta?.content || "")
      .join("");
  }

  it("removes a complete thinking block without leaving a stray bracket", async () => {
    const out = await strip(["<thinking>rahasia</thinking>", "Jawaban 391"]);
    expect(out).toContain("Jawaban 391");
    expect(out).not.toContain("<thinking>");
    expect(out).not.toContain("rahasia");
    // The exact regression: a leading ">" from the length mismatch.
    expect(out.startsWith(">")).toBe(false);
  });

  it("drops an unterminated thinking block instead of leaking it", async () => {
    const out = await strip(["<thinking>terpotong di tengah"]);
    expect(out).not.toContain("<thinking>");
    expect(out).not.toContain("terpotong");
  });
});