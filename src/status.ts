// `StatusReport`, assembled from the two things that each know half of it.
//
// `doctor` probes capabilities and memory; `serve`'s worker record knows which model is actually
// loaded and at which commit. Neither can answer alone, and joining them here rather than inside
// either one keeps `serve → doctor` the only direction that import ever goes.
import { collect, toStatusReport } from "./doctor.js";
import { readRecord } from "./serve.js";
import type { StatusReport } from "./schemas.js";

export interface StatusOpts {
  port?: number;
  /** The project being verified — `tsc`, `vitest` and `stryker` are reported from *its* node_modules. */
  project?: string;
}

export async function statusReport(opts: StatusOpts = {}): Promise<StatusReport> {
  const { checks, memory, port } = await collect({ port: opts.port, cwd: opts.project });
  const record = await readRecord(port);
  return toStatusReport(checks, memory, port, {
    model: record?.repo ?? null,
    revision: record?.revision || null,
  });
}
