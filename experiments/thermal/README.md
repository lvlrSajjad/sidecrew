# Thermal soak — does an M2 Pro sag, and does the guard notice?

`npm run measure:thermal -- [--minutes 20] [--model KEY] [--concurrency 2] [--tag NAME]`

ADR-0025 shipped a thermal back-off that had never fired, because no run this project had done made the
machine sag. That is a fair thing to write in a phase note and a bad thing to leave in a published
package, so this is the experiment that closes it.

## What it measures, and what it cannot

Two claims, kept apart on purpose:

1. **Does the machine sag?** Decode rate per request over a long sustained soak, against the
   `sidecrew bench` baseline for the same model on the same machine. This is a fact about an M2 Pro and
   about research §E's thermal-throttling risk, and nobody had measured it.
2. **Does the guard react correctly to what the machine did?** A real `ThermalGuard` consumes the real
   samples at the real times — not a replay, not a fixture.

**A null result is a result.** If the machine holds its rate, the guard not firing is the *correct*
behaviour rather than a tested one, and that is a much weaker statement than "the guard works". The
report says so in its own `verdict` field rather than leaving a reader to infer it.

The workload is the bench prompt on a loop, not a real plan: a `sidecrew run` spends ~90 % of its wall
clock in the verifier, which loads the CPU and leaves the worker idle. The thing being asked to sag is
the model, so the soak keeps it generating continuously — harsher than any real run, deliberately.

`--concurrency 2` is a **hypothetical** on a one-worker soak. The guard's only action is to retire a
worker slot, and a run that started at 1 has nothing to give up, so giving it 2 is what makes "would it
have fired" answerable at all. The results file records it rather than implying a two-worker run happened.

## Result — 14 Sep 2026, 22 minutes

`results/thermal-2026-09-14.json`, `"measured": true`. M2 Pro / 32 GB, macOS 26.6.2, **on mains**, Xcode
**and** a simulator open throughout, 9.3–9.7 GB free, qwen2.5-coder-7b-4bit @ `019cc73c45c7` (pinned).
129 requests, 400 completion tokens each, seed 42, temperature 0. Baseline 40.5 tok/s from
`bench-2026-09-11.json`; the back-off floor is therefore **28.3 tok/s**.

| | |
|---|---|
| median decode over the soak | **40.5 tok/s** — the baseline, exactly |
| first minute · last minute | 39.6 · 40.4 tok/s |
| slowest single request | **25.8 tok/s** (64 % of baseline) |
| worst two-minute median | **30.5 tok/s** (75 % of baseline) |
| back-offs | **none**, and correctly so |
| swapped out | 0 MB · memory pressure `normal` in all 129 samples |

**It did not thermally throttle, and it did not hold perfectly still either.** There is one dip, and it
is localised: between t = 237 s and t = 322 s, seven consecutive requests fell to 31.4, 28.7, 25.8, 26.7,
26.7, 30.5 and 32.9 tok/s — and then the machine recovered completely and held 40.1–40.8 tok/s for the
remaining seventeen minutes. Per five-minute block: 40.1, 40.5, 40.8, 40.7, 40.1.

That shape is **not** thermal. Throttling is progressive and it stays; this arrives, lasts ninety
seconds and leaves, which is what contention from something else on the machine looks like. So the
honest reading is: **research §E's "sustained batches on a laptop M2 Pro sag" did not reproduce here**,
under the one condition that matters most — *on mains*. Nothing in this run says what happens on battery,
which is where macOS throttles hardest and which this experiment cannot arrange.

## The near-miss is the useful part

Four of those seven requests were **below the 28.3 tok/s floor on their own**. The guard declined anyway,
because the quantity it tests is the *median of the trailing two minutes*, which bottomed out at 30.5 —
75 % of baseline against a 70 % floor.

That is the guard's whole design working on real data rather than on a fixture: a dip that recovers is
not a sag, and a rule that read single samples would have retired a worker slot for the rest of the run
on the strength of ninety seconds. It also says the threshold is not set absurdly far from what this
machine actually does — had the dip lasted about another minute, it would have fired.

**What is still not tested:** a back-off that this run *did* produce, and therefore the wiring downstream
of it — that `runBatch` retires a runner and the run finishes at lower concurrency. `ThermalGuard`'s
decision is covered by `test/throttle.test.ts` against synthetic sags; the runner standing down is not
covered anywhere, and cannot be on CI, where `readMemory` returns `null` and `planConcurrency` therefore
returns 1. See `docs/plan/BACKLOG.md`.

## Re-running it

An existing worker is used if one is up, and started and stopped if not. A results file is never
overwritten — pass `--tag` to put a run beside another, the same rule `sidecrew bench` follows.

The conditions that would most change the answer, in the order they are likely to matter: **on battery**,
then a smaller machine where the working set competes for memory, then a 14B, then a genuinely hot room.
