import { buildModelsList } from "@/app/api/v1/models/route.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const providerIds = Array.from(new Set(
      new URL(request.url).searchParams.getAll("provider").filter((providerId) => (
        providerId && providerId.length <= 200
        && providerId !== "__proto__" && providerId !== "constructor" && providerId !== "prototype"
      ))
    ));
    if (providerIds.length === 0) return Response.json({ providers: {} });
    if (providerIds.length > 100) {
      return Response.json({ error: "Too many providers" }, { status: 400 });
    }

    const models = await buildModelsList(["llm"], {
      providerIds,
      includeCombos: false,
      includeProviderId: true,
      runtimeOnly: true,
    });
    const providers = Object.fromEntries(providerIds.map((providerId) => [providerId, []]));

    for (const model of models) {
      const providerId = model.provider_id;
      if (!providerId || !Object.prototype.hasOwnProperty.call(providers, providerId)) continue;
      const prefix = `${model.owned_by}/`;
      const id = model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
      providers[providerId].push({ id, name: model.model_name || id });
    }

    return Response.json({ providers }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
