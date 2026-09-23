#!/usr/bin/env node
// sidecrew CLI. Subcommands mirror simframe:
// doctor | models | serve | stop | status | plan | run | verify | generate | escalate | review | bench | mcp
import { doctor, DEFAULT_PORT, readMemory } from "./doctor.js";
import { runMcp } from "./mcp.js";
import { modelsCommand } from "./models.js";
import { serve, stop, status } from "./serve.js";
import { bench, benchDeterminism } from "./bench.js";
import { escalateCommand, fixCommand, fixReportCommand, fixSweepCommand, fixValidateCommand, generateCommand, planCommand, reviewCommand, runCommand, verifyCommand } from "./run.js";

import { installStryker, strykerStatus, toolStatusMessage } from "./tools.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
const usage = `sidecrew — local workers behind a verifier, for Claude Code

  sidecrew doctor [--port 8000] [--project DIR] [--json]  what this machine can do
  sidecrew models [--pin [KEY]] [--json]       pinned models, what is downloaded, this machine's tier
  sidecrew tools [--json]                      sidecrew's own pinned tools (Stryker), and whether they are installed
  sidecrew tools install [--force]             download the pinned Stryker (~62 MB) into ~/.sidecrew/tools —
                                       never into a project (ADR-0088)
  sidecrew serve [--model KEY] [--port 8000] [--force] [--wait SECONDS] [--allow-unpinned]
                                       start a pinned mlx_lm worker; refuses an unpinned revision,
                                       and --wait queues for free RAM instead of refusing
  sidecrew stop  [--port 8000]
  sidecrew status [--port 8000] [--json]       worker, model, revision, free RAM
  sidecrew bench [--model KEY] [--determinism] [--requests N] [--tag NAME] [--allow-unpinned]
                                       tok/s, TTFT, peak RSS → experiments/go-no-go/results/
  sidecrew run  <test_plan.json> [--concurrency N] [--dry-run] [--test-target T] [--json]
                                       generate → verify → retry once → escalate, for a whole plan
  sidecrew fix   <change_plan.json> [--concurrency N] [--dry-run] [--keep-sandbox] [--json]
                                       workload #2a: behaviour-preserving changes, gated by the
                                       project's own suite plus tsc. --dry-run captures the first
                                       step's baseline and stops before the first token
  sidecrew fix   <change_plan.json> [--cache]
                                       memoise task → candidate, local tier only. OFF by default and
                                       experiments must leave it off: a cached run's generate time is
                                       not a measurement (ADR-0065). Saves ~5%, not "nothing"
  sidecrew fix   <change_plan.json> [--resume RUN_ID]
                                       continue a run that stopped — a closed lid, a Ctrl-C, a reboot.
                                       Tasks already answered come off disk; no worker is spent twice
  sidecrew fix   --sweep [--older-than H] [--dry-run] [--json]
                                       remove sandboxes an interrupted run left behind. Never touches
                                       anything younger than H (default 12), because two runs share a
                                       machine and recency cannot tell "in use" from "idle"
  sidecrew fix   --report [RUN_ID] [--json]
                                       what to read first, after a run nobody watched: combined
                                       regressions, then machine failures, then refusals, then
                                       escalations, then survivors that did something unasked
  sidecrew fix   <change_plan.json> --validate [--no-compile] [--json]
                                       check a plan before a run spends anything on it, and refuse
                                       the tasks no worker could pass — a file too large to return
                                       whole, a pre-existing tsc error the ask does not cover.
                                       --no-compile is the fast structural pass and skips both
  sidecrew verify <test-file> --plan <test_plan.json> [--function F] [--test-target T] [--keep-sandbox] [--json]
  sidecrew generate (<task.json> | --plan P --function F --shape S) [--out FILE]
  sidecrew plan <test_plan.json> [--quick] [--test-target T] [--json]
                                       validate a plan: schema, ranges, and every exemplar survives
  sidecrew escalate [RUN_ID] [--model sonnet] [--json]
                                       what the workers could not do, with the exemplar and both failures
  sidecrew review [RUN_ID] [--threshold N] [--audit F] [--max-tokens N] [--json]
                                       survivors worth Claude's eyes: below the threshold, plus an audit sample
  sidecrew mcp                         stdio MCP server (what Claude Code launches)
`;

