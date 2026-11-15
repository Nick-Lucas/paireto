import { z } from "zod";

import { VizFileRef } from "../../protocol/viz.js";
import type { VizViewState, WebviewToHost } from "../protocol.js";

const short = z.string().min(1).max(400);
const body = z.string().max(20_000);
const kind = z.enum(["question", "comment"]);

const NoteTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), id: short, label: short }),
  z.object({ kind: z.literal("member"), id: short, node: short, label: short }),
  z.object({ kind: z.literal("edge"), id: short, label: short }),
  z.object({ kind: z.literal("file"), repo: short, path: short, label: short }),
]);

const NotePlace = z.object({
  node: short.optional(),
  x: z.number().finite(),
  y: z.number().finite(),
});

const ViewState = z.object({
  stage: z.string().max(400),
  show: z.enum(["all", "api", "implementation", "fields"]),
  filters: z.object({ notSeen: z.boolean(), openThreads: z.boolean() }),
  grouping: z.enum(["links", "folders"]),
  sidebar: z.boolean(),
  sidebarWidth: z.number().finite(),
}) satisfies z.ZodType<VizViewState>;

const WebviewMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("open"), file: VizFileRef, mode: z.enum(["file", "diff"]) }),
  z.object({ type: z.literal("align") }),
  z.object({ type: z.literal("regenerate") }),
  z.object({ type: z.literal("switch"), name: z.string().min(1).max(200) }),
  z.object({ type: z.literal("copy"), text: z.string().max(1_000_000), what: z.string().max(80) }),
  z.object({ type: z.literal("seen"), repo: short, path: short, seen: z.boolean() }),
  z.object({ type: z.literal("resetSeen") }),
  z.object({ type: z.literal("viewState"), state: ViewState }),
  z.object({
    type: z.literal("note.add"),
    kind,
    title: z.string().max(400),
    body,
    targets: z.array(NoteTarget).max(50),
    place: NotePlace.optional(),
  }),
  z.object({
    type: z.literal("note.edit"),
    id: short,
    kind,
    body,
    targets: z.array(NoteTarget).max(50),
  }),
  z.object({ type: z.literal("note.reply"), id: short, body }),
  z.object({ type: z.literal("note.editReply"), id: short, body }),
  z.object({ type: z.literal("note.link"), id: short, target: NoteTarget }),
  z.object({ type: z.literal("note.unlink"), id: short, index: z.number().int().min(0) }),
  z.object({ type: z.literal("note.move"), id: short, place: NotePlace }),
  z.object({ type: z.literal("note.read"), id: short }),
  z.object({ type: z.literal("note.resolve"), id: short }),
  z.object({ type: z.literal("note.delete"), id: short }),
  z.object({ type: z.literal("gate"), action: z.enum(["sendFeedback", "approve"]) }),
]) satisfies z.ZodType<WebviewToHost>;

export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  const parsed = WebviewMessage.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseViewState(raw: unknown): VizViewState | undefined {
  const parsed = ViewState.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
