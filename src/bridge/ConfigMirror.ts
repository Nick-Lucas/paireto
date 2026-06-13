// Writes $STATE/config.json so the hook scripts (which can't read VS Code settings) learn the
// plan-gate fail-mode policy. Called on activation and whenever the relevant settings change.

import * as fs from "node:fs";

import { configPath, stateDir } from "../protocol/paths.js";
import type { BridgeConfig } from "./types.js";

export const DEFAULT_CONFIG: BridgeConfig = {
  planGate: {
    onUnavailable: "fail-open",
    onTimeout: "fail-visible",
    onMalformed: "fail-visible",
    timeoutSeconds: 345600,
  },
};

export function writeConfigMirror(config: BridgeConfig): void {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
