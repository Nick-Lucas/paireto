import * as vscode from "vscode";

import { log } from "../log.js";
import { nestSymbols, type OutlineSymbol, type TextRange } from "./core/outline.js";

const SYMBOL_TIMEOUT_MS = 15000;
const SYMBOL_ATTEMPTS = 4;
const SYMBOL_RETRY_MS = 200;

function rangeOf(range: vscode.Range): TextRange {
  return {
    startLine: range.start.line,
    startChar: range.start.character,
    endLine: range.end.line,
    endChar: range.end.character,
  };
}

function fromDocumentSymbol(symbol: vscode.DocumentSymbol): OutlineSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: symbol.kind,
    range: rangeOf(symbol.range),
    selection: rangeOf(symbol.selectionRange),
    children: (symbol.children ?? []).map(fromDocumentSymbol),
  };
}

function fromSymbolInformation(symbol: vscode.SymbolInformation): OutlineSymbol {
  const range = rangeOf(symbol.location.range);
  return {
    name: symbol.name,
    detail: "",
    kind: symbol.kind,
    range,
    selection: range,
    children: [],
  };
}

function withTimeout<T>(work: Thenable<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        log.debug(
          `[uml] symbol request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        resolve(undefined);
      },
    );
  });
}

type SymbolAnswer = (vscode.DocumentSymbol | vscode.SymbolInformation)[];

function askForSymbols(uri: vscode.Uri): Promise<SymbolAnswer | "failed" | undefined> {
  return withTimeout(
    Promise.resolve(
      vscode.commands.executeCommand<SymbolAnswer | undefined>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      ),
    ).catch((err: unknown) => {
      log.debug(`[uml] symbol request failed: ${err instanceof Error ? err.message : String(err)}`);
      return "failed" as const;
    }),
    SYMBOL_TIMEOUT_MS,
  );
}

const startedLanguages = new Map<string, Promise<void>>();

function startLanguage(languageId: string): Promise<void> {
  const known = startedLanguages.get(languageId);
  if (known) {
    return known;
  }
  const event = `onLanguage:${languageId}`;
  const started = Promise.all(
    vscode.extensions.all
      .filter(
        (extension) =>
          !extension.isActive &&
          (
            (extension.packageJSON as { activationEvents?: string[] }).activationEvents ?? []
          ).includes(event),
      )
      .map((extension) =>
        Promise.resolve(extension.activate()).then(
          () => undefined,
          (err: unknown) =>
            log.debug(
              `[uml] ${extension.id} did not start: ${err instanceof Error ? err.message : String(err)}`,
            ),
        ),
      ),
  ).then(() => undefined);
  startedLanguages.set(languageId, started);
  return started;
}

export async function documentSymbols(
  uri: vscode.Uri,
  languageId?: string,
): Promise<OutlineSymbol[] | undefined> {
  if (languageId) {
    await startLanguage(languageId);
  }
  let result = await askForSymbols(uri);
  for (
    let attempt = 1;
    attempt < SYMBOL_ATTEMPTS && (result === "failed" || result?.length === 0);
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, SYMBOL_RETRY_MS * attempt));
    result = await askForSymbols(uri);
  }
  if (!result || result === "failed") {
    return undefined;
  }
  if (result.length > 0 && !("children" in result[0])) {
    return nestSymbols((result as vscode.SymbolInformation[]).map(fromSymbolInformation));
  }
  return (result as vscode.DocumentSymbol[]).map(fromDocumentSymbol);
}

const TYPE_SYMBOL_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
]);

export async function findTypeDefinition(
  name: string,
): Promise<vscode.SymbolInformation | undefined> {
  const result = await withTimeout(
    vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
      "vscode.executeWorkspaceSymbolProvider",
      name,
    ),
    SYMBOL_TIMEOUT_MS,
  );
  return (result ?? [])
    .filter((symbol) => symbol.name === name && TYPE_SYMBOL_KINDS.has(symbol.kind))
    .filter((symbol) => !/[\\/]node_modules[\\/]/.test(symbol.location.uri.fsPath))
    .sort((a, b) => a.location.uri.fsPath.localeCompare(b.location.uri.fsPath))[0];
}
