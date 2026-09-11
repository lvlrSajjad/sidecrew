#!/usr/bin/env node
// sidecrew CLI. Subcommands mirror simframe: doctor | models | serve | stop | status | plan | run | verify | bench | mcp
import { doctor, DEFAULT_PORT, readMemory } from "./doctor.js";
import { runMcp } from "./mcp.js";
import { modelsCommand } from "./models.js";
import { serve, stop, status } from "./serve.js";
import { bench, benchDeterminism } from "./bench.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
const usage = `sidecrew — local workers behind a verifier, for Claude Code

  sidecrew doctor [--port 8000] [--json]       what this machine can do
  sidecrew models [--pin [KEY]] [--json]       pinned models, what is downloaded, this machine's tier
  sidecrew serve [--model KEY] [--port 8000] [--force]   start a pinned mlx_lm worker
  sidecrew stop  [--port 8000]
  sidecrew status [--port 8000] [--json]       worker, model, revision, free RAM
  sidecrew bench [--model KEY] [--determinism] [--requests N] [--tag NAME]
                                       tok/s, TTFT, peak RSS → experiments/go-no-go/results/
  sidecrew plan <module>               (Claude-side; see claude/skills) validate a test_plan.json
  sidecrew run  <test_plan.json> [--concurrency N] [--dry-run]
  sidecrew verify <test-file> --plan <test_plan.json>
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
  switch (cmd) {
    case "doctor": return doctor(rest);

    case "models": {
      // `--pin` alone pins everything downloaded; `--pin KEY` pins one.
      const pin = has(rest, "--pin") ? (value(rest, "--pin") ?? true) : undefined;
      const mem = await readMemory();
      return modelsCommand({ pin, json: has(rest, "--json"), totalGb: mem?.total_gb ?? null });
    }

    case "serve":
      await serve({ modelKey: value(rest, "--model"), port: portOf(rest), force: has(rest, "--force") });
      return;

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

    case "plan": case "run": case "verify":
      throw new Error(`'${cmd}' not implemented yet — see docs/plan/PHASES.md`);

    default: process.stdout.write(usage);
  }
};
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
