// OpenAI-compatible client for the local MLX worker (mlx_lm.server). Phase 1.
// Invariants: never points at api.anthropic.com; temperature 0 + seed mandatory; retry once on connection error only.
export interface CompleteOpts { model: string; messages: { role: "system" | "user"; content: string }[]; seed: number; maxTokens?: number; stop?: string[] }
export async function complete(_opts: CompleteOpts): Promise<never> {
  throw new Error("Phase 1 — see docs/plan/prompts/phase-1-worker.md");
}
