// Pipeline contracts — MUST mirror docs/specs/pipeline.md. Phase 0 completes this file.
import { z } from "zod";

export const ShapeKind = z.enum(["happy_path", "boundary", "error_or_throw", "async", "stateful_sequence", "property_like"]);
export const Language = z.enum(["typescript", "swift", "python", "kotlin"]);

export const TestShape = z.object({ kind: ShapeKind, exemplar: z.string(), rules: z.string() });
export type TestShape = z.infer<typeof TestShape>;

// TODO(phase-0): PlannedFunction, TestPlan, WorkerTask, Candidate, MutationResult, Verdict, BatchResult, StatusReport, ValidationReport
