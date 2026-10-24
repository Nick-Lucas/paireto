import * as vscode from "vscode";

import { StateKeys } from "../config.js";
import type { DeltaFile } from "./delta.js";

type SeenEntries = Record<string, string>;

function seenKey(file: DeltaFile): string {
  return `${file.repoRoot}\0${file.path}`;
}

export class SeenFiles implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  isSeen(file: DeltaFile): boolean {
    return this.entries()[seenKey(file)] === file.contentId;
  }

  async setSeen(files: DeltaFile[], seen: boolean): Promise<void> {
    const next = { ...this.entries() };
    for (const file of files) {
      if (seen) {
        next[seenKey(file)] = file.contentId;
      } else {
        delete next[seenKey(file)];
      }
    }
    await this.memento.update(StateKeys.seenFiles, next);
    this.emitter.fire();
  }

  private entries(): SeenEntries {
    return this.memento.get<SeenEntries>(StateKeys.seenFiles, {});
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
