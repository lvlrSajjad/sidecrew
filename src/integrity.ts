// "After the job the project must be intact" — the owner's rule, 23 Sep 2026 (ADR-0088), checked by a
// machine rather than promised.
//
// sidecrew never means to write into a project: every stage runs in a sandbox copy. But "never means
// to" is exactly the kind of claim this repository has learnt not to trust. The sandbox's
// `node_modules` is a **symlink to the project's own** (ADR-0034), so a tool that writes a cache into
// `node_modules/.cache`, or an `npm install` run in the wrong directory, lands in the project
// without anything failing. So every `run` and `fix` takes a fingerprint of the project before and
// after, and a difference fails the command loudly, naming what changed.
//
// **What it covers:** git HEAD and the full `git status` (untracked files included), `package.json` and
// every lockfile format (project-a is on `yarn.lock`, and a check hard-coded to `package-lock.json`
// would have fingerprinted nothing), and the top level of `node_modules` and `node_modules/.bin`.
//
// **The one exemption is sidecrew's own output directory, `.sidecrew/`.** Runs are recorded there
// (CLAUDE.md § *Shape*: files are the IPC), and it lands inside a project when sidecrew is run from
// one. It is sidecrew's, it is named, and it is the only path excluded.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "./exec.js";
import { resolveNodeModules } from "./verifier/shared.js";

export const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"] as const;

/** The directory sidecrew records its runs in — the one path a fingerprint ignores. */
export const OWN_OUTPUT = ".sidecrew";

export interface ProjectFingerprint {
  /** null when the project is not a git repository; the other fields still hold. */
  head: string | null;
  /** sha256 of `git status --porcelain --untracked-files=all`, minus sidecrew's own output. */
  status: string | null;
  /** sha256 of each manifest that exists; a file that appears or disappears is a change. */
  manifests: Record<string, string>;
  /** sha256 of the top-level listing of `node_modules` and of `node_modules/.bin`. */
  node_modules: string | null;
  bin: string | null;
}

const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

const listing = (dir: string): string | null => {
  try {
    return sha(readdirSync(dir).sort().join("\n"));
  } catch {
    return null;
  }
};

export async function fingerprintProject(projectDir: string): Promise<ProjectFingerprint> {
  const dir = resolve(projectDir);
  const head = await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
  const isGit = head.code === 0;
  let status: string | null = null;
  if (isGit) {
    // Scoped to the project's own directory (`-- .`). A project can sit inside a larger repository — a
    // monorepo package, or this repository's fixtures — and the rest of that repository is not the
    // project: another process editing a sibling package is not sidecrew changing this one. Paths
    // come back relative to the repository root, so the exemption is matched under the project's prefix.
    const prefix = (await run("git", ["-C", dir, "rev-parse", "--show-prefix"], { timeoutMs: 30_000 })).stdout.trim();
    const st = await run("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all", "--", "."], { timeoutMs: 120_000, maxOutputBytes: 64 << 20 });
    const own = `${prefix}${OWN_OUTPUT}`;
    const lines = st.stdout.split("\n").filter((l) => {
      const path = l.slice(3);
      return l !== "" && path !== own && !path.startsWith(`${own}/`);
    });
    status = sha(lines.join("\n"));
  }
  const manifests: Record<string, string> = {};
  for (const name of ["package.json", ...LOCKFILES]) {
    const at = join(dir, name);
    if (existsSync(at)) manifests[name] = sha(readFileSync(at));
  }
  const modules = resolveNodeModules(dir);
  return {
    head: isGit ? head.stdout.trim() : null,
    status,
    manifests,
    node_modules: modules === null ? null : listing(modules),
    bin: modules === null ? null : listing(join(modules, ".bin")),
  };
}

/** Every way `after` differs from `before`, as sentences. Empty means intact. */
export function compareFingerprints(before: ProjectFingerprint, after: ProjectFingerprint): string[] {
  const out: string[] = [];
  if (before.head !== after.head) out.push(`git HEAD moved: ${before.head ?? "none"} → ${after.head ?? "none"}`);
  if (before.status !== after.status) out.push("git status changed — a file was created, modified or deleted in the project");
  for (const name of new Set([...Object.keys(before.manifests), ...Object.keys(after.manifests)])) {
    const [a, b] = [before.manifests[name], after.manifests[name]];
    if (a === b) continue;
    out.push(a === undefined ? `${name} appeared` : b === undefined ? `${name} was deleted` : `${name} changed`);
  }
  if (before.node_modules !== after.node_modules) out.push("node_modules gained or lost a top-level entry");
  if (before.bin !== after.bin) out.push("node_modules/.bin gained or lost an executable");
  return out;
}

export class ProjectModifiedError extends Error {
  constructor(public readonly projectDir: string, public readonly changes: string[]) {
    super(
      `sidecrew changed ${projectDir}, and it must leave a project exactly as it found it (ADR-0088):\n` +
      changes.map((c) => `  - ${c}`).join("\n") +
      "\n  The run's own records are on disk and are not affected. This is a sidecrew bug — please report it.",
    );
    this.name = "ProjectModifiedError";
  }
}

/**
 * Run `job`, and fail loudly if the project is not intact afterwards.
 *
 * Checked on the failure path too, but there the job's own error is the one thrown and the breach is
 * reported alongside it — a `finally` that throws would replace the error it was cleaning up after,
 * which is ADR-0085's defect exactly.
 */
export async function withIntactProject<T>(
  projectDir: string, job: () => Promise<T>, say: (line: string) => void = () => {},
): Promise<T> {
  const before = await fingerprintProject(projectDir);
  let result: T;
  try {
    result = await job();
  } catch (e) {
    const changes = compareFingerprints(before, await fingerprintProject(projectDir));
    if (changes.length > 0) say(new ProjectModifiedError(projectDir, changes).message);
    throw e;
  }
  const changes = compareFingerprints(before, await fingerprintProject(projectDir));
  if (changes.length > 0) throw new ProjectModifiedError(projectDir, changes);
  return result;
}
