/** Streaming parser for Kiro's UNSIGNED, prompt-emitted <thinking> tags.
 * Handles tags split across EventStream chunks; never synthesizes a signature.
 */
export function consumeTaggedThinking(state, chunk, maxChars = 1200) {
  const OPEN = "<thinking>";
  const CLOSE = "</thinking>";
  let input = (state.thinkingRemainder || "") + String(chunk ?? "");
  state.thinkingRemainder = "";
  let visible = "";
  const capture = (text) => {
    if (maxChars > 0 && text) state.thinkingCapture = ((state.thinkingCapture || "") + text).slice(-maxChars);
  };
  while (input.length) {
    const marker = state.inThinking ? CLOSE : OPEN;
    const at = input.indexOf(marker);
    if (at !== -1) {
      const before = input.slice(0, at);
      if (state.inThinking) capture(before); else visible += before;
      state.inThinking = !state.inThinking;
      input = input.slice(at + marker.length);
      continue;
    }
    let retained = 0;
    for (let length = Math.min(marker.length - 1, input.length); length > 0; length--) {
      if (input.endsWith(marker.slice(0, length))) { retained = length; break; }
    }
    const ready = input.slice(0, input.length - retained);
    if (state.inThinking) capture(ready); else visible += ready;
    state.thinkingRemainder = retained ? input.slice(-retained) : "";
    break;
  }
  return visible;
}
export function flushTaggedThinking(state) {
  const rest = state.inThinking ? "" : state.thinkingRemainder || "";
  state.thinkingRemainder = "";
  return rest;
}
