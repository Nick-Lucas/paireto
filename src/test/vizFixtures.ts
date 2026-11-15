import { VizFile, type VizFileRef } from "../protocol/viz.js";
import classDiagramJson from "../viz/fixtures/classDiagram.json";
import multiServiceJson from "../viz/fixtures/multiService.json";
import singleFrontendJson from "../viz/fixtures/singleFrontend.json";
import type { VizChangedFile, VizEnv } from "../viz/model/compile.js";
import { buildVizIndex, type VizIndex } from "../viz/model/index.js";
import type { VizFileStatus } from "../viz/protocol.js";

export const FIXTURE_REPO = "shop";

export const multiService: VizFile = VizFile.parse(multiServiceJson);
export const singleFrontend: VizFile = VizFile.parse(singleFrontendJson);
export const classDiagram: VizFile = VizFile.parse(classDiagramJson);

const FIXTURES = { multiService, singleFrontend, classDiagram };

export type VizFixtureName = keyof typeof FIXTURES;

export function multiServiceIndex(): VizIndex {
  return buildVizIndex(multiService);
}

export function singleFrontendIndex(): VizIndex {
  return buildVizIndex(singleFrontend);
}

export function classDiagramIndex(): VizIndex {
  return buildVizIndex(classDiagram);
}

export function loadVizFixture(name: VizFixtureName): VizFile {
  return structuredClone(FIXTURES[name]);
}

export function changedFilesFor(viz: VizFile): VizChangedFile[] {
  const byPath = new Map<string, VizFileStatus>();
  const add = (refs: VizFileRef[] | undefined, status: VizFileStatus) => {
    for (const ref of refs ?? []) {
      if (!byPath.has(ref.path)) {
        byPath.set(ref.path, status);
      }
    }
  };
  for (const node of viz.nodes) {
    if (node.delta !== "unchanged") {
      add(node.files, node.delta === "added" ? "A" : node.delta === "removed" ? "D" : "M");
    }
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

export function envFor(viz: VizFile): VizEnv {
  const changed = changedFilesFor(viz);
  const unchanged = new Set(
    viz.nodes.flatMap((node) => (node.files ?? []).map((file) => file.path)),
  );
  return {
    repoName: FIXTURE_REPO,
    repos: [{ name: FIXTURE_REPO, root: "/work/shop" }],
    changed,
    fileExists: (_repo, path) => unchanged.has(path),
  };
}
