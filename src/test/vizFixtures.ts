import * as fs from "node:fs";
import * as path from "node:path";

import type { VizArgs, VizFileRef } from "../protocol/viz.js";
import type { VizEnv } from "../viz/model/compile.js";
import type { ChangedFileStatus, VizChangedFile } from "../viz/model/types.js";

export const FIXTURE_REPO = "shop";

const fixturesDir = path.resolve(__dirname, "../../src/viz/fixtures");

export function loadVizFixture(name: "multiService" | "singleFrontend"): VizArgs {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), "utf8")) as VizArgs;
}

export function changedFilesFor(viz: VizArgs): VizChangedFile[] {
  const byPath = new Map<string, ChangedFileStatus>();
  const add = (refs: VizFileRef[] | undefined, status: ChangedFileStatus) => {
    for (const ref of refs ?? []) {
      if (!byPath.has(ref.path)) {
        byPath.set(ref.path, status);
      }
    }
  };
  for (const node of viz.nodes) {
    add(node.files, node.delta === "added" ? "A" : node.delta === "deleted" ? "D" : "M");
  }
  for (const edge of viz.edges ?? []) {
    add(edge.files, "M");
  }
  for (const flow of viz.flows ?? []) {
    for (const step of flow.steps) {
      add(step.files, "M");
    }
  }
  return [...byPath].map(([filePath, status]) => ({
    repo: FIXTURE_REPO,
    path: filePath,
    status,
    additions: 1,
    deletions: status === "A" ? 0 : 1,
  }));
}

export function envFor(viz: VizArgs): VizEnv {
  return {
    repoName: FIXTURE_REPO,
    repos: [{ name: FIXTURE_REPO, root: "/work/shop" }],
    changed: changedFilesFor(viz),
    fileExists: () => false,
  };
}
