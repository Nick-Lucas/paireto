import * as fs from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

import * as vscode from "vscode";

import type { FolderArg, PathArg } from "./commandArgs.js";

type DiskPath = { repoRoot: string; path: string };

function diskUri(target: DiskPath): vscode.Uri {
  return vscode.Uri.file(join(target.repoRoot, target.path));
}

async function identity(fsPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(fsPath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

async function nameProblem(
  parent: string,
  value: string,
  current?: string,
): Promise<string | undefined> {
  const name = value.trim();
  if (!name) {
    return "A file or folder name must be provided.";
  }
  if (isAbsolute(name)) {
    return "The name must be relative to the folder.";
  }
  const existing = await identity(join(parent, name));
  if (existing && (!current || existing !== (await identity(join(parent, current))))) {
    return `A file or folder ${name} already exists at this location.`;
  }
  return undefined;
}

async function apply(edit: vscode.WorkspaceEdit, failure: string): Promise<boolean> {
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage(failure);
  }
  return applied;
}

export async function newFile(folder: FolderArg): Promise<void> {
  const parent = diskUri(folder).fsPath;
  const value = await vscode.window.showInputBox({
    title: `New File in ${folder.path}`,
    prompt: "Enter the file name",
    validateInput: (input) => nameProblem(parent, input),
  });
  if (!value?.trim()) {
    return;
  }
  const uri = vscode.Uri.file(join(parent, value.trim()));
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(uri, { overwrite: false });
  if (await apply(edit, `Could not create ${value.trim()}.`)) {
    await vscode.window.showTextDocument(uri);
  }
}

export async function rename(target: PathArg): Promise<void> {
  const from = diskUri(target);
  const parent = dirname(from.fsPath);
  const name = basename(target.path);
  const stem =
    target.type === "file" && extname(name) ? name.length - extname(name).length : name.length;
  const value = await vscode.window.showInputBox({
    title: `Rename ${name}`,
    prompt: `Enter the new ${target.type} name`,
    value: name,
    valueSelection: [0, stem],
    validateInput: (input) => nameProblem(parent, input, name),
  });
  if (!value?.trim() || value.trim() === name) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(from, vscode.Uri.file(join(parent, value.trim())), { overwrite: false });
  await apply(edit, `Could not rename ${name} to ${value.trim()}.`);
}

export async function deleteFiles(files: DiskPath[]): Promise<void> {
  const targets = [...new Map(files.map((file) => [diskUri(file).fsPath, file])).values()];
  if (targets.length === 0) {
    return;
  }
  const message =
    targets.length === 1
      ? `Are you sure you want to delete '${basename(targets[0].path)}'?`
      : `Are you sure you want to delete the following ${targets.length} files?`;
  const choice = await vscode.window.showWarningMessage(
    message,
    {
      modal: true,
      detail: targets.length === 1 ? undefined : targets.map((file) => file.path).join("\n"),
    },
    "Delete",
  );
  if (choice !== "Delete") {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const target of targets) {
    edit.deleteFile(diskUri(target), { ignoreIfNotExists: true });
  }
  await apply(edit, `Could not delete ${targets.map((file) => file.path).join(", ")}.`);
}
