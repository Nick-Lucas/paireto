import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { AnySchemaObject } from "ajv";

import { PLUGIN_VERSION } from "../protocol/types.js";

const bundle = path.resolve(__dirname, "../../dist/plugins/agent-plugin");
const source = path.resolve(__dirname, "../../src/plugins/agent-plugin");

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function assertReferencedSchemaValid(documentFile: string): Promise<void> {
  const document = readJson(documentFile) as { $schema?: unknown };
  if (typeof document.$schema !== "string" || !URL.canParse(document.$schema)) {
    return;
  }
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    loadSchema: async (uri) => {
      const response = await fetch(uri);
      if (!response.ok) {
        throw new Error(`could not load schema ${uri}: HTTP ${response.status}`);
      }
      return (await response.json()) as AnySchemaObject;
    },
  });
  const validate = await ajv.compileAsync({ $ref: document.$schema });
  const valid = validate(document);
  assert.ok(valid, JSON.stringify(validate.errors, null, 2));
}

suite("common Agent Plugin bundle", () => {
  test("validates source and built documents against their referenced schemas", async () => {
    for (const root of [source, bundle]) {
      await assertReferencedSchemaValid(path.join(root, "plugin.json"));
      await assertReferencedSchemaValid(path.join(root, "mcp.json"));
    }
  });
});
