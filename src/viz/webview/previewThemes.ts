export type PreviewTheme = "dark" | "light";

const SHARED = {
  "--vscode-font-family":
    '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Ubuntu, "Droid Sans", sans-serif',
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": 'Menlo, Monaco, "Courier New", monospace',
  "--vscode-editor-font-size": "12px",
};

const PREVIEW_THEMES: Record<PreviewTheme, Record<string, string>> = {
  dark: {
    ...SHARED,
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-errorForeground": "#f88070",
    "--vscode-focusBorder": "#0078d4",
    "--vscode-widget-border": "#313131",
    "--vscode-panel-border": "#2b2b2b",
    "--vscode-editorWidget-background": "#202020",
    "--vscode-sideBar-background": "#181818",
    "--vscode-badge-background": "#616161",
    "--vscode-badge-foreground": "#f8f8f8",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#026ec1",
    "--vscode-button-secondaryBackground": "#313131",
    "--vscode-button-secondaryForeground": "#cccccc",
    "--vscode-button-secondaryHoverBackground": "#3c3c3c",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-border": "#3c3c3c",
    "--vscode-input-placeholderForeground": "#989898",
    "--vscode-dropdown-background": "#313131",
    "--vscode-dropdown-foreground": "#cccccc",
    "--vscode-dropdown-border": "#3c3c3c",
    "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
    "--vscode-gitDecoration-modifiedResourceForeground": "#e2c08d",
    "--vscode-gitDecoration-deletedResourceForeground": "#c74e39",
    "--vscode-textLink-foreground": "#4daafc",
    "--vscode-list-hoverBackground": "#2a2d2e",
    "--vscode-toolbar-hoverBackground": "#5a5d5e50",
    "--vscode-editorWarning-foreground": "#cca700",
  },
  light: {
    ...SHARED,
    "--vscode-editor-background": "#ffffff",
    "--vscode-foreground": "#3b3b3b",
    "--vscode-descriptionForeground": "#6b6b6b",
    "--vscode-errorForeground": "#f85149",
    "--vscode-focusBorder": "#005fb8",
    "--vscode-widget-border": "#e5e5e5",
    "--vscode-panel-border": "#e5e5e5",
    "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-sideBar-background": "#f8f8f8",
    "--vscode-badge-background": "#cccccc",
    "--vscode-badge-foreground": "#3b3b3b",
    "--vscode-button-background": "#005fb8",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#0258a8",
    "--vscode-button-secondaryBackground": "#e5e5e5",
    "--vscode-button-secondaryForeground": "#3b3b3b",
    "--vscode-button-secondaryHoverBackground": "#cccccc",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#3b3b3b",
    "--vscode-input-border": "#cecece",
    "--vscode-input-placeholderForeground": "#767676",
    "--vscode-dropdown-background": "#ffffff",
    "--vscode-dropdown-foreground": "#3b3b3b",
    "--vscode-dropdown-border": "#cecece",
    "--vscode-gitDecoration-addedResourceForeground": "#587c0c",
    "--vscode-gitDecoration-modifiedResourceForeground": "#895503",
    "--vscode-gitDecoration-deletedResourceForeground": "#ad0707",
    "--vscode-textLink-foreground": "#005fb8",
    "--vscode-list-hoverBackground": "#f2f2f2",
    "--vscode-toolbar-hoverBackground": "#b8b8b850",
    "--vscode-editorWarning-foreground": "#bf8803",
  },
};

export function applyPreviewTheme(theme: PreviewTheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(PREVIEW_THEMES[theme])) {
    root.style.setProperty(name, value);
  }
  document.body.classList.toggle("vscode-dark", theme === "dark");
  document.body.classList.toggle("vscode-light", theme === "light");
  document.body.dataset.vscodeThemeKind = theme === "dark" ? "vscode-dark" : "vscode-light";
}
