import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import { VizArgs } from "../../protocol/viz";
import multiServiceJson from "../fixtures/multiService.json";
import singleFrontendJson from "../fixtures/singleFrontend.json";
import { VIZ_DOC_FORMAT, type VizDoc } from "../model/types";
import type { HostToWebview, VizAlignment, VizWindowState, WebviewToHost } from "../protocol";
import { applyPreviewTheme, type PreviewTheme } from "./previewThemes";

const FIXTURES = {
  multiService: multiServiceJson,
  singleFrontend: singleFrontendJson,
} as const;

type FixtureName = keyof typeof FIXTURES;

function docOf(name: FixtureName): VizDoc {
  const viz = VizArgs.parse(FIXTURES[name]);
  return {
    format: VIZ_DOC_FORMAT,
    meta: {
      id: `preview-${name}`,
      repoRoot: "/work/shop",
      repoName: "shop",
      repos: [{ name: "shop", root: "/work/shop" }],
      harness: "claudecode",
      compareTo: { kind: "mergeBase" },
      compareLabel: "merge base",
      createdAt: new Date().toISOString(),
      changed: [],
    },
    viz,
  };
}

const outbox: WebviewToHost[] = [];

window.acquireVsCodeApi = () => ({
  postMessage(message) {
    outbox.push(message);
    console.log("[preview] webview -> host", message);
    if (message.type === "ready") {
      send("multiService", ALIGNMENTS[0]);
    }
    if (message.type === "showHistory") {
      send(message.id.replace("preview-", "") as FixtureName, ALIGNMENTS[0]);
    }
  },
  setState(state) {
    console.log("[preview] setState", state);
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
    compareTo: { kind: "mergeBase" },
    compareLabel: alignment.kind === "aligned" ? "merge base" : "main",
    alignment,
  };
}

function send(name: FixtureName, alignment: VizAlignment): void {
  const doc = docOf(name);
  const message: HostToWebview = {
    type: "load",
    doc,
    history: (Object.keys(FIXTURES) as FixtureName[]).map((key) => ({
      id: `preview-${key}`,
      title: VizArgs.parse(FIXTURES[key]).title,
      createdAt: doc.meta.createdAt,
      repoName: "shop",
    })),
    window: windowState(alignment),
  };
  window.postMessage(message, "*");
}

function PreviewBar() {
  const [theme, setTheme] = useState<PreviewTheme>("dark");
  const [alignAt, setAlignAt] = useState(0);
  const alignment = ALIGNMENTS[alignAt];
  useEffect(() => applyPreviewTheme(theme), [theme]);
  return (
    <div className="preview-bar">
      <span className="preview-bar__title">viz preview</span>
      <button type="button" onClick={() => send("multiService", alignment)}>
        multiService
      </button>
      <button type="button" onClick={() => send("singleFrontend", alignment)}>
        singleFrontend
      </button>
      <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        theme: {theme}
      </button>
      <button
        type="button"
        onClick={() => {
          const next = (alignAt + 1) % ALIGNMENTS.length;
          setAlignAt(next);
          window.postMessage(
            { type: "window", window: windowState(ALIGNMENTS[next]) } satisfies HostToWebview,
            "*",
          );
        }}
      >
        compare: {alignment.kind}
      </button>
    </div>
  );
}

const style = document.createElement("style");
style.textContent = `
  #preview-root { position: fixed; bottom: 10px; left: 64px; z-index: 1000; }
  .preview-bar { display: flex; gap: 4px; align-items: center; padding: 4px 6px; border-radius: 8px; background: #000c; color: #eee; font: 11px system-ui; }
  .preview-bar__title { opacity: .6; margin-right: 4px; }
  .preview-bar button { font: inherit; color: inherit; background: #ffffff22; border: 0; border-radius: 4px; padding: 3px 7px; cursor: pointer; }
  .preview-bar button:hover { background: #ffffff44; }
`;
document.head.appendChild(style);

const bar = document.createElement("div");
bar.id = "preview-root";
document.body.appendChild(bar);
createRoot(bar).render(<PreviewBar />);
applyPreviewTheme("dark");

void import("./index");
