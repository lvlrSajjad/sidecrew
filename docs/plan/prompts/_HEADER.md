# How to use these prompts

Open Claude Code in the repo root with Opus selected. Paste the phase prompt verbatim.
Each prompt is self-contained but assumes Claude will read `CLAUDE.md`, `docs/plan/PHASES.md`
and `docs/specs/pipeline.md` first (they tell it to).

Between sessions: `git log`, `docs/CHANGELOG.md` and the status column in `PHASES.md` are the handover.
If a session runs out of context mid-phase, start a new one with:

> Continue phase N of sidecrew. Read CLAUDE.md, docs/plan/PHASES.md and docs/CHANGELOG.md, then `git status` and `git log -5`, and pick up where the last session stopped. Do not start over.
