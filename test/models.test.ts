import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSupportedMachine, apiTierOptIn, SUPPORTED_MIN_RAM_GB, UnsupportedMachineError,
  entries, entry, defaultKey, tierFor, modelForMachine, hubCacheDir, repoDirName,
  resolveSnapshot, resolveForServe, pinRevision, writePin, rows, short, isCheckout, MODELS_JSON_PATH,
} from "../src/models.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

let cache: string;
beforeAll(async () => { cache = await mkdtemp(join(tmpdir(), "sidecrew-hf-")); });
afterAll(async () => { await rm(cache, { recursive: true, force: true }); });

/** Lay out a repo in the cache the way huggingface_hub does. */
const plant = async (repo: string, revisions: string[], ref?: string): Promise<void> => {
  const root = join(cache, repoDirName(repo));
  for (const rev of revisions) {
    await mkdir(join(root, "snapshots", rev), { recursive: true });
    await writeFile(join(root, "snapshots", rev, "model.safetensors"), "x".repeat(2048));
  }
  if (ref) {
    await mkdir(join(root, "refs"), { recursive: true });
    await writeFile(join(root, "refs", "main"), `${ref}\n`);
  }
};

describe("the pin file", () => {
  it("names a default that is one of its own entries", () => {
    expect(entries().map((e) => e.key)).toContain(defaultKey());
  });

  it("ships only permissive licences — non-negotiable #6", () => {
    for (const e of entries()) expect(["Apache-2.0", "MIT"]).toContain(e.licence);
  });

  it("refuses an unknown key with the list of known ones", () => {
    expect(() => entry("llama-999b")).toThrow(/unknown model 'llama-999b'.*qwen2\.5-coder-7b-4bit/s);
  });
});

describe("tierFor", () => {
  it("puts the 32 and 24 GB machines on the local tier with a model to run — ADR-0009", () => {
    for (const gb of [32, 24, 36, 64]) {
      expect(tierFor(gb).tier).toBe("local");
      expect(modelForMachine(gb)?.key).toBe("qwen2.5-coder-7b-4bit");
    }
  });

  it("sends a 16 GB machine to the api tier with nothing to host — ADR-0009, ADR-0060", () => {
    expect(tierFor(16).tier).toBe("api");
    expect(tierFor(8).tier).toBe("api");
    // The rule names a model now (ADR-0060 filled in ADR-0045 §2's pin), and it is still nothing this
    // machine *hosts*: a hosted id is not a key in `models` and nothing downloads it. `modelForMachine`
    // answers about hosting, so it is still null, and the id is reached through `apiModel()`.
    expect(tierFor(16).model).toBe("claude-haiku-4-5");
    expect(modelForMachine(16)).toBeNull();
    expect(modelForMachine(8)).toBeNull();
  });

  it("reads 'installed 32 GB' from a measurement that is a little under it", () => {
    // hw.memsize / 1024³ on a 32 GB machine is 32.0, but a 24 GB machine can measure 23.6 — the tier is
    // a property of the sticker, not of the third decimal place.
    expect(tierFor(23.6).tier).toBe("local");
    expect(tierFor(31.8).tier).toBe("local");
  });

  it("explains itself, because the answer costs the user either RAM or tokens", () => {
    expect(tierFor(16).why).toMatch(/\S/);
    expect(tierFor(32).why).toMatch(/\S/);
  });
});

describe("resolveSnapshot", () => {
  it("finds nothing when nothing is downloaded", async () => {
    expect(await resolveSnapshot("mlx-community/Nothing-Here", cache)).toBeNull();
  });

  it("uses refs/main when it is there", async () => {
    await plant("test/one", [SHA], SHA);
    const snap = await resolveSnapshot("test/one", cache);
    expect(snap?.revision).toBe(SHA);
    expect(snap?.path).toContain(SHA);
    expect(snap?.ambiguous).toBe(false);
  });

  it("accepts a lone snapshot with no ref — a cache filled by hand still has one answer", async () => {
    await plant("test/two", [SHA]);
    expect((await resolveSnapshot("test/two", cache))?.revision).toBe(SHA);
  });

  it("refuses to guess between two snapshots with no ref to break the tie", async () => {
    await plant("test/three", [SHA, OTHER]);
    expect(await resolveSnapshot("test/three", cache)).toBeNull();
  });

  it("marks the answer ambiguous when the ref decided among several", async () => {
    await plant("test/four", [SHA, OTHER], OTHER);
    const snap = await resolveSnapshot("test/four", cache);
    expect(snap?.revision).toBe(OTHER);
    expect(snap?.ambiguous).toBe(true);
  });
});

