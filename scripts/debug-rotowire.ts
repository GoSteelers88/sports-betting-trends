// Dump full content of script #16 (the "pts" prop block) so we can see the
// data structure RotoWire embeds.

import { chromium } from "playwright";
import fs from "node:fs";

const URL = "https://www.rotowire.com/betting/nba/player-props.php";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const blob = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll("script"));
    // Find the "pts" prop script
    for (const s of scripts) {
      const text = s.textContent ?? "";
      if (text.includes("const prop = \"pts\"")) return text;
    }
    return null;
  });

  if (blob) {
    fs.writeFileSync("rotowire-pts-script.js", blob);
    console.log(`Wrote ${blob.length} chars to ./rotowire-pts-script.js`);
    console.log("\nFirst 2500 chars:");
    console.log(blob.slice(0, 2500));
  } else {
    console.log("not found");
  }

  await browser.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
