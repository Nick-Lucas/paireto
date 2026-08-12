// The guided-review contract, in one declarative place: zod schemas with their agent-facing
// descriptions inline. Every harness advertises these same objects as the tool's arguments — the MCP
// servers through their input schema, OpenCode through its own custom tool — and the extension
// validates what arrives against them, so what the agent is told and what the window enforces cannot
// drift apart.
//
// Each schema and the type inferred from it share one name, so a caller imports the name it means
// and gets the schema, the type, or both.

import { z } from "zod";

export const CompareTo = z
  .object({
    kind: z
      .enum(["head", "mergeBase", "default", "ref"])
      .describe(
        "head: uncommitted work\nmergeBase: this branch since it forked\ndefault: the default branch tip\nref: the named ref.",
      ),
    ref: z.string().optional().describe("The git ref to compare against, if kind is `ref`."),
  })
  .describe("What you diffed against. Must match what you reviewed.");
export type CompareTo = z.infer<typeof CompareTo>;

export type CompareToKind = CompareTo["kind"];

export const GuidedChangesetFile = z.object({
  path: z.string().describe("Repository-relative path"),
});
export type GuidedChangesetFile = z.infer<typeof GuidedChangesetFile>;

export const GuidedChangeset = z.object({
  title: z.string().describe("Name for this changeset, e.g. the feature or fix it implements"),
  description: z.string().describe("Detailed description of the thread to review"),
  files: z.array(GuidedChangesetFile).describe("Ordered list of files for the user to review"),
});
export type GuidedChangeset = z.infer<typeof GuidedChangeset>;

/** The tool's arguments. Its `.shape` is what a harness turns into the advertised tool schema, and
 *  the whole object is what the extension validates an arriving payload against. */
export const GuidedReviewArgs = z.object({
  summary: z
    .string()
    .optional()
    .describe("One paragraph summarising the features/fixes/etc which were made."),
  compareTo: CompareTo.optional(),
  changesets: z
    .array(GuidedChangeset)
    .describe("Changed files grouped by logical threads/features/fixes."),
});
export type GuidedReviewArgs = z.infer<typeof GuidedReviewArgs>;

/** The comparison points named for the reviewer, who is reading a sidebar row rather than choosing
 *  an argument — so a short noun phrase, and the ref itself whenever there is one. */
const COMPARE_TO_LABEL: Record<CompareToKind, string> = {
  head: "HEAD",
  mergeBase: "the merge base",
  default: "the default branch",
  ref: "a named ref",
};

export function describeCompareTo(compareTo: CompareTo): string {
  return compareTo.kind === "ref" && compareTo.ref
    ? compareTo.ref
    : COMPARE_TO_LABEL[compareTo.kind];
}
