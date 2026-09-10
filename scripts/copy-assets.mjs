// tsc emits .js and .json but not .md, and `files` in package.json only ships `dist`. Without this the
// worker prompt would be missing from the published package and the first real run would fail on a
// machine that never checked out the repo.
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const assets = [["src/prompts", "dist/prompts"]];

for (const [from, to] of assets) {
  const src = fileURLToPath(new URL(from, root));
  if (!existsSync(src)) throw new Error(`copy-assets: ${from} does not exist — did it move?`);
  cpSync(src, fileURLToPath(new URL(to, root)), { recursive: true });
  process.stdout.write(`copied ${from} → ${to}\n`);
}
