import { NextResponse } from "next/server";
import { getLedgerView } from "@/lib/kalshi/paperEngine";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const view = await getLedgerView();
    return NextResponse.json(view);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "unavailable" },
      { status: 503 },
    );
  }
}
