#!/usr/bin/env node
// sidecrew CLI. Subcommands mirror simframe: doctor | serve | stop | plan | run | verify | status | mcp
import { doctor } from "./doctor.js";
import { runMcp } from "./mcp.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
const usage = `sidecrew — local workers behind a verifier, for Claude Code

  sidecrew doctor                      what this machine can do
  sidecrew serve [--model KEY] [--port 8000]   start a pinned mlx_lm.server worker
  sidecrew stop  [--port 8000]
  sidecrew status                      worker, model, free RAM
  sidecrew plan <module>               (Claude-side; see claude/skills) validate a test_plan.json
  sidecrew run  <test_plan.json> [--concurrency N] [--dry-run]
  sidecrew verify <test-file> --plan <test_plan.json>
  sidecrew mcp                         stdio MCP server (what Claude Code launches)
`;

const main = async () => {
  switch (cmd) {
    case "doctor": return doctor();
    case "mcp": return runMcp();
    case "serve": case "stop": case "status": case "plan": case "run": case "verify":
      throw new Error(`'${cmd}' not implemented yet — see docs/plan/PHASES.md`);
    default: process.stdout.write(usage);
  }
};
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
void rest;
