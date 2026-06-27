// The Welcome / onboarding webview — the first (and only) webview in the extension. Shown once on
// first install (gated by a globalState marker in extension.ts) and reopenable via paireto.openWelcome.
// Two sections: per-agent setup (Claude Code functional, others "coming soon") and "The Paireto way"
// — a keybinding manager over built-in VS Code commands that writes the user's keybindings.json.

import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { PLUGIN_VERSION } from "../bridge/PluginInstaller.js";
import {
  type AgentTerminalProfile,
  type OnboardingAgent,
  ONBOARDING_AGENTS,
  buildTerminalProfile,
  findAgent,
  profilePlatformKey,
} from "./agents.js";
import {
  MANAGED_SHORTCUTS,
  type ManagedShortcut,
  type Platform,
  applyShortcut,
  debugShortcut,
  effectiveBinding,
  isApplied,
  parseKeybindings,
  recommendedKey,
} from "./keybindings.js";
import type { AgentState, ShortcutState, WelcomeState } from "./protocol.js";

const PLUGIN_VERSION_MARKER = "paireto.pluginInstalledVersion";

export class WelcomePanel {
  private static current: WelcomePanel | undefined;

  static show(context: vscode.ExtensionContext): void {
    if (WelcomePanel.current) {
      WelcomePanel.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "paireto.welcome",
      "Welcome to Paireto",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
          vscode.Uri.joinPath(context.extensionUri, "dist"),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "paireto.svg");
    WelcomePanel.current = new WelcomePanel(panel, context);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private readonly log = vscode.window.createOutputChannel("Paireto");

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
  ) {
    // NB: don't call this.log.show() here — it force-reveals the Output panel (the "bottom bar") every
    // time the Welcome tab opens. Debug logs still land in the "Paireto" channel; open it manually.
    this.disposables.push(this.log);
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** Append to the 'Paireto' output channel when `paireto.debug` is on. */
  private debug(msg: string): void {
    if (vscode.workspace.getConfiguration("paireto").get<boolean>("debug", false)) {
      this.log.appendLine(`[welcome] ${msg}`);
    }
  }

  private dispose(): void {
    WelcomePanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  // ---- messaging ---------------------------------------------------------

  private async onMessage(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "requestState":
        this.postState();
        return;
      case "setKeybinding":
        this.applyShortcutById(String(msg.id));
        this.postState();
        return;
      case "setAllKeybindings":
        this.applyAllBindings();
        this.postState();
        return;
      case "setupAgent":
        await this.setupAgent(String(msg.agentId));
        return;
      case "setupProfile":
        await this.setupProfile(String(msg.agentId));
        return;
      case "openKeybindings":
        void vscode.commands.executeCommand(
          "workbench.action.openGlobalKeybindings",
          typeof msg.query === "string" ? msg.query : undefined,
        );
        return;
      default:
        return;
    }
  }

  // ---- state -------------------------------------------------------------

  private platform(): Platform {
    return process.platform === "darwin" ? "mac" : "other";
  }

  /** `<userData>/User/keybindings.json` — derived from globalStorageUri (`<userData>/User/globalStorage/<ext>`). */
  private keybindingsPath(): string {
    const userDir = path.dirname(path.dirname(this.context.globalStorageUri.fsPath));
    return path.join(userDir, "keybindings.json");
  }

  private readKeybindings(): string {
    try {
      return fs.readFileSync(this.keybindingsPath(), "utf8");
    } catch {
      return "";
    }
  }

  private agentInstalled(agent: OnboardingAgent): boolean {
    if (agent.id !== "claude-code") {
      return false;
    }
    return this.context.globalState.get<string>(PLUGIN_VERSION_MARKER) === PLUGIN_VERSION;
  }

  /** True when the agent's terminal profile already exists in the user's settings for this platform. */
  private isProfileConfigured(profile: AgentTerminalProfile): boolean {
    const key = profilePlatformKey(process.platform);
    const existing =
      vscode.workspace
        .getConfiguration("terminal.integrated.profiles")
        .get<Record<string, unknown>>(key) ?? {};
    return !!existing[profile.name];
  }

  private buildState(): WelcomeState {
    const platform = this.platform();
    const raw = this.readKeybindings();
    const entries = parseKeybindings(raw);

    this.debug(
      `buildState: platform=${platform} keybindingsPath=${this.keybindingsPath()} ` +
        `bytes=${raw.length} parsedEntries=${entries.length}`,
    );
    for (const s of MANAGED_SHORTCUTS) {
      this.debug(`shortcut ${s.id}: ${JSON.stringify(debugShortcut(entries, s, platform))}`);
    }

    const agents: AgentState[] = ONBOARDING_AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      available: a.available,
      installed: this.agentInstalled(a),
      profileName: a.profile?.name,
      profileConfigured: a.profile ? this.isProfileConfigured(a.profile) : false,
    }));

    const shortcuts: ShortcutState[] = MANAGED_SHORTCUTS.map((s) => {
      const current = effectiveBinding(entries, s, platform);
      return {
        id: s.id,
        label: s.label,
        command: s.command,
        recommended: recommendedKey(s, platform),
        current: current?.key,
        currentSource: current?.source,
        isSet: isApplied(entries, s, platform),
        when: s.when,
      };
    });

    return { logoUri: this.mediaUri("PairetoHeader2x.png").toString(), agents, shortcuts };
  }

  private postState(): void {
    void this.panel.webview.postMessage({ type: "state", state: this.buildState() });
  }

  // ---- actions -----------------------------------------------------------

  private writeKeybindings(text: string): void {
    const file = this.keybindingsPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Paireto: couldn't write keybindings.json — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private applyShortcutById(id: string): void {
    const shortcut: ManagedShortcut | undefined = MANAGED_SHORTCUTS.find((s) => s.id === id);
    if (!shortcut) {
      this.debug(`applyShortcutById: unknown shortcut id "${id}"`);
      return;
    }
    this.debug(`applyShortcutById: ${id} (${shortcut.command})`);
    this.writeKeybindings(applyShortcut(this.readKeybindings(), shortcut, this.platform()));
  }

  private applyAllBindings(): void {
    const platform = this.platform();
    let text = this.readKeybindings();
    for (const s of MANAGED_SHORTCUTS) {
      text = applyShortcut(text, s, platform);
    }
    this.writeKeybindings(text);
  }

  private async setupAgent(agentId: string): Promise<void> {
    const agent = findAgent(agentId);
    if (!agent?.available || !agent.install) {
      return;
    }
    void this.panel.webview.postMessage({ type: "agentBusy", agentId });
    const pluginsRoot = vscode.Uri.joinPath(this.context.extensionUri, "plugins").fsPath;
    const result = await agent.install(pluginsRoot);
    if (result.ok) {
      await this.context.globalState.update(PLUGIN_VERSION_MARKER, PLUGIN_VERSION);
    } else if (result.manualCommand) {
      const choice = await vscode.window.showWarningMessage(
        `Couldn't set up ${agent.name} automatically. Copy the manual command?`,
        "Copy Command",
      );
      if (choice === "Copy Command") {
        await vscode.env.clipboard.writeText(result.manualCommand);
        void vscode.window.showInformationMessage(
          "Command copied. Run it in a terminal, then restart the agent.",
        );
      }
    }
    void this.panel.webview.postMessage({
      type: "agentResult",
      agentId,
      ok: result.ok,
      detail: result.detail,
    });
    this.postState();
  }

  /** Add the agent's terminal profile to User settings (so it shows in the new-terminal-with-profile
   *  picker). Leaves an existing profile of the same name untouched. */
  private async setupProfile(agentId: string): Promise<void> {
    const profile: AgentTerminalProfile | undefined = findAgent(agentId)?.profile;
    if (!profile) {
      return;
    }
    const key = profilePlatformKey(process.platform);
    const cfg = vscode.workspace.getConfiguration("terminal.integrated.profiles");
    const existing = cfg.get<Record<string, unknown>>(key) ?? {};
    if (!existing[profile.name]) {
      const shell = vscode.env.shell || (key === "windows" ? "pwsh.exe" : "/bin/zsh");
      const entry = buildTerminalProfile(shell, profile.command, key);
      try {
        await cfg.update(
          key,
          { ...existing, [profile.name]: entry },
          vscode.ConfigurationTarget.Global,
        );
        this.debug(`added terminal profile "${profile.name}" → ${profile.command} (${key})`);
      } catch (err) {
        this.debug(`failed to write terminal profile: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.postState();
  }

  // ---- html --------------------------------------------------------------

  private mediaUri(file: string): vscode.Uri {
    return this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", file),
    );
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "welcome.js"),
    );
    // esbuild emits a sibling stylesheet from the webview's `import "./welcome.css"`.
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "welcome.css"),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Welcome to Paireto</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