describe("hubCacheDir", () => {
  it("follows huggingface_hub's own precedence", () => {
    expect(hubCacheDir({ HF_HUB_CACHE: "/a" })).toBe("/a");
    expect(hubCacheDir({ HF_HOME: "/b" })).toBe("/b/hub");
    expect(hubCacheDir({ HF_HUB_CACHE: "/a", HF_HOME: "/b" })).toBe("/a");
    expect(hubCacheDir({ XDG_CACHE_HOME: "/c" })).toBe("/c/huggingface/hub");
  });
});

describe("resolveForServe", () => {
  const model = { key: "k", repo: "test/serve", revision: "", ram_gb: 1, licence: "MIT" };

  it("serves the cached snapshot path when the pin matches — the path IS the pin", async () => {
    // mlx_lm 0.31 has no --revision, so a repo id always means "whatever main is today". A snapshot
    // path is one immutable commit and cannot reach the network.
    await plant("test/serve", [SHA], SHA);
    const r = await resolveForServe({ ...model, revision: SHA }, cache);
    expect(r.pinned).toBe(true);
    expect(r.model).toContain(SHA);
    expect(r.warning).toBeNull();
  });

  it("warns, and does not claim a pin, when models.json has no revision yet", async () => {
    const r = await resolveForServe(model, cache);
    expect(r.pinned).toBe(false);
    expect(r.revision).toBe(SHA); // still reports what is actually on disk
    expect(r.warning).toMatch(/--pin/);
  });

  it("warns loudly when the cache holds a different commit than the pin", async () => {
    const r = await resolveForServe({ ...model, revision: OTHER }, cache);
    expect(r.pinned).toBe(false);
    expect(r.warning).toMatch(/re-pin|clear the cache/);
  });

  it("falls back to the repo id, and says so, when nothing is cached", async () => {
    const r = await resolveForServe({ ...model, repo: "test/absent", revision: OTHER }, cache);
    expect(r.model).toBe("test/absent");
    expect(r.pinned).toBe(false);
    expect(r.warning).toMatch(/whatever main is now/);
  });
});

describe("pinRevision", () => {
  // Deliberately shaped like the real file: a `tiers` block that names a model key *before* the
  // `models` block does. A fixture without it let a bug through that matching the first occurrence of
  // the key edits a tier rule, which has no revision field, instead of the model entry.
  const source = `{
  "default": "a",
  "tiers": [
    { "min_ram_gb": 24, "tier": "local", "model": "a", "why": "…" },
    { "min_ram_gb": 0, "tier": "api", "model": null, "why": "…" }
  ],
  "models": {
    "a": { "repo": "org/a", "revision": "", "ram_gb": 5.0, "licence": "Apache-2.0" },
    "b": { "repo": "org/b", "revision": "${OTHER}", "ram_gb": 9.0, "licence": "Apache-2.0" }
  }
}`;

  it("edits the model entry, not the tier rule that names the same key", () => {
    const out = pinRevision(source, "a", SHA);
    const parsed = JSON.parse(out) as { tiers: { model: string | null }[]; models: Record<string, { revision: string }> };
    expect(parsed.models.a.revision).toBe(SHA);
    expect(parsed.tiers[0].model).toBe("a");
  });

  it("changes one revision and nothing else — not even the whitespace", () => {
    const out = pinRevision(source, "a", SHA);
    expect(out).toBe(source.replace('"revision": ""', `"revision": "${SHA}"`));
    // The aligned one-line-per-model layout is the point: a pin should diff as a sha, not as a file.
    expect(out.split("\n")).toHaveLength(source.split("\n").length);
  });

  it("replaces an existing pin", () => {
    expect(JSON.parse(pinRevision(source, "b", SHA)).models.b.revision).toBe(SHA);
  });

  it("does not reach into the next entry", () => {
    expect(JSON.parse(pinRevision(source, "a", SHA)).models.b.revision).toBe(OTHER);
  });

  it("refuses a value that is not a commit sha", () => {
    for (const bad of ["", "main", "../../etc", "zzzz", `"; rm -rf /`]) {
      expect(() => pinRevision(source, "a", bad)).toThrow(/not a commit sha/);
    }
  });

  it("refuses a key it cannot find", () => {
    expect(() => pinRevision(source, "c", SHA)).toThrow(/no entry 'c'/);
  });
});

