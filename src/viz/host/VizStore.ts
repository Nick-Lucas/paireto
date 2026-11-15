import type * as vscode from "vscode";

import { StateKeys } from "../../config.js";
import { VizFile } from "../../protocol/viz.js";
import { VIZ_DOC_FORMAT, type VizDoc } from "../model/types.js";
import type { VizListEntry } from "../protocol.js";

export const VIZ_STORE_LIMIT = 10;

export class VizStore {
  constructor(private readonly memento: Pick<vscode.Memento, "get" | "update">) {}

  all(): VizDoc[] {
    const stored = this.memento.get<unknown>(StateKeys.vizDocs);
    return Array.isArray(stored) ? stored.filter(isVizDoc) : [];
  }

  get(name: string): VizDoc | undefined {
    return this.all().find((doc) => doc.meta.name === name);
  }

  list(): VizListEntry[] {
    return this.all().map((doc) => ({
      name: doc.meta.name,
      title: doc.viz.title,
      repoName: doc.meta.repoName,
      modifiedAt: doc.meta.checkedAt,
    }));
  }

  async put(doc: VizDoc): Promise<void> {
    const kept = this.all().filter((stored) => stored.meta.name !== doc.meta.name);
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
    typeof doc.meta?.name === "string" &&
    VizFile.safeParse(doc.viz).success
  );
}
