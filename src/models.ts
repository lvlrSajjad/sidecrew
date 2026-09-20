// The pin file and everything that reads it. `src/models.json` is the only place a model repo, its
// revision or its footprint is named; this module turns it into answers about *this* machine.
//
// Two questions that look alike and are not (ADR-0008, ADR-0009):
//   - which tier is this machine on?  → installed RAM. Stable, decided once, decides what gets downloaded.
//   - may a worker start right now?   → free RAM. A property of the moment; see serve.ts.
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import models from "./models.json" with { type: "json" };

export interface ModelEntry {
  key: string;
  repo: string;
  /** HF commit sha. Empty until `sidecrew models --pin` writes one. */
  revision: string;
  ram_gb: number;
  licence: string;
}

export type Tier = "local" | "api";

export interface TierRule {
  /** Installed RAM at or above this, in GB, selects this rule. Rules are tried largest first. */
  min_ram_gb: number;
  tier: Tier;
  /**
   * On `local`, the models.json key to host. On `api`, the pinned model id (ADR-0060) — which is not
   * a key in `models` and is not downloaded, which is why `modelForMachine` answers null there.
   */
  model: string | null;
  why: string;
}

/**
 * The api tier's worker, pinned by full model id (ADR-0045 §2, ADR-0060).
 *
 * Deliberately not a `ModelEntry`: a hosted model has no repo, no revision and no resident footprint,
 * and giving it those fields with empty values would invite code to treat the two pins as equally
 * strong. They are not — `revision` is an immutable commit, this is a name a provider resolves.
 */
export interface ApiModel {
  model: string;
  context_tokens: number;
  rates_usd_per_mtok: { input: number; output: number };
  rates_as_of: string;
}

export const apiModel = (): ApiModel => {
  const { model, context_tokens, rates_usd_per_mtok, rates_as_of } = models.api;
  return { model, context_tokens, rates_usd_per_mtok, rates_as_of };
};

/** What the run's billed tokens cost, at the rates recorded on `rates_as_of`. Phase 13 §5.1's $(api). */
export const apiCostUsd = (usage: { prompt_tokens: number; completion_tokens: number }, m: ApiModel = apiModel()): number =>
  (usage.prompt_tokens / 1e6) * m.rates_usd_per_mtok.input +
  (usage.completion_tokens / 1e6) * m.rates_usd_per_mtok.output;

const FILE = new URL("./models.json", import.meta.url);

export const MODELS_JSON_PATH = fileURLToPath(FILE);

export const entries = (): ModelEntry[] =>
  Object.entries(models.models).map(([key, m]) => ({ key, ...m }));

export const entry = (key: string): ModelEntry => {
  const found = entries().find((m) => m.key === key);
  if (!found) {
    throw new Error(`unknown model '${key}' — known keys: ${entries().map((m) => m.key).join(", ")}`);
  }
  return found;
};

export const defaultKey = (): string => models.default;

/**
 * Which tier an amount of *installed* RAM buys, and why.
 *
 * ADR-0009: 32 and 24 GB machines host the local 7B; 16 GB machines cannot host one alongside Xcode
 * and fall back to the Anthropic API. The rules live in models.json rather than here so that changing
 * the answer is a data change with a licence and a footprint next to it, not a patch to a conditional.
 */
/**
 * The installed RAM sidecrew supports, and the owner's scope decision of 20 Sep 2026 (ADR-0073).
 *
 * **sidecrew is a 24 GB+ tool.** Below this, a 7B cannot sit beside a normal working set (ADR-0009,
 * measured), and the honest answer is to say so rather than to quietly become a different product.
 */
export const SUPPORTED_MIN_RAM_GB = 24;

/**
 * Is the `api` tier allowed to run here?
 *
 * **Never by RAM alone** — that is the whole of ADR-0073. The tier's code is kept and works, and its
 * survival, approval and dollar-per-task figures have never been measured (Phase 13 §5, cancelled),
 * so a machine must ask for it explicitly and is told what it is asking for. A silent fallback would
 * ship an unmeasured runtime path to exactly the users least able to notice.
 */
export const apiTierOptIn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SIDECREW_TIER === "api";

/** A machine sidecrew does not support. Its own class so a caller can tell it from a toolchain fault. */
export class UnsupportedMachineError extends Error {
  constructor(message: string) { super(message); this.name = "UnsupportedMachineError"; }
}

/**
 * ADR-0073: sidecrew is a {@link SUPPORTED_MIN_RAM_GB} GB+ tool, and a machine below the floor is
 * refused rather than silently given a different worker.
 *
 * Thrown from the run paths as well as reported by `doctor`, because the two are asked at different
 * moments and a user who never runs `doctor` must still be told. `workerKind` set explicitly (an
 * experiment harness, a replay) bypasses this: those runs are not choosing a tier by looking at RAM.
 */
