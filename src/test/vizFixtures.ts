import { VizArgs, type VizFileRef } from "../protocol/viz.js";
import multiServiceJson from "../viz/fixtures/multiService.json";
import singleFrontendJson from "../viz/fixtures/singleFrontend.json";
import type { VizEnv } from "../viz/model/compile.js";
import { buildVizIndex, type VizIndex } from "../viz/model/index.js";
import type { ChangedFileStatus, VizChangedFile } from "../viz/model/types.js";

export const FIXTURE_REPO = "shop";

export const multiService: VizArgs = VizArgs.parse(multiServiceJson);
export const singleFrontend: VizArgs = VizArgs.parse(singleFrontendJson);

export function multiServiceIndex(): VizIndex {
  return buildVizIndex(multiService);
}

export function singleFrontendIndex(): VizIndex {
  return buildVizIndex(singleFrontend);
}

export function loadVizFixture(name: "multiService" | "singleFrontend"): VizArgs {
  return structuredClone(name === "multiService" ? multiService : singleFrontend);
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
