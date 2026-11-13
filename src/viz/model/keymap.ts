import type { UiAction } from "./ui.js";

export type KeyEffect = "search" | "export";

export type KeyCommand =
  | { readonly kind: "ui"; readonly action: UiAction }
  | { readonly kind: "effect"; readonly effect: KeyEffect };

export interface KeyBinding {
  readonly keys: readonly string[];
  readonly display: string;
  readonly label: string;
  readonly command: KeyCommand | ((key: string) => KeyCommand);
}

const ui = (action: UiAction): KeyCommand => ({ kind: "ui", action });

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { keys: ["0"], display: "0", label: "Overview", command: ui({ type: "stageAt", n: 0 }) },
  {
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    display: "1-9",
    label: "Flow 1 to 9",
    command: (key) => ui({ type: "stageAt", n: Number(key) }),
  },
  { keys: ["w"], display: "w", label: "Start the walkthrough", command: ui({ type: "walk" }) },
  { keys: ["ArrowLeft"], display: "←", label: "Previous step", command: ui({ type: "prev" }) },
  { keys: ["ArrowRight"], display: "→", label: "Next step", command: ui({ type: "next" }) },
  {
    keys: [" "],
    display: "space",
    label: "Play or pause the flow",
    command: ui({ type: "playToggle" }),
  },
  { keys: ["f"], display: "f", label: "Focus the selected node", command: ui({ type: "focus" }) },
  { keys: ["/"], display: "/", label: "Search", command: { kind: "effect", effect: "search" } },
  {
    keys: ["Escape"],
    display: "esc",
    label: "Back out one level",
    command: ui({ type: "escape" }),
  },
  { keys: ["?"], display: "?", label: "Keyboard help", command: ui({ type: "toggleHelp" }) },
  {
    keys: ["m"],
    display: "m",
    label: "Toggle the minimap",
    command: ui({ type: "toggleMinimap" }),
  },
  {
    keys: ["e"],
    display: "e",
    label: "Export as Mermaid",
    command: { kind: "effect", effect: "export" },
  },
];

export interface KeyInput {
  readonly key: string;
  readonly modifier: boolean;
  readonly inTextField: boolean;
}

export function resolveKey(input: KeyInput): KeyCommand | undefined {
  if (input.modifier || (input.inTextField && input.key !== "Escape")) {
    return undefined;
  }
  const binding = KEY_BINDINGS.find((candidate) => candidate.keys.includes(input.key));
  if (!binding) {
    return undefined;
  }
  return typeof binding.command === "function" ? binding.command(input.key) : binding.command;
}
