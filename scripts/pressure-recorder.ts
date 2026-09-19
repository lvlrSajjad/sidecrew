// Sample the machine every 20 s for the length of a run — ADR-0066's recorder, promoted out of a
// scratch directory and rebuilt on the product's own instrument.
//
//   npx tsx scripts/pressure-recorder.ts <out.csv> [--interval 20]
//
// **It prevents nothing, and that is the design.** ADR-0066 option C: a starved verdict is identifiable
// after the fact by cross-referencing a verdict's time against this timeline. Without it contamination
// can only be suspected; with it, it can be checked — which is how the two arm-D retry pairs in
// `experiments/gate-error-rate/README.md` §2 were cleared of memory pressure rather than merely
// assumed innocent of it.
//
// It calls `readMachineState`, the same function the gate now records on every verdict, so the
// timeline and the per-verdict samples cannot disagree. The 11b recorder earned its trust by matching
// `parseMemory` to the decimal; this one matches by construction, which is the stronger version of the
// same property.
import { appendFile, writeFile } from "node:fs/promises";
import { readMachineState } from "../src/doctor.js";

const out = process.argv[2];
if (out === undefined) {
  process.stderr.write("usage: pressure-recorder.ts <out.csv> [--interval 20]\n");
  process.exit(1);
}
const at = process.argv.indexOf("--interval");
const intervalMs = (Number(at === -1 ? 20 : process.argv[at + 1]) || 20) * 1000;

await writeFile(out, "iso,pressure,free_gb,swap_gb,compressed_gb\n", "utf8");

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { stopping = true; });
}

const n = (v: number | null): string => (v === null ? "" : v.toFixed(1));
while (!stopping) {
  const m = await readMachineState();
  const level = { normal: 1, warn: 2, critical: 4, unknown: 0 }[m.pressure];
  await appendFile(out, `${new Date().toISOString()},${level},${n(m.free_gb)},${n(m.swap_gb)},${n(m.compressed_gb)}\n`, "utf8");
  await new Promise((r) => setTimeout(r, intervalMs));
}
