#!/usr/bin/env node
// Local end-to-end smoke test: send a Responses request THROUGH 9router, so the
// configured Xingchi connection and the real streaming response are exercised.
// No Xingchi key is embedded here: add it in the Dashboard first.

const origin = (process.env.ROUTER_URL || "http://127.0.0.1:20127").replace(/\/$/, "");
const routerKey = process.env.ROUTER_API_KEY || "";
const model = process.env.XINGCHI_TEST_MODEL || "xc/gpt-6.1-sol";
const url = `${origin}/v1/responses`;

const request = {
  model,
  input: "Reply with exactly XINGCHI_INTEGRATION_OK.",
  stream: true,
  store: false,
  max_output_tokens: 128,
};

console.log(`Testing ${model} through ${url}`);

try {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(routerKey ? { Authorization: `Bearer ${routerKey}` } : {}),
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60000),
  });

  const content = await response.text();
  const errorFound = /client_not_allowed|response\.failed|"type"\s*:\s*"error"/i.test(content);
  const success = response.ok && !errorFound &&
    (/XINGCHI_INTEGRATION_OK/.test(content) || /response\.completed/.test(content));

  console.log(`HTTP ${response.status} | ${success ? "PASS" : "FAIL"}`);
  if (!success) {
    // The server error helps identify a 403 vs a client-side request issue.
    // Do not print a full payload or keys; keep the excerpt bounded.
    const sanitized = content.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]");
    console.error(sanitized.slice(0, 1600));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Connection failed: ${error.message}`);
  process.exitCode = 1;
}
