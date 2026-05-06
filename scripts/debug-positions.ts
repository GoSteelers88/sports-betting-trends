import { getPositions } from "./execute-kalshi.js";

void (async () => {
  const positions = await getPositions();
  console.log("Raw position fields (first 3):");
  for (const p of positions.slice(0, 3)) {
    console.log(JSON.stringify(p, null, 2));
  }
  console.log("Total positions:", positions.length);
})();
