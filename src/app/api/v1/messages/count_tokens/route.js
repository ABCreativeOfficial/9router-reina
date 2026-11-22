const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

import { estimateClaudeTokens } from "../../../../../../open-sse/continuity/estimator.js";

/** Conservative local proxy estimate, not provider-tokenizer output. */
export function estimateAnthropicInputTokens(body = {}) {
  // Preserve legacy plain-string behavior while counting punctuation/UTF-8 and
  // structured tool content more conservatively. No network/provider request.
  return estimateClaudeTokens(body, { includeOverhead: false });
}

/**
 * POST /v1/messages/count_tokens - Mock token count response
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  const inputTokens = estimateAnthropicInputTokens(body);

  return new Response(JSON.stringify({
    input_tokens: inputTokens
  }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

