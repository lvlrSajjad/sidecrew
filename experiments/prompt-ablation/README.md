# Prompt ablation

What the exemplar is worth, and what the shape rules are worth on top of it. Run:

```bash
sidecrew serve
npm run measure:prompt-ablation                 # all variants → results/prompt-ablation-<date>.json
npx tsx scripts/prompt-ablation.ts --only bare  # one variant, merged into that file
```

`variants/` holds the prompts, one file each. `variants/exemplar-rules.md` is the winner and
`src/prompts/worker.md` is byte-identical to it — `test/prompt.test.ts` fails if they drift, so editing
the shipped prompt means rerunning this.

Result and caveats: `experiments/go-no-go/results/prompt-ablation-2026-09-14.json` and ADR-0017. The
short version is that `bare` lost 15 of its 20 tasks to one missing `import { describe, it, expect } from
"vitest"`, and a single sentence naming that import scores one *above* the full exemplar.

## candidates/

Raw worker output, kept because a compile column nobody can look behind is exactly the shape of Phase 4's
most expensive hour — a funnel that read like a bad model and was a serving detail.

Only `bare/` and `bare-import/` are checked in: candidate persistence was added to the script *after* the
first run, and those two are the rows the argument actually rests on. `exemplar/` and `exemplar-rules/`
are not here and are not lost — generation is deterministic at temperature 0 and seed 42, so
`--only exemplar` reproduces them byte for byte. `--only bare` was rerun after the fact and returned an
identical funnel, task for task, which is the evidence for that claim rather than the assumption.
