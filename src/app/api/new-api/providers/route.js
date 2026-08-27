import { NextResponse } from "next/server";
import { createProviderNode } from "@/models";
import {
  listNewApiProviders,
  prepareNewApiProviderDefinition,
  probeNewApiOrigin,
} from "@/sse/services/newapiProvider";
import {
  NEW_API_NODE_API_TYPE,
  getNewApiNodeOrigin,
} from "open-sse/services/newapi/definition.js";
import { generateId } from "@/shared/utils";
import { OPENAI_COMPATIBLE_PREFIX } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Public projection of a definition — no credential is stored on a node anyway. */
function safeDefinition(node) {
  return {
    id: node.id,
    name: node.name,
    alias: node.prefix,
    family: node.family,
    baseUrl: node.baseUrl,
    origin: getNewApiNodeOrigin(node),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/** GET /api/new-api/providers — list New API provider definitions. */
export async function GET() {
  try {
    const nodes = await listNewApiProviders();
    return NextResponse.json({ providers: nodes.map(safeDefinition) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { error: "Failed to list New API providers." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * POST /api/new-api/providers — create one from Name + Origin + Alias.
 *
 * The origin must be a bare https origin; `/v1` is derived, never entered. A
 * bounded `/api/status` probe catches an obviously wrong domain before anything
 * is persisted. The stored origin is the only management target any later request
 * may reach.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_STORE });
    }

    const prepared = await prepareNewApiProviderDefinition({
      name: body.name,
      origin: body.origin,
      alias: body.alias,
    });
    if (!prepared.ok) {
      return NextResponse.json({ error: prepared.error }, { status: prepared.status, headers: NO_STORE });
    }

    if (body.skipProbe !== true) {
      const probe = await probeNewApiOrigin(
        prepared.definition.newApi.origin,
        prepared.definition.name,
      );
      if (!probe.ok) {
        return NextResponse.json({ error: probe.error }, { status: 502, headers: NO_STORE });
      }
    }

    // Shares the openai-compatible id namespace on purpose: New API inference is
    // OpenAI chat-completions, so `isOpenAICompatibleProvider` stays true and every
    // existing compat routing/UI path works with no extra branch.
    const node = await createProviderNode({
      ...prepared.definition,
      id: `${OPENAI_COMPATIBLE_PREFIX}${NEW_API_NODE_API_TYPE}-${generateId()}`,
    });

    return NextResponse.json({ provider: safeDefinition(node) }, { status: 201, headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { error: "Failed to create New API provider." },
      { status: 500, headers: NO_STORE },
    );
  }
}
