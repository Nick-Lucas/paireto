import type { WebviewToHost } from "../protocol";

export interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  setState(state: unknown): void;
  getState(): unknown;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

export const vscode: VsCodeApi = acquireVsCodeApi();

export const reducedMotion: boolean =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