export const assertSupportedMachine = (
  mem: { total_gb: number } | null,
  explicitKind: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (explicitKind !== undefined || mem === null) return;
  if (mem.total_gb + 0.5 >= SUPPORTED_MIN_RAM_GB || apiTierOptIn(env)) return;
  throw new UnsupportedMachineError(
    `sidecrew needs ${SUPPORTED_MIN_RAM_GB} GB of installed RAM and this machine has ` +
    `${mem.total_gb.toFixed(1)} GB.\n` +
    "  A 7B worker cannot sit beside a normal working set below that (ADR-0009, measured).\n" +
    "  Unsupported escape hatch: SIDECREW_TIER=api runs the worker as Haiku over the Anthropic API, " +
    "billed to your key. Its survival and cost figures have never been measured (ADR-0073).",
  );
};

export const tierFor = (totalGb: number): TierRule => {
  // The data still describes both tiers, and deliberately: `WorkerKind: "api"` labels *a model reached
  // over the network*, which is what Phase 11's C3 control and Phase 11b's arm D recorded — including
  // the corpus the gate's own error rate was measured on. ADR-0073 removes the tier from the supported
  // surface, not the word from the contract. What changed is `apiTierOptIn`: nothing selects `api` by
  // looking at RAM any more.
  const rules = [...(models.tiers as TierRule[])].sort((a, b) => b.min_ram_gb - a.min_ram_gb);
  const rule = rules.find((r) => totalGb + 0.5 >= r.min_ram_gb);
  // The last rule is the floor and matches any machine; a models.json without one is a bug in the data.
  if (!rule) throw new Error("models.json tiers cover no machine this small — the lowest rule must be a floor");
  return rule;
};

/**
 * The model this machine should **host**, or null when its tier hosts nothing locally.
 *
 * Null on the api tier even though its rule now names a model: that name is a hosted id (ADR-0060),
 * not a key in `models`, and nothing downloads it. Callers that want it ask `apiModel()`.
 */
export const modelForMachine = (totalGb: number): ModelEntry | null => {
  const rule = tierFor(totalGb);
  if (rule.tier === "api" || rule.model === null) return null;
  return entry(rule.model);
};

// ── the Hugging Face cache ────────────────────────────────────────────────────────────────────────
// We resolve snapshots ourselves rather than shelling out to python for it: `models` and `status` are
// meant to answer instantly and to keep answering on a machine where mlx_lm is not installed at all.

/** `HF_HUB_CACHE`, else `$HF_HOME/hub`, else `~/.cache/huggingface/hub` — huggingface_hub's own order. */
export const hubCacheDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.HF_HUB_CACHE ?? (env.HF_HOME ? join(env.HF_HOME, "hub") : join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "huggingface", "hub"));

/** `org/name` → `models--org--name`, the on-disk folder huggingface_hub writes. */
export const repoDirName = (repo: string): string => `models--${repo.replace(/\//g, "--")}`;

export interface Snapshot {
  /** Full commit sha of the snapshot on disk. */
  revision: string;
  /** Absolute path to the snapshot directory — what we pass to mlx_lm as `--model`. */
  path: string;
  /** True when more than one snapshot is cached and we picked by `refs/main`. */
  ambiguous: boolean;
}

/**
 * The commit actually on disk for a repo, or null if nothing is downloaded.
 *
 * `refs/main` is the reliable answer — it is what huggingface_hub writes after a download and it names
 * the commit even when several snapshots are cached. Falling back to a lone snapshot directory covers
 * a cache populated by hand or by an older client; two snapshots and no ref is genuinely ambiguous and
 * we say so rather than pick.
 */
export const resolveSnapshot = async (repo: string, cacheDir = hubCacheDir()): Promise<Snapshot | null> => {
  const root = join(cacheDir, repoDirName(repo));
  const snapshots = join(root, "snapshots");

  const ref = await readFile(join(root, "refs", "main"), "utf8").then((s) => s.trim()).catch(() => "");
  const dirs = await readdir(snapshots).then(
    (names) => names.filter((n) => !n.startsWith(".")),
    () => [] as string[],
  );
  if (dirs.length === 0) return null;

  if (ref && dirs.includes(ref)) return { revision: ref, path: join(snapshots, ref), ambiguous: dirs.length > 1 };
  if (dirs.length === 1) return { revision: dirs[0], path: join(snapshots, dirs[0]), ambiguous: false };
  return null;
};

/**
 * What `serve` hands to `mlx_lm --model`.
 *
 * mlx_lm 0.31 has no `--revision` flag, so a repo id is always "whatever main is today" — the exact
 * failure mode non-negotiable #4 exists to prevent, since a silently newer revision makes two survival
 * rates incomparable. A cached snapshot *path* is the pin: it is one immutable commit, and it cannot
 * reach the network. So: pinned and present → the path; otherwise the repo id, and the caller says so.
 */