/** `--flag value` and `--flag=value` both, because both get typed. */
const value = (argv: string[], flag: string): string | undefined => {
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  const next = at === -1 ? undefined : argv[at + 1];
  return next && !next.startsWith("--") ? next : undefined;
};

const has = (argv: string[], flag: string): boolean => argv.includes(flag);

const portOf = (argv: string[]): number => {
  const raw = value(argv, "--port") ?? process.env.SIDECREW_PORT;
  const port = Number(raw ?? DEFAULT_PORT);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
};

const main = async () => {
  // `sidecrew serve --help` used to start a worker. Every subcommand reads its flags positionally and
  // none of them looked for this one, so asking a question performed the action (ADR-0029).
  if (cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(usage);
    return;
  }

  switch (cmd) {
    case "doctor": return doctor(rest);

    case "models": {
      // `--pin` alone pins everything downloaded; `--pin KEY` pins one.
      const pin = has(rest, "--pin") ? (value(rest, "--pin") ?? true) : undefined;
      const mem = await readMemory();
      return modelsCommand({ pin, json: has(rest, "--json"), totalGb: mem?.total_gb ?? null });
    }

    case "tools": {
      // ADR-0088: the one command that downloads a tool. The verifier never does — it refuses and says
      // to run this, so a download is always something the user asked for.
      if (rest[0] === "install") {
        const status = await installStryker({ force: has(rest, "--force"), onEvent: (l) => process.stdout.write(`${l}\n`) });
        if (!status.ok) process.exitCode = 1;
        return;
      }
      const status = strykerStatus();
      if (has(rest, "--json")) process.stdout.write(`${JSON.stringify({ stryker: status }, null, 2)}\n`);
      else process.stdout.write(`${status.ok ? "ok      " : "MISSING "} ${toolStatusMessage(status)}\n`);
      if (!status.ok) process.exitCode = 1;
      return;
    }

    case "serve": {
      const wait = Number(value(rest, "--wait") ?? NaN);
      await serve({
        modelKey: value(rest, "--model"),
        port: portOf(rest),
        force: has(rest, "--force"),
        allowUnpinned: has(rest, "--allow-unpinned"),
        waitMs: Number.isFinite(wait) && wait > 0 ? wait * 1000 : undefined,
      });
      return;
    }

    case "stop":
      await stop({ port: portOf(rest) });
      return;

    case "status":
      return status({ port: portOf(rest), json: has(rest, "--json") });

    case "bench": {
      const requests = Number(value(rest, "--requests") ?? NaN);
      const opts = {
        port: portOf(rest),
        modelKey: value(rest, "--model"),
        requests: Number.isFinite(requests) && requests > 0 ? requests : undefined,
        force: has(rest, "--force"),
        allowUnpinned: has(rest, "--allow-unpinned"),
        tag: value(rest, "--tag"),
      };
      if (has(rest, "--determinism")) {
        const r = await benchDeterminism(opts);
        // A worker that is not reproducible invalidates every survival rate taken on it, so this one
        // exits non-zero: it is the check a CI job would run before trusting a number.
        process.exitCode = r.identical ? 0 : 1;
        return;
      }
      await bench(opts);
      return;
    }

    case "mcp": return runMcp();

    case "escalate": {
      await escalateCommand({
        runId: rest.find((a) => !a.startsWith("--")),
        dir: value(rest, "--dir"),
        model: value(rest, "--model"),
        json: has(rest, "--json"),
      });
      return;
    }

    case "review": {
      const num = (flag: string): number | undefined => {
        const n = Number(value(rest, flag) ?? NaN);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };
      await reviewCommand({
        runId: rest.find((a) => !a.startsWith("--")),
        dir: value(rest, "--dir"),
        threshold: num("--threshold"),
        auditFraction: num("--audit"),
        maxBatchTokens: num("--max-tokens"),
        json: has(rest, "--json"),
      });
      return;
    }

    case "run": {
      const plan = rest.find((a) => !a.startsWith("--"));
      if (plan === undefined) throw new Error("sidecrew run needs a test_plan.json");
      const concurrency = Number(value(rest, "--concurrency") ?? NaN);
      return runCommand({
        planPath: plan,
        concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : undefined,
        dryRun: has(rest, "--dry-run"),
        testTarget: value(rest, "--test-target"),
        json: has(rest, "--json"),
      });
    }

    case "fix": {
      // `--report` reads a finished run and takes no plan, so it is answered before the plan is
      // demanded. Asking for a change_plan.json to look at yesterday's run would be a question the
      // caller cannot answer after the plan has moved on.
      if (has(rest, "--sweep")) {
        const h = Number(value(rest, "--older-than") ?? NaN);
        await fixSweepCommand({
          olderThanHours: Number.isFinite(h) && h > 0 ? h : undefined,
          dryRun: has(rest, "--dry-run"),
          json: has(rest, "--json"),
        });
        return;
      }
      if (has(rest, "--report")) {
        await fixReportCommand({ runId: value(rest, "--report"), dir: value(rest, "--dir"), json: has(rest, "--json") });
        return;
      }
      const plan = rest.find((a) => !a.startsWith("--"));
      if (plan === undefined) {
        throw new Error(
          "sidecrew fix needs a change_plan.json — an ordered list of steps, each a list of tasks, each a " +
          "group of files and an ask (docs/specs/pipeline.md, ADR-0044). Writing one is Opus's job; this runs it.",
        );
      }
      if (has(rest, "--validate")) {
        // Before a token, not after: the gate costs 262 s per attempt (Phase 11), so a task no worker
        // could pass is nine minutes to learn what `tsc` already knew (ADR-0050 option C).
        const report = await fixValidateCommand({
          planPath: plan,
          compile: !has(rest, "--no-compile"),
          json: has(rest, "--json"),
        });
        process.exitCode = report.valid ? 0 : 1;
        return;
      }
      const concurrency = Number(value(rest, "--concurrency") ?? NaN);
      const result = await fixCommand({
        planPath: plan,
        concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : undefined,
        dryRun: has(rest, "--dry-run"),
        keepSandbox: has(rest, "--keep-sandbox"),
        json: has(rest, "--json"),
        resume: value(rest, "--resume"),
        cache: has(rest, "--cache"),
      });
      // Non-zero when nothing survived, so a script can tell "the run worked and found nothing" from
      // "the run worked". A dry run has no survivors by construction and is always 0.
      process.exitCode = has(rest, "--dry-run") || result.stats.survived > 0 ? 0 : 1;
      return;
    }

    case "verify": {
      const file = rest.find((a) => !a.startsWith("--"));
      const planPath = value(rest, "--plan");
      if (file === undefined || planPath === undefined) throw new Error("sidecrew verify needs <test-file> --plan <test_plan.json>");
      const verdict = await verifyCommand({
        testFile: file,
        planPath,
        functionName: value(rest, "--function"),
        taskId: value(rest, "--task-id"),
        testTarget: value(rest, "--test-target"),
        keepSandbox: has(rest, "--keep-sandbox"),
        json: has(rest, "--json"),
      });
      // Non-zero on a candidate that did not survive: `verify` is the thing a pre-commit hook or a
      // planner loop runs on an exemplar, and both need the answer in the exit code.
      process.exitCode = verdict.survived ? 0 : 1;
      return;
    }

    case "generate": {
      const positional = rest.find((a) => !a.startsWith("--"));
      return generateCommand({
        taskPath: positional,
        planPath: value(rest, "--plan"),
        functionName: value(rest, "--function"),
        shape: value(rest, "--shape"),
        outPath: value(rest, "--out"),
      });
    }

    case "plan": {
      const planPath = rest.find((a) => !a.startsWith("--"));
      if (planPath === undefined) {
        throw new Error(
          "sidecrew plan needs a test_plan.json. Writing one is the test-planner agent's job (claude/agents/test-planner.md) — " +
          "it reads the module; this validates what it wrote.",
        );
      }
      const concurrency = Number(value(rest, "--concurrency") ?? NaN);
      const report = await planCommand({
        planPath,
        // `--quick` skips verifying the exemplars, which is the expensive half and the half that means
        // something. Named for what it costs rather than for what it skips.
        quick: has(rest, "--quick"),
        testTarget: value(rest, "--test-target"),
        concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : undefined,
        json: has(rest, "--json"),
      });
      // Same contract as `verify`: the answer is in the exit code, because the planner loop and a
      // pre-commit hook both read it rather than the prose.
      process.exitCode = report.valid ? 0 : 1;
      return;
    }

    default: process.stdout.write(usage);
  }
};
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
