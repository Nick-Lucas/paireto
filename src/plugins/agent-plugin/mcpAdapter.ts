import { execFileSync } from "node:child_process";

import type { Harness } from "../../protocol/types.js";
import type { McpHarnessAdapter } from "../core/mcp/runtime.js";
import { createCodexMcpAdapter } from "./com.openai.codex/mcpAdapter.js";
import { createKiroMcpAdapter } from "./dev.kiro/mcpAdapter.js";

export type AgentPluginHarness = Extract<Harness, "codex" | "kiro">;

export interface ParentProcess {
  parentPid: number;
  command: string;
}

export type ReadParentProcess = (pid: number) => ParentProcess | undefined;

function systemParentProcess(pid: number): ParentProcess | undefined {
  try {
    const source = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    const record = /^\s*(\d+)\s+(.*)$/.exec(source);
    return record ? { parentPid: Number(record[1]), command: record[2] } : undefined;
  } catch {
    return undefined;
  }
}

export function detectAgentPluginHarness(
  startPid = process.ppid,
  readParent: ReadParentProcess = systemParentProcess,
): AgentPluginHarness | undefined {
  let pid = startPid;
  for (let index = 0; index < 12 && pid > 1; index += 1) {
    const current = readParent(pid);
    if (!current) {
      return undefined;
    }
    if (/(^|\/)codex$/.test(current.command)) {
      return "codex";
    }
    if (/(^|\/)kiro-cli(?:-chat)?$/.test(current.command)) {
      return "kiro";
    }
    pid = current.parentPid;
  }
  return undefined;
}

export function createAgentPluginMcpAdapter(harness: AgentPluginHarness): McpHarnessAdapter {
  return harness === "codex" ? createCodexMcpAdapter() : createKiroMcpAdapter();
}
