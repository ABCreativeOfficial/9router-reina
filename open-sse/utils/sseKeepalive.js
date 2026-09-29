/**
 * Client-facing SSE keepalive.
 *
 * Purpose: a client with its own idle watchdog (Claude Code aborts a stream that
 * stays silent for ~180s) must keep seeing bytes while the upstream is thinking.
 *
 * Two rules keep this safe:
 *
 * 1. It measures CLIENT-facing output, never upstream activity. A heartbeat is
 *    not proof the upstream is alive, so it must not touch the upstream stall
 *    or first-byte budgets — those live in `pipeWithDisconnect`.
 * 2. It is only emitted on a complete SSE frame boundary. The upstream stream is
 *    already translated into whole client events before it reaches this layer
 *    (events end with a blank line), so a heartbeat can never split a frame.
 *
 * The heartbeat is a comment frame (`: ping`), the same shape Anthropic's own API
 * uses for pings and the shape already used by the dashboard SSE endpoints. A
 * comment is ignored by every SSE parser and is never mistaken for model output,
 * so it cannot alter content, stop_reason, tool calls or usage accounting.
 */
import { SSE_KEEPALIVE_MS } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

// A comment frame: valid SSE, ignored by parsers, never content.
export const SSE_KEEPALIVE_FRAME = ": ping\n\n";

// Events are separated by a blank line. Buffering until this marker means a
// heartbeat is only ever injected between two complete frames.
const SSE_FRAME_DELIMITER = "\n\n";

/**
 * Wrap a client-facing SSE byte stream with an idle heartbeat.
 *
 * The timer is armed only while the stream is idle: every real chunk clears it
 * and re-arms it, so an active stream emits no heartbeats at all and a silent
 * one emits exactly one per interval.
 *
 * @param {ReadableStream} readable - client-facing SSE stream (already translated)
 * @param {object} [options]
 * @param {number} [options.intervalMs] - heartbeat interval; <= 0 disables it
 * @param {(event: object) => void} [options.onKeepalive] - diagnostics hook
 * @returns {ReadableStream} the same stream, or a wrapped one when enabled
 */
export function withSseKeepalive(readable, { intervalMs = SSE_KEEPALIVE_MS, onKeepalive = null } = {}) {
  if (!readable || typeof readable.getReader !== "function") return readable;
  if (!(intervalMs > 0)) return readable;

  const reader = readable.getReader();
  const encoder = new TextEncoder();
  let timer = null;
  let closed = false;
  let keepaliveCount = 0;
  let clientEventCount = 0;
  let lastClientEventAt = Date.now();
  const startedAt = Date.now();

  // Everything after the last frame delimiter is the current, possibly partial,
  // frame. Tracking that tail (rather than a "does the chunk end with \n\n"
  // guess) is what makes the boundary check exact: a heartbeat is injected only
  // when the tail is empty, i.e. between two complete frames.
  let unframedTail = "";

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return new ReadableStream({
    start(controller) {
      const arm = () => {
        clearTimer();
        if (closed) return;
        timer = setTimeout(() => {
          timer = null;
          if (closed) return;
          // Only inject between complete frames. If a frame is still being
          // written, wait for its delimiter instead of splitting it — the
          // upstream stall watchdog remains the backstop for a frame that never
          // completes.
          if (unframedTail.length > 0) {
            arm();
            return;
          }
          try {
            controller.enqueue(encoder.encode(SSE_KEEPALIVE_FRAME));
          } catch {
            closed = true;
            return;
          }
          keepaliveCount++;
          onKeepalive?.({
            keepaliveCount,
            clientEventCount,
            msSinceLastClientEvent: Date.now() - lastClientEventAt,
            durationMs: Date.now() - startedAt,
          });
          dbg("STREAM", `keepalive #${keepaliveCount} | clientIdle=${Date.now() - lastClientEventAt}ms | events=${clientEventCount}`);
          arm();
        }, intervalMs);
      };

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (closed) return;
            if (done) {
              closed = true;
              clearTimer();
              onKeepalive?.({
                final: true,
                keepaliveCount,
                clientEventCount,
                msSinceLastClientEvent: Date.now() - lastClientEventAt,
                durationMs: Date.now() - startedAt,
              });
              dbg("STREAM", `keepalive stream closed | keepalives=${keepaliveCount} | events=${clientEventCount} | dur=${Date.now() - startedAt}ms`);
              try { controller.close(); } catch { /* already closed */ }
              return;
            }

            const text = typeof value === "string" ? value : new TextDecoder().decode(value, { stream: true });
            if (text.length > 0) {
              clientEventCount++;
              lastClientEventAt = Date.now();
              // Keep only what follows the last delimiter: an empty tail means
              // the stream is sitting on a frame boundary.
              const lastDelimiter = text.lastIndexOf(SSE_FRAME_DELIMITER);
              unframedTail = lastDelimiter === -1
                ? unframedTail + text
                : text.slice(lastDelimiter + SSE_FRAME_DELIMITER.length);
            }
            controller.enqueue(value);
            arm();
          }
        } catch (error) {
          closed = true;
          clearTimer();
          try { controller.error(error); } catch { /* already closed */ }
        } finally {
          clearTimer();
        }
      };

      arm();
      pump();
    },

    cancel(reason) {
      closed = true;
      clearTimer();
      // Client went away (or downstream cancelled): stop reading upstream too.
      reader.cancel(reason).catch(() => {});
      dbg("STREAM", `keepalive cancel: ${reason ?? "cancelled"} | keepalives=${keepaliveCount}`);
    },
  });
}