export interface Resolution {
  /** The `--model` argument. */
  model: string;
  revision: string;
  pinned: boolean;
  /** Set when the pin could not be honoured, for the caller to print. */
  warning: string | null;
}

export const resolveForServe = async (m: ModelEntry, cacheDir = hubCacheDir()): Promise<Resolution> => {
  const snap = await resolveSnapshot(m.repo, cacheDir);

  if (!m.revision) {
    return {
      model: snap?.path ?? m.repo,
      revision: snap?.revision ?? "",
      pinned: false,
      warning: `${m.key} has no pinned revision — run 'sidecrew models --pin ${m.key}' once it is downloaded`,
    };
  }
  if (!snap) {
    return { model: m.repo, revision: m.revision, pinned: false, warning: `${m.key} is pinned to ${short(m.revision)} but nothing is in the HF cache; mlx_lm will download whatever main is now` };
  }
  if (snap.revision !== m.revision) {
    return { model: snap.path, revision: snap.revision, pinned: false, warning: `${m.key} is pinned to ${short(m.revision)} but the cache holds ${short(snap.revision)} — re-pin, or clear the cache and re-download` };
  }
  return { model: snap.path, revision: snap.revision, pinned: true, warning: null };
};

export const short = (sha: string): string => (sha ? sha.slice(0, 12) : "—");

// ── writing the pin ───────────────────────────────────────────────────────────────────────────────

/**
 * Set one model's `revision` in the text of models.json, leaving every byte we did not mean to change.
 *
 * A parse/stringify round-trip would reformat the whole file — the entries are one aligned line each
 * on purpose, so a diff of a pin shows a sha and nothing else. So this edits the text, and then the
 * caller re-parses to prove it is still the same JSON with one field different.
 */
export const pinRevision = (source: string, key: string, revision: string): string => {
  if (!/^[0-9a-f]{7,64}$/.test(revision)) throw new Error(`'${revision}' is not a commit sha`);

  // Start the search inside the `models` block. A model key appears elsewhere in the file — `tiers`
  // names one as the model its tier runs — and matching the first occurrence of the string would edit
  // a tier rule instead of a model entry.
  const modelsAt = /"models"\s*:\s*\{/.exec(source);
  if (!modelsAt) throw new Error("models.json has no `models` block");
  const from = modelsAt.index + modelsAt[0].length;

  // And match it as a key with an object after it, not as a bare string anywhere.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entryAt = new RegExp(`"${escaped}"\\s*:\\s*\\{`).exec(source.slice(from));
  if (!entryAt) throw new Error(`models.json has no entry '${key}'`);
  const at = from + entryAt.index;

  // Stay inside this entry's object literal: the next `}` after the key ends it, and every entry is
  // flat, so there is no nested brace to walk past.
  const end = source.indexOf("}", at);
  if (end === -1) throw new Error(`models.json entry '${key}' is not a complete object`);

  const entryText = source.slice(at, end);
  const field = /"revision"\s*:\s*"([0-9a-f]*)"/.exec(entryText);
  if (!field) throw new Error(`models.json entry '${key}' has no revision field`);

  const patched = entryText.replace(field[0], `"revision": "${revision}"`);
  return source.slice(0, at) + patched + source.slice(end);
};

/**
 * Is the models.json we would write part of a checkout, or part of an install?
 *
 * In the repo this module is `src/models.ts` and the pin lands in `src/models.json`, where it belongs:
 * a pin is a fact about the project, and it travels in git. In a published package the same code lives
 * in `dist/`, usually under a `node_modules` that npm will overwrite on the next upgrade — so the pin is
 * real but local, and saying "commit it" there would be advice the user cannot follow.
 */
export const isCheckout = (path = MODELS_JSON_PATH): boolean =>
  !path.includes(`${sep}node_modules${sep}`) && !path.includes(`${sep}dist${sep}`);

/** Apply `pinRevision` to the file, then prove the result still parses and differs only there. */
export const writePin = async (key: string, revision: string, path = MODELS_JSON_PATH): Promise<void> => {
  const before = await readFile(path, "utf8");
  const after = pinRevision(before, key, revision);

  const a = JSON.parse(before) as typeof models;
  const b = JSON.parse(after) as typeof models;
  a.models[key as keyof typeof a.models].revision = revision;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`refusing to write models.json: the edit changed more than ${key}'s revision`);
  }
  try {
    await writeFile(path, after);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
      throw new Error(`cannot write ${path} (${code}) — a global install may be read-only. Pin in a checkout, or set the revision by hand.`);
    }
    throw e;
  }
};

// ── `sidecrew models` ─────────────────────────────────────────────────────────────────────────────

