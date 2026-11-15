import { z } from "zod";

import { VizFile } from "./viz.js";

export const VIZ_SCHEMA_FILE = "viz.schema.json";

export function vizJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(VizFile, { io: "input" });
}
