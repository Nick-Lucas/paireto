import type { VizDelta, VizNodeKind } from "../../protocol/viz";
import { DELTA_GLYPH } from "../model/delta";

const BASE_PATHS = {
  actor: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 6a5 5 0 0 1 10 0",
  ui: "M2 3.5h12v9H2zM2 6h12M4.5 4.75h.01M6.5 4.75h.01",
  service: "M2.5 3h11v4h-11zM2.5 9h11v4h-11zM5 5h.01M5 11h.01",
  worker:
    "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0-3.5v2m0 8v2m6-6h-2M4 8H2m10.2-4.2-1.4 1.4M5.2 10.8l-1.4 1.4m8.4 0-1.4-1.4M5.2 5.2 3.8 3.8",
  queue: "M2 4.5h12M2 8h12M2 11.5h12M4 2.5v11",
  datastore:
    "M8 2.5c3.3 0 5.5 .9 5.5 2s-2.2 2-5.5 2-5.5-.9-5.5-2 2.2-2 5.5-2Zm-5.5 2v7c0 1.1 2.2 2 5.5 2s5.5-.9 5.5-2v-7M2.5 8c0 1.1 2.2 2 5.5 2s5.5-.9 5.5-2",
  cache: "M9 2 4 9h4l-1 5 5-7H8l1-5Z",
  external:
    "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm-5.5 5.5h11M8 2.5c-2 2-2 9 0 11m0-11c2 2 2 9 0 11",
  module: "M8 2 13.5 5v6L8 14 2.5 11V5L8 2Zm0 6 5.5-3M8 8v6M8 8 2.5 5",
  component: "M5 3h6v2.5a1.5 1.5 0 0 0 0 3V11H8.5a1.5 1.5 0 0 0-3 0H3V8.5a1.5 1.5 0 0 1 0-3V3h2Z",
  hook: "M8 2v6.5a3 3 0 0 0 6 0V7m-6-5a1.5 1.5 0 1 0 0 .01",
  function: "M10.5 2.5c-2 0-2.5 1-2.8 3L6.5 13.5c-.3 1.5-1 1.5-2 1.5M4 7h7",
  class:
    "M5 2.5c-1.5 0-2 .5-2 2v2c0 1-1 1.5-1.5 1.5C2 8 3 8.5 3 9.5v2c0 1.5.5 2 2 2m6-11c1.5 0 2 .5 2 2v2c0 1 1 1.5 1.5 1.5-.5 0-1.5.5-1.5 1.5v2c0 1.5-.5 2-2 2",
  model: "M2.5 2.5h11v11h-11zM2.5 6.5h11M2.5 10h11M6.5 2.5v11",
  route: "M3 13 8 3l5 10M4.5 10h7",
  state: "M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm0 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  config: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11M5.5 3v3M10.5 6.5v3M7 10v3",
  test: "M6 2h4M7 2v4.5L3.5 12a1.5 1.5 0 0 0 1.3 2h6.4a1.5 1.5 0 0 0 1.3-2L9 6.5V2M5 10h6",
  file: "M4 2h5l3 3v9H4zM9 2v3h3",
};

const KIND_PATHS: Record<VizNodeKind, string> = {
  ...BASE_PATHS,
  interface: BASE_PATHS.class,
  enum: BASE_PATHS.config,
  struct: BASE_PATHS.model,
  package: BASE_PATHS.module,
  system: BASE_PATHS.service,
  topic: BASE_PATHS.queue,
  endpoint: BASE_PATHS.route,
};

export function KindIcon({ kind, size = 14 }: { kind: VizNodeKind; size?: number }) {
  return (
    <svg
      className="viz-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={KIND_PATHS[kind]} />
    </svg>
  );
}

export const DELTA_LABEL: Record<VizDelta, string> = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
  unchanged: "Unchanged",
};

export function DeltaBadge({ delta, compact = false }: { delta: VizDelta; compact?: boolean }) {
  return (
    <span className={`viz-delta viz-delta--${delta}`} title={DELTA_LABEL[delta]}>
      <span className="viz-delta__glyph">{DELTA_GLYPH[delta]}</span>
      {!compact && <span className="viz-delta__text">{DELTA_LABEL[delta]}</span>}
    </span>
  );
}

const UI_PATHS = {
  play: "M4 2.5v11l9-5.5-9-5.5Z",
  pause: "M4 2.5h3v11H4zM9 2.5h3v11H9z",
  prev: "M10 2.5 4.5 8 10 13.5",
  next: "M6 2.5 11.5 8 6 13.5",
  close: "M3.5 3.5l9 9m0-9-9 9",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm3.2 7.7L13.5 13.5",
  help: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm-1.8 4a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.6-.8 1.2M8 11h.01",
  copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
  walk: "M2.5 8h11m-4-4 4 4-4 4",
  map: "M2.5 4 6 2.5l4 1.5 3.5-1.5v9L10 13.5 6 12l-3.5 1.5zM6 2.5V12m4-8v9.5",
  diff: "M3 3.5h4v9H3zM9 3.5h4v9H9zM4 6h2M4 8.5h2M10 6h2",
  file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  warn: "M8 2.5 14 13H2L8 2.5Zm0 4v3.5M8 11.5h.01",
  chevron: "M4 6l4 4 4-4",
  down: "M4.5 6.5 8 10l3.5-3.5",
  eye: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  filter: "M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5Z",
  group: "M2 2.5h4.5v3.5H2ZM9.5 10h4.5v3.5H9.5ZM4.25 6v5.75h5.25",
  folder: "M1.75 3.75h4.5l1.5 1.5h6.5v7H1.75Z",
  comment: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z",
  check: "M3 8.5 6.5 12 13 4.5",
  link: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8",
  send: "M8 13V3M4 7l4-4 4 4",
  sparkle: "M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4Z",
  edit: "M10.5 2.5l3 3L6 13H3v-3Z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  reset: "M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3",
  arrow: "M3 8h9M8.5 4.5 12 8l-3.5 3.5",
  compare:
    "M4.5 2.5v7M4.5 9.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5ZM11.5 13.5v-7M11.5 6.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM6.5 4.5h3M8.5 3.5l1 1-1 1",
  symbolClass: "M2 6h4v4H2ZM10 2.5h4v3.5h-4ZM10 10h4v3.5h-4ZM6 8h2M8 4.25v7.5M8 4.25h2M8 11.75h2",
  symbolMethod: "M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5ZM2.5 4.75 8 7.75l5.5-3M8 7.75v6.5",
  sidebar: "M2.5 3h11v10h-11zM10 3v10",
} as const;

export type UiIconName = keyof typeof UI_PATHS;

export function UiIcon({ name, size = 14 }: { name: UiIconName; size?: number }) {
  return (
    <svg
      className="viz-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={name === "play" || name === "pause" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={UI_PATHS[name]} />
    </svg>
  );
}
