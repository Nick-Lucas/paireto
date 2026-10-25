import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { mockPath } from "../e2e/sandbox.js";
import type { DemoConfig } from "./config.js";

const COMMIT_DATES = ["2026-09-14T09:12:00Z", "2026-09-16T15:40:00Z"];

export function createProject(repoRoot: string, config: DemoConfig): string {
  const root = mockPath(config.project.name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const template = path.join(repoRoot, "src", "demo", "sandbox");
  const git = (args: string[], date: string): void => {
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
  };
  git(["init", "-q", "-b", "main"], COMMIT_DATES[0]);
  git(["config", "user.name", "Sam Rivera"], COMMIT_DATES[0]);
  git(["config", "user.email", "sam@acme.example"], COMMIT_DATES[0]);
  git(["config", "commit.gpgsign", "false"], COMMIT_DATES[0]);
  git(["config", "core.hooksPath", "/dev/null"], COMMIT_DATES[0]);
  fs.cpSync(path.join(template, "main"), root, { recursive: true });
  git(["add", "-A"], COMMIT_DATES[0]);
  git(["commit", "-q", "-m", config.project.mainCommit], COMMIT_DATES[0]);
  git(["switch", "-q", "-c", config.project.branch], COMMIT_DATES[1]);
  fs.cpSync(path.join(template, "branch"), root, { recursive: true });
  git(["add", "-A"], COMMIT_DATES[1]);
  git(["commit", "-q", "-m", config.project.branchCommit], COMMIT_DATES[1]);
  return root;
}