export interface ModelRow {
  entry: ModelEntry;
  /** null when nothing for this repo is in the HF cache. */
  snapshot: Snapshot | null;
  bytes: number;
  /** Cached commit matches the pinned one — the only state in which a run is reproducible. */
  pinned_and_present: boolean;
}

const dirBytes = async (dir: string): Promise<number> => {
  // Follows the blob symlinks huggingface_hub leaves in snapshots/, which is where the weights are.
  const names = await readdir(dir).catch(() => [] as string[]);
  const sizes = await Promise.all(names.map((n) => stat(join(dir, n)).then((s) => (s.isDirectory() ? dirBytes(join(dir, n)) : s.size), () => 0)));
  return sizes.reduce((a, b) => a + b, 0);
};

export const rows = async (cacheDir = hubCacheDir()): Promise<ModelRow[]> =>
  Promise.all(entries().map(async (e) => {
    const snapshot = await resolveSnapshot(e.repo, cacheDir);
    return {
      entry: e,
      snapshot,
      bytes: snapshot ? await dirBytes(snapshot.path) : 0,
      pinned_and_present: Boolean(e.revision) && snapshot?.revision === e.revision,
    };
  }));

const GB = 1024 ** 3;

export const renderModels = (rs: ModelRow[], totalGb: number | null): string => {
  const rule = totalGb === null ? null : tierFor(totalGb);
  const lines = rs.map((r) => {
    const { key, repo, ram_gb, licence, revision } = r.entry;
    const state = !r.snapshot
      ? "not downloaded"
      : r.pinned_and_present
        ? `pinned ${short(revision)}`
        : revision
          ? `PIN MISMATCH — file ${short(revision)}, cache ${short(r.snapshot.revision)}`
          : `cached ${short(r.snapshot.revision)} — unpinned`;
    const size = r.bytes ? `${(r.bytes / GB).toFixed(1)} GB on disk` : `~${ram_gb.toFixed(1)} GB when loaded`;
    const mark = key === defaultKey() ? "*" : " ";
    return `${mark} ${key.padEnd(24)} ${state.padEnd(46)} ${size.padEnd(20)} ${licence}\n    ${repo}`;
  });

  if (rule) {
    lines.push(
      "",
      `this machine: ${totalGb!.toFixed(0)} GB installed → ${rule.tier} tier${rule.model ? ` · ${rule.model}` : ""}`,
      `  ${rule.why}`,
    );
    if (rule.tier === "api") {
      const a = apiModel();
      lines.push(
        `  worker inference is billed: $${a.rates_usd_per_mtok.input}/MTok in, $${a.rates_usd_per_mtok.output}/MTok out (rates as of ${a.rates_as_of})`,
        "  the zero-worker-tokens guarantee is a local-tier guarantee and does not hold here (ADR-0045)",
      );
    }
  }
  const unpinned = rs.filter((r) => r.snapshot && !r.pinned_and_present);
  if (unpinned.length) {
    lines.push("", "downloaded but not pinned — survival rates from different revisions are not comparable:");
    for (const r of unpinned) lines.push(`  sidecrew models --pin ${r.entry.key}   # ${short(r.snapshot!.revision)}`);
  }
  return lines.join("\n");
};

export interface ModelsOpts { pin?: string | true; json?: boolean; totalGb?: number | null }

export async function modelsCommand(opts: ModelsOpts): Promise<void> {
  const cacheDir = hubCacheDir();

  if (opts.pin) {
    const keys = opts.pin === true ? entries().map((e) => e.key) : [String(opts.pin)];
    let wrote = 0;
    for (const key of keys) {
      const e = entry(key);
      const snap = await resolveSnapshot(e.repo, cacheDir);
      if (!snap) {
        process.stdout.write(`${key}: nothing in the HF cache — download it first (sidecrew serve --model ${key})\n`);
        continue;
      }
      if (snap.revision === e.revision) {
        process.stdout.write(`${key}: already pinned to ${short(snap.revision)}\n`);
        continue;
      }
      await writePin(key, snap.revision);
      wrote += 1;
      process.stdout.write(`${key}: pinned ${short(e.revision) === "—" ? "" : `${short(e.revision)} → `}${short(snap.revision)}\n`);
    }
    if (wrote) {
      process.stdout.write(isCheckout()
        ? "\nsrc/models.json changed — commit it, or the pin is only on this machine.\n"
        : `\n${MODELS_JSON_PATH} changed. This is an installed copy, so the pin lasts until the next upgrade of sidecrew.\n`);
    }
    return;
  }

  const rs = await rows(cacheDir);
  const totalGb = opts.totalGb ?? null;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ default: defaultKey(), cache_dir: cacheDir, tier: totalGb === null ? null : tierFor(totalGb), models: rs }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderModels(rs, totalGb)}\n`);
}
