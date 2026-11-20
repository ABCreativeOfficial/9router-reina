/**
 * Explicitly opt function tools out of strict JSON Schema compilation.
 *
 * Claude Code/MCP tools may legitimately contain JSON Schema keywords such as
 * `not`, which strict Responses validators do not implement. Some gateways
 * attempt strict compilation when `strict` is omitted, rejecting the entire
 * request before the model runs. Keep the original schema and let the client
 * validate tool arguments instead.
 *
 * Copy only the changed objects: request bodies may be reused for retries or
 * other providers, and we must not change their original strict flags.
 */
export function forceNonStrictResponsesFunctionTools(body) {
  if (!body || !Array.isArray(body.tools)) return body;

  let changed = false;
  const tools = body.tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;

    if (tool.type === "function" && tool.strict !== false) {
      changed = true;
      return { ...tool, strict: false };
    }

    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      let namespaceChanged = false;
      const nestedTools = tool.tools.map((nested) => {
        if (!nested || nested.type !== "function" || nested.strict === false) return nested;
        namespaceChanged = true;
        return { ...nested, strict: false };
      });
      if (namespaceChanged) {
        changed = true;
        return { ...tool, tools: nestedTools };
      }
    }

    return tool;
  });

  return changed ? { ...body, tools } : body;
}
