import { NextResponse } from "next/server";
import { getStockLedgerView } from "@/lib/stocks/peadEngine";

export const dynamic = "force-dynamic";

// Read-only view of the PEAD stock paper book (DB only — no broker calls).
export async function GET() {
  try {
    return NextResponse.json(await getStockLedgerView());
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "unavailable" },
      { status: 503 },
    );
  }
}
