const PATHS = {
  zoomIn: "M7 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10 10l3.5 3.5M7 5v4M5 7h4",
  zoomOut: "M7 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10 10l3.5 3.5M5 7h4",
  fit: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  target: "M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  up: "M4.5 9.5 8 6l3.5 3.5",
  down: "M4.5 6.5 8 10l3.5-3.5",
  left: "M9.5 4.5 6 8l3.5 3.5",
  right: "M6.5 4.5 10 8l-3.5 3.5",
  refresh: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3",
  compare:
    "M4.5 2.5v7M4.5 9.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5ZM11.5 13.5v-7M11.5 6.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM6.5 4.5h3M8.5 3.5l1 1-1 1",
  help: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15v.5M8 11.25v.25",
  comment: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z",
  check: "M3 8.5 6.5 12 13 4.5",
  file: "M4 1.75h5l3 3v9.5H4ZM9 1.75v3h3",
  folder: "M1.75 3.75h4.5l1.5 1.5h6.5v7H1.75Z",
  group: "M2 2.5h4.5v3.5H2ZM9.5 10h4.5v3.5H9.5ZM4.25 6v5.75h5.25",
  open: "M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4",
  legend: "M3 4h10M3 8h10M3 12h6",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM10.25 10.25 13.5 13.5",
  reset: "M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3",
  next: "M3 8h9M8.5 4.5 12 8l-3.5 3.5",
  filter: "M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5Z",
  eye: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  close: "M4 4l8 8M12 4l-8 8",
  edit: "M10.5 2.5l3 3L6 13H3v-3Z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  link: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8",
  send: "M8 13V3M4 7l4-4 4 4",
  sparkle: "M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4Z",
  symbolClass: "M2 6h4v4H2ZM10 2.5h4v3.5h-4ZM10 10h4v3.5h-4ZM6 8h2M8 4.25v7.5M8 4.25h2M8 11.75h2",
  symbolMethod: "M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5ZM2.5 4.75 8 7.75l5.5-3M8 7.75v6.5",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function iconPath(name: IconName): string {
  return PATHS[name];
}
