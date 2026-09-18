// The artefact, not the gate (ADR-0048).
//
// A survivor is a change to somebody's source, and the thing a reviewer reads is a diff — so one is
// written to `.sidecrew/runs/<id>/diffs/<task>.diff` for every candidate that got far enough to have
// one. **Nothing in the gate reads it.** Every confinement rule is a count before against a count after
// (`confinement.ts`), precisely so that no verdict depends on which alignment an LCS happened to pick.
// That separation is the point: this file is allowed to be a heuristic because nothing branches on it.
//
// Unified format, three lines of context, because that is what `git apply` and every reviewer already
// know how to read. No dependency: the only runtime dependency this package has is the MCP SDK.

/** A hunk of the unified diff, in the format `@@ -a,b +c,d @@`. */
interface Hunk {
  beforeStart: number;
  beforeLines: string[];
  afterStart: number;
  afterLines: string[];
  body: string[];
}

/**
 * The classic dynamic-programming LCS, with the common prefix and suffix trimmed first.
 *
 * The trim is what makes this safe on a real file: the realistic shape of a 2a change is a few lines
 * altered in a few hundred, so the table is built over what actually differs rather than over the file.
 * `LIMIT` is the backstop for the case the trim does not help — a worker that reindented everything —
 * where the honest output is "this file was replaced" rather than a minute of table filling.
 */
const LIMIT = 4000;

const lcsMatrix = (a: string[], b: string[]): number[][] => {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
};

type Op = { kind: " " | "-" | "+"; text: string };

const script = (a: string[], b: string[]): Op[] => {
  if (a.length * b.length > LIMIT * LIMIT) {
    return [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];
  }
  const table = lcsMatrix(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: " ", text: a[i]! }); i += 1; j += 1; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ kind: "-", text: a[i]! }); i += 1; }
    else { ops.push({ kind: "+", text: b[j]! }); j += 1; }
  }
  while (i < a.length) { ops.push({ kind: "-", text: a[i]! }); i += 1; }
  while (j < b.length) { ops.push({ kind: "+", text: b[j]! }); j += 1; }
  return ops;
};

const CONTEXT = 3;

/** One file's unified diff, or the empty string when the two texts are identical. */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");

  // Trim what is the same at both ends, and remember how far in the remainder starts.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;

  const ops: Op[] = [
    ...a.slice(0, head).map((text) => ({ kind: " " as const, text })),
    ...script(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text) => ({ kind: " " as const, text })),
  ];

  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let beforeLine = 1;
  let afterLine = 1;
  let sinceChange = 0;

  const pending: Op[] = [];
  for (const op of ops) {
    if (op.kind === " ") {
      if (open === null) {
        pending.push(op);
        if (pending.length > CONTEXT) pending.shift();
      } else {
        open.body.push(` ${op.text}`);
        open.beforeLines.push(op.text);
        open.afterLines.push(op.text);
        sinceChange += 1;
        if (sinceChange === CONTEXT) { hunks.push(open); open = null; sinceChange = 0; }
      }
      beforeLine += 1;
      afterLine += 1;
      continue;
    }
    if (open === null) {
      open = {
        beforeStart: beforeLine - pending.length,
        afterStart: afterLine - pending.length,
        beforeLines: pending.map((p) => p.text),
        afterLines: pending.map((p) => p.text),
        body: pending.map((p) => ` ${p.text}`),
      };
      pending.length = 0;
    }
    sinceChange = 0;
    open.body.push(`${op.kind}${op.text}`);
    if (op.kind === "-") { open.beforeLines.push(op.text); beforeLine += 1; }
    else { open.afterLines.push(op.text); afterLine += 1; }
  }
  if (open !== null) hunks.push(open);

  const header = `--- a/${path}\n+++ b/${path}\n`;
  return header + hunks.map((h) =>
    `@@ -${h.beforeStart},${h.beforeLines.length} +${h.afterStart},${h.afterLines.length} @@\n${h.body.join("\n")}\n`,
  ).join("");
}

/** Every changed file's diff, concatenated — one artefact per task, in the order the task lists them. */
export const diffOf = (files: { path: string; before: string; after: string }[]): string =>
  files.map((f) => unifiedDiff(f.path, f.before, f.after)).filter((d) => d !== "").join("");
