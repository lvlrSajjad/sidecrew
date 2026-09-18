// The candidate cache (ADR-0065). Every test here is about the key being *complete*, because a key that
// misses an input serves a candidate produced for a different question and nothing downstream can tell —
// ADR-0037's failure mode with a new way in.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CandidateCache, candidateKey, type CacheKeyInputs } from "../src/cache.js";
import { ChangeCandidate, ChangeTask } from "../src/schemas.js";

const scratch: string[] = [];
afterAll(async () => { for (const d of scratch) await rm(d, { recursive: true, force: true }); });

const dir = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "sidecrew-cache-"));
  scratch.push(d);
  return d;
};

const base: CacheKeyInputs = {
  prompt: "--- FILE: src/a.ts ---\nexport const a = 1;\n",
  model: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
  revision: "abc123",
  seed: 42,
  temperature: 0,
  maxTokens: 4096,
};

const task = (id = "t"): ChangeTask => ChangeTask.parse({
  task_id: id,
  language: "typescript",
  test_framework: "vitest",
  ask: "Fix every TypeScript error in these files without changing what the code does.",
  files: [{ path: "src/a.ts", source: "export const a = 1;\n", source_sha: "sha", errors: 1 }],
  diagnostics: "",
  max_deleted_lines: 0,
  notes: null,
  attempt: 0,
  retry_of: null,
  previous_error: null,
  correction: null,
  shape: "rename",
});

const candidate = (id = "t"): ChangeCandidate => ChangeCandidate.parse({
  task_id: id,
  worker: { kind: "local", model: base.model, revision: base.revision, temperature: 0, seed: 42 },
  edits: [{ path: "src/a.ts", contents: "export const a = 2;\n" }],
  unparsed: null,
  truncated: false,
  refusal: null,
  usage: { prompt_tokens: 100, completion_tokens: 20 },
  timing: { ttft_ms: 300, wall_ms: 13500 },
});

describe("candidateKey — every input that changes the bytes", () => {
  it("is stable for identical inputs", () => {
    expect(candidateKey(base)).toBe(candidateKey({ ...base }));
  });

  it("changes when the rendered prompt changes — which is how the template is covered", () => {
    // The decisive argument for keying on the rendered prompt rather than on the task: `fixer.md`
    // gained the refusal form on 18 Sep, and a task-keyed cache would have served candidates from the
    // previous template indefinitely with the task bytes identical.
    expect(candidateKey({ ...base, prompt: `${base.prompt}\n# If you cannot do it\n` })).not.toBe(candidateKey(base));
  });

  it("changes when the model, the revision, the seed or max_tokens changes", () => {
    for (const over of [
      { model: "other-model" },
      { revision: "def456" },
      { seed: 43 },
      { maxTokens: 8192 },
      { temperature: 0.2 },
    ] as Partial<CacheKeyInputs>[]) {
      expect(candidateKey({ ...base, ...over }), JSON.stringify(over)).not.toBe(candidateKey(base));
    }
  });

  it("cannot be collided by shifting a character between two fields", () => {
    // `model: "a", revision: "bc"` and `model: "ab", revision: "c"` must not concatenate to one string.
    const left = candidateKey({ ...base, model: "a", revision: "bc" });
    const right = candidateKey({ ...base, model: "ab", revision: "c" });
    expect(left).not.toBe(right);
  });
});

describe("CandidateCache", () => {
  it("round-trips a candidate and counts the hit", async () => {
    const cache = new CandidateCache({ dir: await dir() });
    const key = candidateKey(base);
    expect(await cache.read(key, task())).toBeNull();

    await cache.write(key, candidate());
    const got = await cache.read(key, task());
    expect(got?.edits).toEqual(candidate().edits);
    expect(cache.hits).toBe(1);
    expect(cache.writes).toBe(1);
  });

  it("rewrites task_id, so a reused candidate is filed under the task that asked for it", async () => {
    // Two tasks can render the same prompt. Every downstream file is named after `task_id`, so returning
    // the original would file a verdict and a diff under the wrong name.
    const cache = new CandidateCache({ dir: await dir() });
    const key = candidateKey(base);
    await cache.write(key, candidate("first"));

    const got = await cache.read(key, task("second"));
    expect(got?.task_id).toBe("second");
  });

  it("misses rather than throws on a corrupt entry — a cache must fail slower, never wrong", async () => {
    const d = await dir();
    const cache = new CandidateCache({ dir: d });
    const key = candidateKey(base);
    await cache.write(key, candidate());

    // A killed run, a half-written file, a schema that moved on.
    const path = join(d, key.slice(0, 2), `${key}.json`);
    await writeFile(path, '{"task_id": "t", "edits": [', "utf8");
    expect(await cache.read(key, task())).toBeNull();

    await writeFile(path, '{"not": "a candidate"}', "utf8");
    expect(await cache.read(key, task())).toBeNull();
  });

  it("does not throw when it cannot write", async () => {
    const cache = new CandidateCache({ dir: "/proc/nonexistent/forbidden" });
    await expect(cache.write(candidateKey(base), candidate())).resolves.toBeUndefined();
    expect(cache.writes).toBe(0);
  });
});
