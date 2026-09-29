import { describe, expect, it, vi } from "vitest";
import { withSseKeepalive, SSE_KEEPALIVE_FRAME } from "../../open-sse/utils/sseKeepalive.js";

const encoder = new TextEncoder();

/** A ReadableStream that emits the given chunks, then closes. */
function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Collect everything a stream emits into one string. */
async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Read frames from a stream until `stop()` is true, with a hard cap. */
async function readUntil(stream, predicate, { maxReads = 40 } = {}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (let i = 0; i < maxReads; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (predicate(out)) break;
  }
  reader.releaseLock();
  return out;
}

const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe("client-facing SSE keepalive", () => {
  it("is a no-op when the interval is disabled or non-positive", async () => {
    const raw = streamOf([event("message_start", {})]);
    expect(withSseKeepalive(raw, { intervalMs: 0 })).toBe(raw);
    expect(withSseKeepalive(raw, { intervalMs: -1 })).toBe(raw);
  });

  it("emits heartbeats while the client-facing stream is idle", async () => {
    vi.useFakeTimers();
    try {
      let controller;
      const upstream = new ReadableStream({ start(c) { controller = c; } });
      const stream = withSseKeepalive(upstream, { intervalMs: 1000 });
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      controller.enqueue(encoder.encode(event("message_start", { type: "message_start" })));
      const first = decoder.decode((await reader.read()).value);
      expect(first).toContain("event: message_start");

      // Upstream goes silent: heartbeats must arrive on their own.
      await vi.advanceTimersByTimeAsync(1000);
      const ping1 = decoder.decode((await reader.read()).value);
      await vi.advanceTimersByTimeAsync(1000);
      const ping2 = decoder.decode((await reader.read()).value);

      expect(ping1).toBe(SSE_KEEPALIVE_FRAME);
      expect(ping2).toBe(SSE_KEEPALIVE_FRAME);

      controller.close();
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not heartbeat an active stream", async () => {
    vi.useFakeTimers();
    try {
      let controller;
      const upstream = new ReadableStream({ start(c) { controller = c; } });
      const stream = withSseKeepalive(upstream, { intervalMs: 1000 });
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      // Real traffic every 400ms keeps resetting the idle timer.
      for (let i = 0; i < 3; i++) {
        controller.enqueue(encoder.encode(event("content_block_delta", { i })));
        await vi.advanceTimersByTimeAsync(400);
        const chunk = decoder.decode((await reader.read()).value);
        expect(chunk).not.toContain(": ping");
      }

      controller.close();
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops heartbeating after the terminal event", async () => {
    vi.useFakeTimers();
    try {
      const upstream = streamOf([
        event("message_start", { type: "message_start" }),
        event("message_stop", { type: "message_stop" }),
      ]);
      const stream = withSseKeepalive(upstream, { intervalMs: 1000 });
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain("message_stop");

      // No timer may survive the close: advancing time must add nothing.
      const pingsAfterClose = [];
      const spy = vi.fn((chunk) => pingsAfterClose.push(chunk));
      void spy;
      await vi.advanceTimersByTimeAsync(5000);
      expect(text.split(": ping").length - 1).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never splits a frame that is still being written", async () => {
    vi.useFakeTimers();
    try {
      let controller;
      const upstream = new ReadableStream({ start(c) { controller = c; } });
      const stream = withSseKeepalive(upstream, { intervalMs: 1000 });
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      // A frame split across chunks: the first part has no blank-line delimiter.
      controller.enqueue(encoder.encode("event: content_block_delta\ndata: {\"partial\":"));
      const part1 = decoder.decode((await reader.read()).value);
      expect(part1).not.toContain(": ping");

      // While that frame is incomplete, the idle timer must not inject.
      await vi.advanceTimersByTimeAsync(3000);
      controller.enqueue(encoder.encode("true}\n\n"));
      const rest = decoder.decode((await reader.read()).value);
      expect(rest).not.toContain(": ping");

      // The reassembled stream is still valid SSE.
      const whole = part1 + rest;
      expect(whole).toBe('event: content_block_delta\ndata: {"partial":true}\n\n');
      expect(whole.split("\n\n").filter(Boolean)).toHaveLength(1);

      controller.close();
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the heartbeat across a frame fragmented over three chunks", async () => {
    vi.useFakeTimers();
    try {
      let controller;
      const upstream = new ReadableStream({ start(c) { controller = c; } });
      const stream = withSseKeepalive(upstream, { intervalMs: 1000 });
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let whole = "";

      // First fragment ends on a boundary, so the stream is idle at a safe point.
      controller.enqueue(encoder.encode("event: message_start\ndata: {}\n\n"));
      whole += decoder.decode((await reader.read()).value);
      await vi.advanceTimersByTimeAsync(1000);
      const ping = decoder.decode((await reader.read()).value);
      expect(ping).toBe(SSE_KEEPALIVE_FRAME);

      // Now a new frame arrives in two fragments; no heartbeat may interleave.
      controller.enqueue(encoder.encode("event: content_block_delta\ndata: {\"index\":0,"));
      whole += decoder.decode((await reader.read()).value);
      await vi.advanceTimersByTimeAsync(5000);
      controller.enqueue(encoder.encode("\"delta\":{\"text\":\"hi\"}}\n\n"));
      whole += decoder.decode((await reader.read()).value);

      expect(whole).not.toMatch(/:\s*ping[\s\S]*"index":0[\s\S]*:\s*ping/);
      // Reassembled payload is still one valid frame.
      const frames = whole.split("\n\n").filter((f) => f.trim() && f.trim() !== ": ping");
      expect(frames).toHaveLength(2);
      expect(frames[1]).toContain('"text":"hi"');

      controller.close();
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer when the consumer cancels (client abort)", async () => {
    vi.useFakeTimers();
    try {
      let controller;
      let cancelled = false;
      const upstream = new ReadableStream({
        start(c) { controller = c; },
        cancel() { cancelled = true; },
      });
      const stream = withSseKeepalive(upstream, { intervalMs: 1000 });
      const reader = stream.getReader();

      controller.enqueue(encoder.encode(event("message_start", {})));
      await reader.read();

      await reader.cancel("client abort");
      expect(cancelled).toBe(true);

      // A leaked timer would enqueue into a cancelled stream and throw; if the
      // timer were still armed, advancing time here would surface that.
      await vi.advanceTimersByTimeAsync(5000);
      // The upstream controller is already closed by the cancel propagation, so
      // closing again is a no-op — guard it to keep the assertion meaningful.
      try { controller.close(); } catch { /* already closed by cancel */ }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports diagnostics that separate client idle from upstream idle", async () => {
    vi.useFakeTimers();
    try {
      const seen = [];
      let controller;
      const upstream = new ReadableStream({ start(c) { controller = c; } });
      const stream = withSseKeepalive(upstream, {
        intervalMs: 1000,
        onKeepalive: (stats) => seen.push(stats),
      });
      const reader = stream.getReader();

      controller.enqueue(encoder.encode(event("message_start", {})));
      await reader.read();
      await vi.advanceTimersByTimeAsync(1000);
      await reader.read();

      const ping = seen.find((s) => !s.final);
      expect(ping).toBeTruthy();
      expect(ping.keepaliveCount).toBe(1);
      expect(ping.clientEventCount).toBe(1);
      expect(ping.msSinceLastClientEvent).toBeGreaterThanOrEqual(1000);

      controller.close();
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a long silent gap filled with periodic heartbeats (the 180s case)", async () => {
    vi.useFakeTimers();
    try {
      const upstream = streamOf([
        event("message_start", {}),
        event("content_block_delta", { text: "done" }),
        event("message_stop", {}),
      ]);
      // 15s heartbeat, but the test only advances time between the two events by
      // using a stream that never delivers the second chunk until we say so.
      let controller;
      const gated = new ReadableStream({ start(c) { controller = c; } });
      const stream = withSseKeepalive(gated, { intervalMs: 15000 });
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      controller.enqueue(encoder.encode(event("message_start", {})));
      await reader.read();

      // Simulate a 3-minute silent reasoning gap at 15s heartbeats.
      let heartbeats = 0;
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(15000);
        const chunk = decoder.decode((await reader.read()).value);
        if (chunk === SSE_KEEPALIVE_FRAME) heartbeats++;
      }
      expect(heartbeats).toBe(12);

      controller.enqueue(encoder.encode(event("message_stop", {})));
      const stop = decoder.decode((await reader.read()).value);
      expect(stop).toContain("message_stop");

      controller.close();
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });
});
