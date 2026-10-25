import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

export interface WorkbenchOptions {
  readonly vscodeVersion: string;
  readonly vsix: string;
  readonly workspace: string;
  readonly profileDir: string;
  readonly display: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly settings: Record<string, unknown>;
  readonly env: NodeJS.ProcessEnv;
}

export interface Workbench {
  readonly app: ElectronApplication;
  readonly page: Page;
  close(): Promise<void>;
}

export async function launchWorkbench(options: WorkbenchOptions): Promise<Workbench> {
  const executablePath = await downloadAndUnzipVSCode(options.vscodeVersion);
  const userDataDir = path.join(options.profileDir, "user-data");
  const extensionsDir = path.join(options.profileDir, "extensions");
  fs.rmSync(options.profileDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(userDataDir, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "User", "settings.json"),
    JSON.stringify(options.settings, null, 2),
  );
  installExtension(executablePath, options.vsix, userDataDir, extensionsDir);

  const app = await _electron.launch({
    executablePath,
    args: [
      options.workspace,
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir,
      "--no-sandbox",
      "--disable-gpu",
      `--force-device-scale-factor=${options.scale}`,
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      "--disable-telemetry",
      "--disable-updates",
      "--password-store=basic",
    ],
    env: { ...options.env, DISPLAY: options.display } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
    },
    { width: options.width, height: options.height },
  );
  await page.waitForSelector(".monaco-workbench", { timeout: 120_000 });
  return {
    app,
    page,
    close: async () => {
      await app.close().catch(() => undefined);
    },
  };
}

function installExtension(
  executablePath: string,
  vsix: string,
  userDataDir: string,
  extensionsDir: string,
): void {
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(executablePath, {
    reuseMachineInstall: true,
  });
  execFileSync(
    cli,
    [
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir,
      "--install-extension",
      vsix,
      "--force",
    ],
    { stdio: "inherit", env: { ...process.env, DONT_PROMPT_WSL_INSTALL: "1" } },
  );
}
