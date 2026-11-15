import * as assert from "node:assert";
import { mock } from "node:test";

import * as vscode from "vscode";

import { definitionAt, documentSymbols } from "../viz/generate/symbols.js";

const URI = vscode.Uri.file("/repo/shapes.ts");

function circle(): vscode.DocumentSymbol {
  const range = new vscode.Range(0, 0, 2, 1);
  return new vscode.DocumentSymbol("Circle", "", vscode.SymbolKind.Class, range, range);
}

function answer(...answers: unknown[][]): { calls: () => number } {
  const real = vscode.commands.executeCommand;
  let calls = 0;
  mock.method(vscode.commands, "executeCommand", (command: string, ...rest: unknown[]) => {
    if (command !== "vscode.executeDocumentSymbolProvider") {
      return (real as (c: string, ...r: unknown[]) => Thenable<unknown>).call(
        vscode.commands,
        command,
        ...rest,
      );
    }
    const next = answers[Math.min(calls, answers.length - 1)];
    calls++;
    return Promise.resolve(next);
  });
  return { calls: () => calls };
}

suite("Viz generate — document symbols", () => {
  teardown(() => {
    mock.restoreAll();
  });

  test("asks again when the provider first gives an empty answer", async () => {
    const provider = answer([], [circle()]);

    const symbols = await documentSymbols(URI);

    assert.deepStrictEqual(
      symbols?.map((s) => s.name),
      ["Circle"],
    );
    assert.strictEqual(provider.calls(), 2);
  });

  test("asks again when the provider request fails while it starts", async () => {
    let calls = 0;
    const real = vscode.commands.executeCommand;
    mock.method(vscode.commands, "executeCommand", (command: string, ...rest: unknown[]) => {
      if (command !== "vscode.executeDocumentSymbolProvider") {
        return (real as (c: string, ...r: unknown[]) => Thenable<unknown>).call(
          vscode.commands,
          command,
          ...rest,
        );
      }
      calls++;
      return calls === 1 ? Promise.reject(new Error("Canceled")) : Promise.resolve([circle()]);
    });

    const symbols = await documentSymbols(URI);

    assert.deepStrictEqual(
      symbols?.map((s) => s.name),
      ["Circle"],
    );
    assert.strictEqual(calls, 2);
  });

  test("stops asking after a small number of empty answers", async () => {
    const provider = answer([]);

    const symbols = await documentSymbols(URI);

    assert.deepStrictEqual(symbols, []);
    assert.ok(provider.calls() > 1 && provider.calls() <= 5, `${provider.calls()} calls`);
  });

  test("starts the extensions that serve the language before the first request", async () => {
    const order: string[] = [];
    const extension = (id: string, events: string[]) => ({
      id,
      isActive: false,
      packageJSON: { activationEvents: events },
      activate: async () => {
        order.push(`activate ${id}`);
      },
    });
    mock.getter(vscode.extensions, "all", () => [
      extension("test.fakelang", ["onLanguage:fakelang"]),
      extension("test.other", ["onLanguage:otherlang"]),
    ]);
    const real = vscode.commands.executeCommand;
    mock.method(vscode.commands, "executeCommand", (command: string, ...rest: unknown[]) => {
      if (command !== "vscode.executeDocumentSymbolProvider") {
        return (real as (c: string, ...r: unknown[]) => Thenable<unknown>).call(
          vscode.commands,
          command,
          ...rest,
        );
      }
      order.push("symbols");
      return Promise.resolve([circle()]);
    });

    await documentSymbols(URI, "fakelang");

    assert.deepStrictEqual(order, ["activate test.fakelang", "symbols"]);
  });

  test("asks once when the first answer has symbols", async () => {
    const provider = answer([circle()]);

    await documentSymbols(URI);

    assert.strictEqual(provider.calls(), 1);
  });
});

suite("Viz generate — definition lookup", () => {
  teardown(() => {
    mock.restoreAll();
  });

  test("reads the target of a location link at the type name", async () => {
    const target = vscode.Uri.file("/repo/b/store.ts");
    mock.method(vscode.commands, "executeCommand", (command: string) =>
      Promise.resolve(
        command === "vscode.executeDefinitionProvider"
          ? [
              {
                originSelectionRange: new vscode.Range(1, 9, 1, 14),
                targetUri: target,
                targetRange: new vscode.Range(0, 0, 3, 1),
                targetSelectionRange: new vscode.Range(2, 13, 2, 18),
              },
            ]
          : undefined,
      ),
    );

    const found = await definitionAt(URI, new vscode.Position(1, 9));

    assert.deepStrictEqual(found && { path: found.uri.fsPath, line: found.line }, {
      path: target.fsPath,
      line: 2,
    });
  });

  test("gives nothing when no provider knows the name", async () => {
    mock.method(vscode.commands, "executeCommand", () => Promise.resolve([]));

    assert.strictEqual(await definitionAt(URI, new vscode.Position(0, 0)), undefined);
  });
});
