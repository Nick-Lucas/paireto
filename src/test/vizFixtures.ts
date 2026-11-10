import { VizArgs } from "../protocol/viz.js";
import multiServiceJson from "../viz/fixtures/multiService.json";
import singleFrontendJson from "../viz/fixtures/singleFrontend.json";
import { buildVizIndex, type VizIndex } from "../viz/model/index.js";

export const multiService: VizArgs = VizArgs.parse(multiServiceJson);
export const singleFrontend: VizArgs = VizArgs.parse(singleFrontendJson);

export function multiServiceIndex(): VizIndex {
  return buildVizIndex(multiService);
}

export function singleFrontendIndex(): VizIndex {
  return buildVizIndex(singleFrontend);
}
