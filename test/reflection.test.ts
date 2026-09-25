// The reflective-reference guard, against planted traps (V1-CHALLENGES §11): code a NestJS/TypeORM project
// reaches by reflection, which `tsc`, a reference count and a green suite all miss. Each trap must be refused;
// a genuinely unused declaration must still be removable.
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globTailMatches, reflectiveBreaches, runtimeGlobs } from "../src/reflection.js";
import { ChangeTask, type ChangeCandidate } from "../src/schemas.js";

let dir = "";
const FILES: Record<string, string> = {
  "src/app.module.ts": [
    "export const ORM = { entities: [__dirname + '/**/*.entity{.ts,.js}'] };",
    "export const PROVIDERS = [{ provide: 'LegacyMailer', useValue: null }];",
  ].join("\n"),
  // Loaded only by the glob above: nothing imports it.
  "src/audit.entity.ts": "export class AuditRow { id = 1; }\nexport function unusedEntityHelper(): number { return 1; }\n",
  "src/mail.ts": [
    "const Injectable = (): ClassDecorator => () => {};",
    "const Cron = (_s: string): MethodDecorator => () => {};",
    "export class LegacyMailer { send(): void {} }",
    "@Injectable()",
    "export class Scheduler {",
    "  @Cron('0 * * * *') nightly(): void {}",
    "  helper(): void {}",
    "}",
    "export function reallyUnused(): number { return 2; }",
    "",
  ].join("\n"),
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sidecrew-reflect-"));
  await mkdir(join(dir, "src"));
  for (const [p, t] of Object.entries(FILES)) await writeFile(join(dir, p), t);
  await writeFile(join(dir, "package.json"), '{"name":"r","private":true}');
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const task = (path: string): ChangeTask => ChangeTask.parse({
  task_id: "t", language: "typescript", test_framework: "jest", ask: "remove dead code",
  files: [{ path, source: FILES[path]!, source_sha: "sha", errors: 0 }],
  diagnostics: "", max_deleted_lines: 50, notes: null, attempt: 0, retry_of: null, previous_error: null,
  correction: null, shape: "dead_code",
});
const candidate = (path: string, contents: string): ChangeCandidate => ({
  task_id: "t", worker: { kind: "local", model: "m", revision: "", temperature: 0, seed: 42 },
  edits: [{ path, contents }], symbol_edits: [], unparsed: null, refusal: null, truncated: false,
  usage: { prompt_tokens: 0, completion_tokens: 0 }, timing: { ttft_ms: 0, wall_ms: 0 },
}) as ChangeCandidate;
const without = (path: string, line: string) => FILES[path]!.split("\n").filter((l) => !l.includes(line)).join("\n");

describe("reflectiveBreaches — refuses what reflection reaches", () => {
  it("refuses deleting a class named as a DI string token elsewhere", () => {
    const b = reflectiveBreaches(task("src/mail.ts"), candidate("src/mail.ts", without("src/mail.ts", "class LegacyMailer")), dir);
    expect(b.map((x) => x.detail).join("\n")).toMatch(/LegacyMailer is named as the string 'LegacyMailer' in src\/app\.module\.ts/);
  });

  it("refuses deleting a decorated class, and a decorated member", () => {
    const noClass = FILES["src/mail.ts"]!.replace(/@Injectable\(\)\nexport class Scheduler \{[\s\S]*?\n\}\n/, "");
    expect(reflectiveBreaches(task("src/mail.ts"), candidate("src/mail.ts", noClass), dir).map((x) => x.detail).join("\n"))
      .toMatch(/Scheduler is decorated/);
    const noCron = without("src/mail.ts", "nightly()");
    expect(reflectiveBreaches(task("src/mail.ts"), candidate("src/mail.ts", noCron), dir).map((x) => x.detail).join("\n"))
      .toMatch(/Scheduler\.nightly is decorated/);
  });

  it("refuses removing anything from a file a runtime glob loads", () => {
    const b = reflectiveBreaches(task("src/audit.entity.ts"), candidate("src/audit.entity.ts", without("src/audit.entity.ts", "class AuditRow")), dir);
    expect(b.map((x) => x.detail).join("\n")).toMatch(/matches the runtime glob '\/\*\*\/\*\.entity\{\.ts,\.js\}'/);
  });

  it("refuses a rename of a string-token class too — the old name disappears", () => {
    const renamed = FILES["src/mail.ts"]!.replace("class LegacyMailer", "class OldMailer");
    expect(reflectiveBreaches(task("src/mail.ts"), candidate("src/mail.ts", renamed), dir)).not.toEqual([]);
  });
});

describe("reflectiveBreaches — still lets the real thing through", () => {
  it("allows deleting a genuinely unused, undecorated, untokened declaration", () => {
    expect(reflectiveBreaches(task("src/mail.ts"), candidate("src/mail.ts", without("src/mail.ts", "reallyUnused")), dir)).toEqual([]);
  });

  it("allows an undecorated member of a decorated class", () => {
    expect(reflectiveBreaches(task("src/mail.ts"), candidate("src/mail.ts", without("src/mail.ts", "helper()")), dir)).toEqual([]);
  });

  it("costs nothing when no name leaves the file", () => {
    const edited = FILES["src/mail.ts"]!.replace("return 2", "return 3");
    expect(reflectiveBreaches(task("src/mail.ts"), candidate("src/mail.ts", edited), dir)).toEqual([]);
  });
});

describe("globs", () => {
  it("finds file globs in string literals and matches their last segment", () => {
    expect(runtimeGlobs("entities: [__dirname + '/**/*.entity{.ts,.js}'], x: 'a*b'")).toEqual(["/**/*.entity{.ts,.js}"]);
    expect(globTailMatches("/**/*.entity{.ts,.js}", "src/audit.entity.ts")).toBe(true);
    expect(globTailMatches("/**/*.entity{.ts,.js}", "src/audit.service.ts")).toBe(false);
    // Written against compiled output, matched against the source — the dangerous direction to miss.
    expect(globTailMatches("dist/**/*.subscriber.js", "src/a.subscriber.ts")).toBe(true);
    expect(globTailMatches("dist/**/*.subscriber.js", "src/a.service.ts")).toBe(false);
  });
});
