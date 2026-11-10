import type ElkConstructor from "elkjs/lib/elk.bundled.js";

import type { ElkLike } from "../viz/layout/overview.js";

const ELK = require("elkjs/lib/elk.bundled.js") as typeof ElkConstructor;

export function makeElk(): ElkLike {
  return new ELK() as unknown as ElkLike;
}
