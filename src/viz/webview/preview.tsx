import { VizFile } from "../../protocol/viz";
import classDiagramJson from "../fixtures/classDiagram.json";
import multiServiceJson from "../fixtures/multiService.json";
import singleFrontendJson from "../fixtures/singleFrontend.json";
import { VIZ_DOC_FORMAT, type VizDoc } from "../model/types";
import {
  DEFAULT_VIZ_VIEW_STATE,
  type HostToWebview,
  type VizAlignment,
  type VizNote,
  type VizReviewFile,
  type VizReviewState,
  type VizViewState,
  type VizWindowState,
  type WebviewToHost,
} from "../protocol";
import { applyPreviewTheme } from "./previewThemes";

const FIXTURES = {
  classDiagram: classDiagramJson,
  multiService: multiServiceJson,
  singleFrontend: singleFrontendJson,
} as const;

type FixtureName = keyof typeof FIXTURES;

function docOf(name: FixtureName): VizDoc {
  const viz = VizFile.parse(FIXTURES[name]);
  return {
    format: VIZ_DOC_FORMAT,
    meta: {
      name,
      path: `/work/shop/.paireto/viz/${name}.viz.json`,
      repoRoot: "/work/shop",
      repoName: "shop",
      repos: [{ name: "shop", root: "/work/shop" }],
      compareTo: { kind: "ref", ref: "HEAD" },
      compareLabel: "HEAD",
      checkedAt: new Date().toISOString(),
    },
    viz,
  };
}

function reviewFor(viz: VizFile): VizReviewState {
  const byPath = new Map<string, VizReviewFile>();
  for (const node of viz.nodes) {
    const file = node.files?.[0];
    if (node.delta === "unchanged" || !file || byPath.has(file.path)) {
      continue;
    }
    byPath.set(file.path, {
      repo: "shop",
      path: file.path,
      status: node.delta === "added" ? "A" : node.delta === "removed" ? "D" : "M",
      additions: node.counts?.added ?? 3,
      deletions: node.counts?.removed ?? 1,
      seen: byPath.size === 0,
    });
  }
  const files = [...byPath.values()];
  const changed = viz.nodes.filter((node) => node.delta !== "unchanged" && !node.flowOnly);
  const first = changed[0];
  const second = changed[1] ?? changed[0];
  const minute = 60_000;
  const now = Date.now();
  const member = first?.members?.find(
    (candidate) => candidate.delta && candidate.delta !== "unchanged",
  );
  const notes: VizNote[] = [];
  if (first) {
    notes.push({
      id: "note-1",
      kind: "question",
      title: first.label,
      body: `Why does ${first.label} read every file again after a refresh, rather than only the files that changed?`,
      items: [
        {
          id: "note-1",
          who: "you",
          body: `Why does ${first.label} read every file again after a refresh, rather than only the files that changed?`,
          at: new Date(now - 42 * minute).toISOString(),
          sent: true,
        },
        {
          id: "note-1-r1",
          who: "agent",
          body: "The cache key is the file content hash, so a refresh only re-reads files whose content changed. The loop looks like it reads all of them, but the hash check returns early.",
          at: new Date(now - 12 * minute).toISOString(),
          sent: true,
        },
      ],
      sent: true,
      unread: 1,
      waiting: false,
      resolved: false,
      targets: member
        ? [
            {
              kind: "member",
              id: member.id,
              node: first.id,
              label: `${first.label}.${member.short ?? member.label}`,
            },
          ]
        : [{ kind: "node", id: first.id, label: first.label }],
    });
  }
  if (second) {
    notes.push({
      id: "note-2",
      kind: "comment",
      title: second.label,
      body: "These types pass the same delta around. Put the delta lookups in one place so they cannot drift apart.",
      items: [
        {
          id: "note-2",
          who: "you",
          body: "These types pass the same delta around. Put the delta lookups in one place so they cannot drift apart.",
          at: new Date(now - 5 * minute).toISOString(),
          sent: false,
        },
      ],
      sent: false,
      unread: 0,
      waiting: false,
      resolved: false,
      targets: [{ kind: "node", id: second.id, label: second.label }],
    });
  }
  return { files, notes, feedback: { waiting: true, pending: 1 } };
}

const params = new URLSearchParams(location.search);

function isFixture(name: string | null): name is FixtureName {
  return name !== null && name in FIXTURES;
}

const state = {
  name: (isFixture(params.get("viz")) ? params.get("viz") : "classDiagram") as FixtureName,
  review: undefined as VizReviewState | undefined,
  view: DEFAULT_VIZ_VIEW_STATE as VizViewState,
};

function post(message: HostToWebview): void {
  window.postMessage(message, "*");
}

