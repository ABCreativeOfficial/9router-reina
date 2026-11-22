/** Conservative gateway-side estimate. NOT Anthropic/provider token usage.
 * Preserves legacy 3-token estimate for 'hello world' while better accounting
 * for high-punctuation code, non-ASCII, tools and per-message overhead.
 */
const utf8 = new TextEncoder();
export function estimateTextTokens(text) {
  const value = String(text ?? "");
  if (!value) return 0;
  const bytes = utf8.encode(value).byteLength;
  const baseline = Math.ceil(bytes / 4);
  const codePunctuation = (value.match(/[{}()[\]<>;=|&*~^]/g) || []).length;
  const nonAscii = (value.match(/[^\x00-\x7f]/gu) || []).length;
  const extra = Math.floor(codePunctuation / 3) + Math.floor(nonAscii / 3);
  return Math.max(baseline, Math.ceil(value.length / 4) + extra);
}
function jsonTokens(value) {
  if (value == null) return 0;
  try { return estimateTextTokens(JSON.stringify(value)); }
  catch { return 0; }
}
function contentTokens(content) {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return jsonTokens(content);
  let sum = 0;
  for (const block of content) {
    if (typeof block === "string") { sum += estimateTextTokens(block); continue; }
    if (!block || typeof block !== "object") continue;
    if (block.type === "image" || block.type === "document") {
      // Unknown pixel/page count: deliberately approximate, not exact.
      sum += 1600;
    } else if (block.type === "text") sum += estimateTextTokens(block.text);
    else if (block.type === "thinking") sum += estimateTextTokens(block.thinking);
    else if (block.type === "redacted_thinking") sum += 0;
    else if (block.type === "tool_use") sum += estimateTextTokens(block.name) + jsonTokens(block.input) + 8;
    else if (block.type === "tool_result") sum += contentTokens(block.content) + 8;
    else sum += jsonTokens(block);
  }
  return sum;
}
export function estimateClaudeTokens(body = {}, { includeOverhead = true } = {}) {
  let total = contentTokens(body.system);
  total += jsonTokens(body.tools);
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    total += contentTokens(msg?.content);
    if (includeOverhead) total += 4;
  }
  if (includeOverhead && Array.isArray(body.tools) && body.tools.length) total += body.tools.length * 8;
  return Math.max(0, Math.ceil(total));
}
export function estimateKiroTokens(payload = {}) {
  const conv = payload?.conversationState;
  const turns = [...(Array.isArray(conv?.history) ? conv.history : []), conv?.currentMessage].filter(Boolean);
  let total = 0;
  for (const item of turns) {
    const user = item.userInputMessage;
    const assistant = item.assistantResponseMessage;
    if (user) {
      total += estimateTextTokens(user.content) + 4;
      total += jsonTokens(user.userInputMessageContext);
      if (user.images?.length) total += 1600 * user.images.length;
    }
    if (assistant) total += estimateTextTokens(assistant.content) + jsonTokens(assistant.toolUses) + 4;
  }
  return total;
}
