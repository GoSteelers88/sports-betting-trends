import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export async function GET() {
  const filePath = path.join(process.cwd(), "data", "processed", "latest-player-props.json");
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({
      ready: false,
      available: false,
      generatedAt: null,
      topProps: [],
      note: "Player props file not found. Run npm run ingest:props.",
    });
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return NextResponse.json(data);
}
