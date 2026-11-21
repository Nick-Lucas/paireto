import type { VizFileRef, VizLineCounts } from "../../protocol/viz";
import { fileRefLabel, fileRefTitle } from "../model/refs";
import { CHIP_WORDS, type Chip } from "../model/visible";
import { useViz } from "./context";

export function ChipMark({ chip, soft = false }: { chip: Chip | undefined; soft?: boolean }) {
  if (!chip) {
    return <span className="viz-chip viz-chip--none" aria-hidden="true" />;
  }
  return (
    <span
      className={`viz-chip viz-chip--${chip} ${soft ? "viz-chip--soft" : ""}`}
      title={CHIP_WORDS[chip]}
    >
      {chip}
    </span>
  );
}

export function Counts({ counts, title }: { counts: VizLineCounts; title?: string }) {
  return (
    <span className="viz-counts" title={title}>
      <span className={`viz-counts__added ${counts.added === 0 ? "viz-counts__zero" : ""}`}>
        +{counts.added}
      </span>
      <span className="viz-counts__sep">/</span>
      <span className={`viz-counts__removed ${counts.removed === 0 ? "viz-counts__zero" : ""}`}>
        −{counts.removed}
      </span>
    </span>
  );
}

export function CountsText({ text }: { text: string }) {
  const [added, removed] = text.split(" / ");
  return (
    <span className="viz-counts">
      <span className={`viz-counts__added ${added === "+0" ? "viz-counts__zero" : ""}`}>
        {added}
      </span>
      <span className="viz-counts__sep">/</span>
      <span className={`viz-counts__removed ${removed === "−0" ? "viz-counts__zero" : ""}`}>
        {removed}
      </span>
    </span>
  );
}

export function FileRefTag({ file, text }: { file: VizFileRef; text?: string }) {
  const viz = useViz();
  return (
    <span
      className="viz-fileref"
      title={`${fileRefTitle(file)} · Double-click to open`}
      onDoubleClick={(event) => {
        event.stopPropagation();
        viz.openFile(file, "file");
      }}
    >
      {text ?? fileRefLabel(file)}
    </span>
  );
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
