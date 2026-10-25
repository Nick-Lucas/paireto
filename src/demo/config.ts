import type { VideoStyle } from "./style.js";

export const demoConfig = {
  outputDir: "demo-out",
  outputFile: "paireto-demo.mp4",
  cassetteDir: "src/demo/cassettes",

  screen: { width: 1600, height: 900, scale: 2, fps: 30, display: ":100" },
  terminalHeight: 400,

  vscode: {
    version: "1.143.1",
    settings: {
      "workbench.colorTheme": "Default Dark Modern",
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "workbench.enableExperiments": false,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.layoutControl.enabled": false,
      "workbench.editor.enablePreview": false,
      "window.commandCenter": false,
      "window.titleBarStyle": "custom",
      "window.controlsStyle": "hidden",
      "comments.openView": "never",
      "window.menuBarVisibility": "compact",
      "chat.disableAIFeatures": true,
      "chat.commandCenter.enabled": false,
      "editor.fontFamily": "'JetBrains Mono', monospace",
      "editor.fontSize": 14,
      "editor.lineHeight": 22,
      "editor.minimap.enabled": false,
      "editor.stickyScroll.enabled": false,
      "editor.hover.delay": 250,
      "editor.renderWhitespace": "none",
      "editor.guides.indentation": false,
      "diffEditor.renderSideBySide": true,
      "diffEditor.hideUnchangedRegions.enabled": false,
      "terminal.integrated.fontFamily": "'JetBrains Mono'",
      "terminal.integrated.fontSize": 13,
      "terminal.integrated.lineHeight": 1,
      "terminal.integrated.gpuAcceleration": "off",
      "terminal.integrated.enablePersistentSessions": false,
      "terminal.integrated.showExitAlert": false,
      "terminal.integrated.hideOnStartup": "always",
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.ignoreRecommendations": true,
      "security.workspace.trust.enabled": false,
      "git.autofetch": false,
      "git.openRepositoryInParentFolders": "always",
      "scm.showActionButton": false,
      "files.autoSave": "off",
      "breadcrumbs.enabled": false,
      "typescript.tsserver.log": "off",
      "typescript.disableAutomaticTypeAcquisition": true,
    } as Record<string, unknown>,
  },

  project: {
    name: "acme-checkout",
    mainCommit: "Checkout pricing with shipping and tax",
    branch: "feature/discount-codes",
    branchCommit: "Render receipts as plain text for order emails",
  },

  agent: {
    model: "claude-sonnet-5-5",
    sessionId: "7f3c2a91-4b6e-4d2a-9c1f-5e8b3a6d2f40",
    allowedTools: [
      "mcp__plugin_paireto_bridge__paireto_review",
      "mcp__plugin_paireto_bridge__paireto_start_guided_review",
      "mcp__plugin_paireto_bridge__paireto_reply_to_feedback",
      "mcp__plugin_paireto_bridge__paireto_resolve_feedback",
      "Read",
      "Glob",
      "Grep",
      "Bash(npm test:*)",
      "Bash(node --test:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
    ],
  },

  pacing: {
    typingCharsPerSecond: 28,
    terminalTypingCharsPerSecond: 34,
    mousePixelsPerSecond: 1500,
    minMouseMs: 280,
    maxMouseMs: 750,
    settleMs: 450,
    readMs: 1600,
  },

  chapters: {
    planning: "Plan your work",
    development: "Review agent changes with your editor's Language Server features",
    viewModes: "Understand and judge your work",
    guidedReview: "Do real engineering",
  },

  planning: {
    prompt: "Plan the discount codes feature in docs/specs/discount-codes.md",
    comment: {
      anchor: /applyDiscount\(/,
      text: "Return a result that says why a code was rejected (expired, below the minimum spend) instead of throwing or quietly applying zero, so checkout can tell the customer.",
    },
  },

  development: {
    files: {
      rules: "src/discounts.ts",
      wiring: "src/checkout.ts",
    },
    hover: {
      line: /export function applyDiscount/,
      symbols: ["DiscountResult", "DiscountCode", "Money"],
    },
    edit: {
      find: /MAX_PERCENT_OFF\s*=\s*(\d+)/,
      replaceWith: "40",
    },
    comment: {
      text: "Finance capped codes at 40%, so I lowered this. Update the spec and the tests to match.",
    },
    peek: {
      line: /applyDiscount\(/,
      symbol: "applyDiscount",
    },
  },

  viewModes: {
    modes: [/^\S+\s+Delta,/, /^\S+\s+Flat,/, /^\S+\s+Review,/],
    markSeen: ["src/discounts.ts", "test/discounts.test.ts"],
    restore: [/^\S+\s+Tree,/, /^\S+\s+Staging,/],
    compareTo: /Merge base/,
    openFile: "src/receipt.ts",
  },

  guidedReview: {
    invocation: "/paireto:guided-review",
    changesets: 2,
  },

  video: {
    fps: 30,
    width: 1920,
    height: 1080,
    inset: 0.045,
    maxZoom: 2.1,
    clickZoom: 1.7,
    focusPadding: 1.12,
    cameraTransitionMs: 750,
    cameraLingerMs: 900,
    cameraLeadMs: 350,
    fastForwardMaxMs: 1600,
    chapterHoldMs: 2200,
    introMs: 2600,
    outroMs: 3600,
    background: ["#0d1117", "#16181d"],
    glow: ["rgba(10, 160, 255, 0.28)", "rgba(255, 123, 92, 0.20)"],
    accent: "#0aa0ff",
    fontFamily: "Inter, 'SF Pro Display', system-ui, sans-serif",
    cornerRadius: 14,
    cursorSize: 26,
    showKeys: true,
    logo: "PairetoLogo2x.png",
    intro: { tagline: "Pair-program with your coding agent, in VS Code" },
    outro: {
      headline: "Engineering is judgment.",
      subline: "Paireto for VS Code",
    },
  } satisfies VideoStyle,
};

export type DemoConfig = typeof demoConfig;
