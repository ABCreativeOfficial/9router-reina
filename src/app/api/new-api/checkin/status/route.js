import { readCheckinStatus } from "@/lib/newapi/checkin";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const checkinId = new URL(request.url).searchParams.get("id");
    return Response.json(
      { success: true, data: readCheckinStatus(checkinId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Unable to read check-in status." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
