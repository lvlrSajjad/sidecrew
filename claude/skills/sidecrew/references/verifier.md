# Reading a Verdict

| stage | what ran | fail means |
|---|---|---|
| compile | `tsc --noEmit` / `swift build` | worker used a wrong import, signature or type → retry with error |
| pass | `vitest run <file>` / `swift test --filter` | assertion wrong against real behaviour → retry with failing assertion text |
| mutation | Stryker / Muter on the single source file | `killed == 0` → the test is not sensitive to the code → retry with "your test killed no mutants" |
| tautology | static check | constant assertions, `expect(x).toBe(x)`, snapshot-only, never references the function → no retry, escalate |

`mutation.score` is killed / (killed + survived). Equivalent mutants can never be killed, so a low score is a
review signal, not automatically a failure. Survival requires killed ≥ 1, not a score threshold.

A test can kill mutants and still pin a bug (snapshot of current wrong output). That is why survivors below
`review_threshold` still get human/Claude eyes.
