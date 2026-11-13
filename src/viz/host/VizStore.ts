import type * as vscode from "vscode";

import { StateKeys } from "../../config.js";
import { VizArgs } from "../../protocol/viz.js";
import { VIZ_DOC_FORMAT, type VizDoc } from "../model/types.js";
import type { VizHistoryEntry } from "../protocol.js";

export const VIZ_STORE_LIMIT = 10;

export class VizStore {
  constructor(private readonly memento: Pick<vscode.Memento, "get" | "update">) {}

  all(): VizDoc[] {
    const stored = this.memento.get<unknown>(StateKeys.vizDocs);
    return Array.isArray(stored) ? stored.filter(isVizDoc) : [];
  }

  get(id: string): VizDoc | undefined {
    return this.all().find((doc) => doc.meta.id === id);
  }

  history(): VizHistoryEntry[] {
    return this.all().map((doc) => ({
      id: doc.meta.id,
      title: doc.viz.title,
      createdAt: doc.meta.createdAt,
      repoName: doc.meta.repoName,
    }));
  }

  async put(doc: VizDoc): Promise<void> {
    const kept = this.all().filter((stored) => stored.meta.id !== doc.meta.id);
    await this.memento.update(StateKeys.vizDocs, [doc, ...kept].slice(0, VIZ_STORE_LIMIT));
  }
}

function isVizDoc(value: unknown): value is VizDoc {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const doc = value as Partial<VizDoc>;
  return (
    doc.format === VIZ_DOC_FORMAT &&
    typeof doc.meta?.id === "string" &&
    VizArgs.safeParse(doc.viz).success
  );
}
