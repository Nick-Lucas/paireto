import * as fs from "node:fs";
import * as path from "node:path";

import { MockServerController } from "../e2e/mockserver/MockServerController.js";
import { mockProxyEnv } from "../e2e/mockserver/proxyEnv.js";
import { ensureTestCertificates } from "../e2e/proxy/testCertificates.js";
import { readReplayMiss } from "../e2e/replayMiss.js";
import { prepareAgentShell, type AgentShell } from "./agent.js";
import { startScreen, type Screen } from "./capture.js";
import type { DemoConfig } from "./config.js";
import { createProject } from "./project.js";
import { launchWorkbench, type Workbench } from "./workbench.js";

export type DemoMode = "record" | "replay";

export const CASSETTE_CASE = "demo";
const DRIVER = "claudecode";

export interface Environment {
  readonly mode: DemoMode;
  readonly projectRoot: string;
  readonly outDir: string;
  readonly screen: Screen;
  readonly workbench: Workbench;
  replayMiss(): string | undefined;
  finish(saveCassette: boolean): Promise<void>;
}

export async function startEnvironment(
  repoRoot: string,
  config: DemoConfig,
  mode: DemoMode,
): Promise<Environment> {
  const outDir = path.join(repoRoot, config.outputDir);
  const work = path.join("/tmp", "pai-demo");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const stateHome = fs.mkdtempSync("/tmp/pai-");
  const missFile = path.join(stateHome, "replay-miss.json");
  const cassetteDir = path.join(repoRoot, config.cassetteDir);
  fs.mkdirSync(cassetteDir, { recursive: true });

  const projectRoot = createProject(repoRoot, config);
  const certs = ensureTestCertificates(path.join(repoRoot, "src", "e2e", "proxy", "certs"));
  const log = (line: string): void => console.log(`[demo] ${line}`);
  const mock = await MockServerController.launch({
    mode: mode === "replay" ? "check" : "record",
    driver: DRIVER,
    fixturesHostDir: cassetteDir,
    mockServerCaPath: path.join(repoRoot, "src", "e2e", "mockserver", "mockserver-ca.pem"),
    shimCaPath: certs.caPath,
    shimCertPath: certs.certPath,
    shimKeyPath: certs.keyPath,
    missFilePath: mode === "replay" ? missFile : undefined,
    log: (line) => {
      if (/miss|error|fail/i.test(line)) {
        log(line);
      }
    },
  });
  if (mode === "replay") {
    await mock.prepareCheck(CASSETTE_CASE, DRIVER);
  } else {
    await mock.prepareRecord();
  }

  let shell: AgentShell | undefined;
  let screen: Screen | undefined;
  try {
    shell = prepareAgentShell({
      repoRoot,
      projectRoot,
      profileDir: work,
      checkMode: mode === "replay",
      proxyEnv: mockProxyEnv(mock.proxyUrl, mock.caPath),
      config,
    });
    screen = await startScreen(
      config.screen.display,
      config.screen.width * config.screen.scale,
      config.screen.height * config.screen.scale,
    );
    const workbench = await launchWorkbench({
      vscodeVersion: config.vscode.version,
      vsix: path.join(repoRoot, "dist", "paireto.vsix"),
      workspace: projectRoot,
      profileDir: path.join(work, "vscode"),
      display: screen.display,
      width: config.screen.width,
      height: config.screen.height,
      scale: config.screen.scale,
      settings: {
        ...config.vscode.settings,
        "paireto.notify.type": "disabled",
        "paireto.review.mode": "automatic",
        "paireto.planApprove.mode.claudecode": "acceptEdits",
        "terminal.integrated.defaultProfile.linux": "agent",
        "terminal.integrated.profiles.linux": {
          agent: { path: "bash", args: ["--rcfile", shell.rcFile] },
        },
        "terminal.integrated.env.linux": shell.env,
      },
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: shell.env.CLAUDE_CONFIG_DIR,
        FONTCONFIG_FILE: writeFontConfig(work),
        XDG_STATE_HOME: stateHome,
        PAIRETO_NODE_DIR: path.dirname(process.execPath),
      },
    });
    const ready = { shell, screen };
    return {
      mode,
      projectRoot,
      outDir,
      screen,
      workbench,
      replayMiss: () =>
        mode === "replay"
          ? (mock.explainMiss(CASSETTE_CASE, DRIVER, missFile) ?? readReplayMiss(missFile))
          : undefined,
      finish: async (saveCassette) => {
        await workbench.close();
        ready.screen.stop();
        try {
          if (saveCassette && mode === "record") {
            await mock.snapshotFixture(CASSETTE_CASE, DRIVER);
          }
        } finally {
          await mock.stop();
          ready.shell.cleanup();
        }
      },
    };
  } catch (err) {
    screen?.stop();
    shell?.cleanup();
    await mock.stop();
    throw err;
  }
}

function writeFontConfig(dir: string): string {
  const file = path.join(dir, "fonts.conf");
  const prefer = (family: string): string =>
    `  <alias binding="strong"><family>${family}</family><prefer><family>Inter</family></prefer></alias>`;
  fs.writeFileSync(
    file,
    [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
      "<fontconfig>",
      '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>',
      ...["system-ui", "sans-serif", "sans", "Ubuntu", "Droid Sans"].map(prefer),
      "</fontconfig>",
      "",
    ].join("\n"),
  );
  return file;
}
