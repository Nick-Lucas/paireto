import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import { VizArgs } from "../../protocol/viz";
import multiServiceJson from "../fixtures/multiService.json";
import singleFrontendJson from "../fixtures/singleFrontend.json";
import { VIZ_DOC_FORMAT, type VizDoc } from "../model/types";
import type { HostToWebview, WebviewToHost } from "../protocol";
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
      send("multiService", true);
    }
    if (message.type === "showHistory") {
      send(message.id.replace("preview-", "") as FixtureName, true);
    }
  },
  setState(state) {
    console.log("[preview] setState", state);
  },
  getState() {
    return undefined;
  },
});

function send(name: FixtureName, aligned: boolean): void {
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
    window: {
      compareTo: { kind: "mergeBase" },
      compareLabel: aligned ? "merge base" : "main",
      aligned,
    },
  };
  window.postMessage(message, "*");
}

function PreviewBar() {
  const [theme, setTheme] = useState<PreviewTheme>("dark");
  const [aligned, setAligned] = useState(true);
  useEffect(() => applyPreviewTheme(theme), [theme]);
  return (
    <div className="preview-bar">
      <span className="preview-bar__title">viz preview</span>
      <button type="button" onClick={() => send("multiService", aligned)}>
        multiService
      </button>
      <button type="button" onClick={() => send("singleFrontend", aligned)}>
        singleFrontend
      </button>
      <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        theme: {theme}
      </button>
      <button
        type="button"
        onClick={() => {
          setAligned(!aligned);
          window.postMessage(
            {
              type: "window",
              window: {
                compareTo: { kind: "mergeBase" },
                compareLabel: aligned ? "main" : "merge base",
                aligned: !aligned,
              },
            } satisfies HostToWebview,
            "*",
          );
        }}
      >
        compare: {aligned ? "aligned" : "mismatch"}
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
