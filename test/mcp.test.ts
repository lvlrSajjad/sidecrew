// What Claude Code sees. The tool list is a contract with a model rather than with a compiler, so it
// is pinned here: a renamed tool breaks every skill that names it, and a description that stops saying
// "no Claude tokens" quietly removes the only thing a model has to decide with.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, SERVER_VERSION } from "../src/mcp.js";

const connect = async (): Promise<Client> => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([buildServer().connect(serverSide), client.connect(clientSide)]);
  return client;
};

describe("the sidecrew MCP server", () => {
  it("exposes exactly the thirteen tools the skill and the spec name", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "sidecrew_escalate", "sidecrew_fix", "sidecrew_fix_escalate", "sidecrew_fix_plan_validate",
      "sidecrew_generate", "sidecrew_plan_validate", "sidecrew_query", "sidecrew_read", "sidecrew_recon", "sidecrew_review",
      "sidecrew_run_batch", "sidecrew_status", "sidecrew_verify",
    ]);
    await client.close();
  });

  it("warns that sidecrew_fix is slow, because the cost is the project's own suite", async () => {
    // A model deciding between this tool and making the change itself is making a cost decision, and
    // the only place it can make it correctly is the description (ADR-0001). Phase 11 measured the gate
    // at 262 s per candidate and 95 % of a candidate's cost, so "minutes each" is the fact that matters
    // — not the 13.5 s of generation.
    const client = await connect();
    const { tools } = await client.listTools();
    const fix = tools.find((t) => t.name === "sidecrew_fix")?.description ?? "";
    expect(fix).toMatch(/SLOW/);
    expect(fix).toMatch(/zero Claude tokens/);
    await client.close();
  });

  it("names the two 2a escalations that are not the worker's fault", async () => {
    // Phase 11's project-b lost a task to an ENOTEMPTY teardown and it sat in `escalated`, where it
    // reads as "the worker could not do this". A model rewriting that by hand is doing work the
    // machine caused (ADR-0056), so the tool has to say so where the model will read it.
    const client = await connect();
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "sidecrew_fix_escalate")?.description ?? "";
    expect(d).toMatch(/machine_failure/);
    expect(d).toMatch(/refused/);
    await client.close();
  });

  it("says recon counts and does not offer to fix — PHASES.md 14d, ADR-0090 §3", async () => {
    // A model that reads "763 errors" and promises the user a fix has converted a quiet limitation into
    // a loud broken promise. The only place to stop it is the description it decides from.
    const client = await connect();
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "sidecrew_recon")?.description ?? "";
    expect(d).toMatch(/does not offer to fix/);
    expect(d).toMatch(/zero Claude tokens/);
    await client.close();
  });

  it("says an admitted read is evidence that exists, not a relevant or complete answer — ADR-0090 §2", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "sidecrew_read")?.description ?? "";
    expect(d).toMatch(/NOT that the claim is relevant/);
    expect(d).toMatch(/zero Claude tokens/);
    expect(d).toMatch(/at\s+most 15/);
    await client.close();
  });

  it("tells a model which of the two queues costs nothing to assemble", async () => {
    // `escalate` and `review` read a finished run off disk. A model deciding whether to call them is
    // making a cost decision like any other (ADR-0001), and "no worker tokens" is the fact it needs.
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ["sidecrew_escalate", "sidecrew_review"]) {
      expect(tools.find((t) => t.name === name)?.description, name).toMatch(/no worker tokens/);
    }
    await client.close();
  });

  it("says in sidecrew_review's description that the threshold is per language", async () => {
    // ADR-0024. A caller that passes one threshold for both languages gets a Swift review of nothing,
    // and the tool description is the only place that can stop it before it happens.
    const client = await connect();
    const { tools } = await client.listTools();
    const review = tools.find((t) => t.name === "sidecrew_review");
    expect(review?.description).toMatch(/per language/);
    expect(Object.keys(review?.inputSchema.properties ?? {}).sort())
      .toEqual(["audit_fraction", "dir", "max_batch_tokens", "run_id", "threshold"]);
    await client.close();
  });

  it("says in the description that generation is local and costs no Claude tokens", async () => {
    // A model choosing between this tool and writing the test itself is making a cost decision, and
    // the cost has to be in the description for it to make that decision correctly (ADR-0001).
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ["sidecrew_generate", "sidecrew_run_batch"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, name).toMatch(/zero Claude tokens/);
      expect(tool?.description, name).toMatch(/this machine|localhost/);
    }
    await client.close();
  });

  it("takes its inputs from the contract, not from a second description of it", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const verify = tools.find((t) => t.name === "sidecrew_verify");
    expect(Object.keys(verify?.inputSchema.properties ?? {}).sort())
      .toEqual(["candidate", "function_name", "plan_path", "test_target"]);
    expect(verify?.inputSchema.required).toEqual(["candidate", "plan_path"]);

    const generate = tools.find((t) => t.name === "sidecrew_generate");
    const task = (generate?.inputSchema.properties as { task?: { required?: string[] } } | undefined)?.task;
    // The WorkerTask schema itself, so a caller cannot send something the pipeline would later refuse.
    expect(task?.required).toContain("exemplar_source");
    expect(task?.required).toContain("retry_of");
    await client.close();
  });

  it("answers a failure with the sentence that explains it, not with a broken call", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "sidecrew_run_batch", arguments: { plan_path: "nowhere/plan.json" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toMatch(/nowhere\/plan.json/);
    await client.close();
  });
});

describe("the version the server announces", () => {
  it("is the package's, because a client reads it to decide what it is talking to", async () => {
    // CI checks package.json, server.json and plugin.json against each other; this is the fourth copy,
    // and the one a compiler cannot see. It is a constant rather than an import so that `dist/` does not
    // have to reach outside itself for a string.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
