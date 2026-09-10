// `sidecrew doctor` — report each capability separately, like simframe. Phase 0 implements the checks.
// ok   node            v22.x
// ok   mlx_lm          python3 -m mlx_lm.server available
// ok   worker          http://localhost:8000/v1 · Qwen2.5-Coder-7B-Instruct-4bit · rev abc123
// ok   memory          31.9 GB total · 17.2 GB free
// ok   tsc / vitest / stryker
// ok   swift / muter
export async function doctor(): Promise<void> {
  throw new Error("Phase 0 — see docs/plan/prompts/phase-0-scaffold.md");
}