describe("writePin", () => {
  it("pins every key in the real models.json — the file is the fixture that matters", async () => {
    // A hand-written fixture can drift from the file this code actually edits; this cannot.
    const path = join(cache, "real-models.json");
    await writeFile(path, await readFile(MODELS_JSON_PATH, "utf8"));
    for (const e of entries()) {
      await writePin(e.key, SHA, path);
      const parsed = JSON.parse(await readFile(path, "utf8")) as { models: Record<string, { revision: string }> };
      expect(parsed.models[e.key].revision).toBe(SHA);
    }
  });

  it("writes the file, and the result parses to the same JSON with one field changed", async () => {
    const path = join(cache, "models.json");
    const before = await readFile(MODELS_JSON_PATH, "utf8");
    await writeFile(path, before);

    await writePin("qwen2.5-coder-14b-4bit", SHA, path);
    const after = JSON.parse(await readFile(path, "utf8")) as { models: Record<string, { revision: string }> };
    expect(after.models["qwen2.5-coder-14b-4bit"].revision).toBe(SHA);
    expect(after.models["qwen2.5-coder-7b-4bit"].revision).toBe(JSON.parse(before).models["qwen2.5-coder-7b-4bit"].revision);
  });
});

describe("isCheckout", () => {
  it("knows a source tree from an installed copy, because only one of them can be committed", () => {
    expect(isCheckout("/Users/me/proj/src/models.json")).toBe(true);
    expect(isCheckout("/usr/local/lib/node_modules/sidecrew/dist/models.json")).toBe(false);
    expect(isCheckout("/Users/me/proj/node_modules/sidecrew/dist/models.json")).toBe(false);
  });

  it("says the repo we are running from is a checkout", () => {
    expect(isCheckout()).toBe(true);
  });
});

describe("rows", () => {
  it("reports what is downloaded and whether it is the pinned commit", async () => {
    const rs = await rows(cache);
    expect(rs).toHaveLength(entries().length);
    // Nothing for the real repos lives in this temp cache.
    for (const r of rs) {
      expect(r.snapshot).toBeNull();
      expect(r.pinned_and_present).toBe(false);
      expect(r.bytes).toBe(0);
    }
  });
});

describe("short", () => {
  it("shortens a sha and marks the absence of one", () => {
    expect(short(SHA)).toBe("a".repeat(12));
    expect(short("")).toBe("—");
  });
});

describe("sidecrew is a 24 GB+ tool — ADR-0073", () => {
  it("refuses a machine under the floor, and names the floor and the reason", () => {
    // The point is not that it throws — it is what the user is told. A silent fallback to a tier
    // nobody has measured is what this replaced, and the message has to carry ADR-0032's three parts:
    // the cause, whose fault it is, and the exact fix.
    expect(() => assertSupportedMachine({ total_gb: 16 }, undefined, {})).toThrow(UnsupportedMachineError);
    try {
      assertSupportedMachine({ total_gb: 16 }, undefined, {});
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("16.0 GB");
      expect(m).toContain(`${SUPPORTED_MIN_RAM_GB} GB`);
      expect(m).toContain("SIDECREW_TIER=api");
      expect(m).toContain("never been measured");
    }
  });

  it("allows the supported floor, including the half-gigabyte slack the tier rules already use", () => {
    expect(() => assertSupportedMachine({ total_gb: 24 }, undefined, {})).not.toThrow();
    expect(() => assertSupportedMachine({ total_gb: 32 }, undefined, {})).not.toThrow();
    // 23.6 GB is a 24 GB machine as far as `hw.memsize` reports it; `tierFor` already grants this.
    expect(() => assertSupportedMachine({ total_gb: 23.6 }, undefined, {})).not.toThrow();
  });

  it("never selects the api tier from RAM — only from an explicit opt-in", () => {
    // The whole of ADR-0073. `tierFor` still *describes* both tiers so recorded results keep
    // resolving, and nothing reaches the api path by looking at a machine's size.
    expect(apiTierOptIn({})).toBe(false);
    expect(apiTierOptIn({ SIDECREW_TIER: "local" })).toBe(false);
    expect(apiTierOptIn({ SIDECREW_TIER: "api" })).toBe(true);
    expect(() => assertSupportedMachine({ total_gb: 16 }, undefined, { SIDECREW_TIER: "api" })).not.toThrow();
  });

  it("does not second-guess a caller that named the worker kind", () => {
    // An experiment harness or a replay is not choosing a tier by looking at RAM, and Phase 11b's
    // arm D runs `workerKind: "api"` on purpose with no API call in sight.
    expect(() => assertSupportedMachine({ total_gb: 8 }, "api", {})).not.toThrow();
    expect(() => assertSupportedMachine({ total_gb: 8 }, "local", {})).not.toThrow();
    // Memory it could not read is not a machine it can refuse.
    expect(() => assertSupportedMachine(null, undefined, {})).not.toThrow();
  });
});