function pushReview(): void {
  if (state.review) {
    post({ type: "review", review: state.review });
  }
}

function handle(message: WebviewToHost): void {
  console.log("[preview] webview -> host", message);
  const review = state.review;
  switch (message.type) {
    case "ready":
      send(state.name, startAlignment);
      postStartState();
      return;
    case "switch":
      send(message.name as FixtureName, startAlignment);
      return;
    case "viewState":
      state.view = message.state;
      return;
  }
  if (!review) {
    return;
  }
  const noteOf = (id: string) => review.notes.find((note) => note.id === id);
  const at = new Date().toISOString();
  switch (message.type) {
    case "seen":
      review.files = review.files.map((file) =>
        file.path === message.path ? { ...file, seen: message.seen } : file,
      );
      break;
    case "resetSeen":
      review.files = review.files.map((file) => ({ ...file, seen: false }));
      break;
    case "note.add": {
      const id = `note-${review.notes.length + 1}`;
      review.notes = [
        ...review.notes,
        {
          id,
          kind: message.kind,
          title: message.title,
          body: message.body,
          items: [{ id, who: "you", body: message.body, at, sent: false }],
          sent: false,
          unread: 0,
          waiting: false,
          resolved: false,
          targets: message.targets,
        },
      ];
      review.feedback = { ...review.feedback, pending: review.feedback.pending + 1 };
      break;
    }
    case "note.reply": {
      const note = noteOf(message.id);
      if (note) {
        note.items = [
          ...note.items,
          {
            id: `${note.id}-r${note.items.length}`,
            who: "you",
            body: message.body,
            at,
            sent: false,
          },
        ];
      }
      break;
    }
    case "note.edit": {
      const note = noteOf(message.id);
      if (note) {
        note.kind = message.kind;
        note.body = message.body;
        note.items = note.items.map((item, i) =>
          i === 0 ? { ...item, body: message.body, sent: false } : item,
        );
      }
      break;
    }
    case "note.editReply":
      for (const note of review.notes) {
        note.items = note.items.map((item) =>
          item.id === message.id ? { ...item, body: message.body, sent: false } : item,
        );
      }
      break;
    case "note.read": {
      const note = noteOf(message.id);
      if (note) {
        note.unread = 0;
      }
      break;
    }
    case "note.resolve": {
      const note = noteOf(message.id);
      if (note) {
        note.resolved = true;
      }
      break;
    }
    case "note.delete":
      review.notes = review.notes.filter((note) => note.id !== message.id);
      for (const note of review.notes) {
        note.items = note.items.filter((item) => item.id !== message.id);
      }
      break;
    case "gate":
      review.feedback = { waiting: message.action === "sendFeedback", pending: 0 };
      review.notes = review.notes.map((note) => ({
        ...note,
        sent: true,
        items: note.items.map((item) => ({ ...item, sent: true })),
      }));
      break;
    default:
      return;
  }
  pushReview();
}

window.acquireVsCodeApi = () => ({
  postMessage: handle,
  setState(value) {
    console.log("[preview] setState", value);
  },
  getState() {
    return undefined;
  },
});

const ALIGNMENTS: VizAlignment[] = [
  { kind: "aligned" },
  { kind: "available" },
  {
    kind: "blocked",
    reason: "This window holds 2 repos, and a ref Compare To would apply to all of them.",
  },
];

function windowState(alignment: VizAlignment): VizWindowState {
  return {
    compareTo: { kind: "ref", ref: "HEAD" },
    compareLabel: alignment.kind === "aligned" ? "HEAD" : "main",
    alignment,
  };
}

function send(name: FixtureName, alignment: VizAlignment): void {
  const doc = docOf(name);
  state.name = name;
  state.review = reviewFor(doc.viz);
  post({
    type: "load",
    doc,
    vizzes: (Object.keys(FIXTURES) as FixtureName[]).map((key) => ({
      name: key,
      title: VizFile.parse(FIXTURES[key]).title,
      repoName: "shop",
      modifiedAt: doc.meta.checkedAt,
    })),
    window: windowState(alignment),
    review: state.review,
    view: state.view,
  });
}

const startAlignment =
  ALIGNMENTS.find((alignment) => alignment.kind === params.get("compare")) ?? ALIGNMENTS[0];

function postStartState(): void {
  switch (params.get("state")) {
    case "invalid":
      post({
        type: "invalid",
        name: state.name,
        issues: [
          {
            severity: "error",
            rule: "ref",
            path: "edges[0].to",
            message: "Unknown node id order-svc",
            suggestion: "orders",
          },
        ],
      });
      return;
    case "empty":
      post({ type: "empty", vizzes: [] });
      return;
  }
}

applyPreviewTheme(params.get("theme") === "light" ? "light" : "dark");

void import("./index");
