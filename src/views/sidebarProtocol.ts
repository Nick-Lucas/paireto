export type SidebarFileStatus = "A" | "M" | "D" | "R" | "C" | "U";

export interface SidebarChangedFile {
  path: string;
  oldPath?: string;
  status: SidebarFileStatus;
  group: "staged" | "unstaged" | "committed";
  additions: number;
  deletions: number;
  repoRoot: string;
}

export type SidebarOperation =
  | "openWelcome"
  | "pickCompareTo"
  | "toggleLayout"
  | "switchAgent"
  | "focusAgent"
  | "hideAgent"
  | "showAgent"
  | "openDiff"
  | "openFile"
  | "stageFiles"
  | "unstageFiles"
  | "discardFiles"
  | "openReviewPlan"
  | "openChangeset"
  | "openPlannedFile"
  | "stageChangeset"
  | "unstageChangeset"
  | "revealComment"
  | "deleteComment";

export type SidebarActionTarget =
  | { kind: "agent"; sessionId: string }
  | { kind: "file"; file: SidebarChangedFile }
  | {
      kind: "files";
      repoRoot: string;
      group: SidebarChangedFile["group"];
      pathPrefix?: string;
    }
  | { kind: "changeset"; changesetId: string }
  | { kind: "plannedFile"; changesetId: string; path: string }
  | { kind: "comment"; id: string };

export interface SidebarAction {
  operation: SidebarOperation;
  label: string;
  icon: SidebarIconName;
  target?: SidebarActionTarget;
}

export type SidebarIconName =
  | "add"
  | "bell"
  | "check"
  | "chevron"
  | "circle"
  | "commit"
  | "compare"
  | "discard"
  | "edit"
  | "eye"
  | "eyeClosed"
  | "file"
  | "folder"
  | "layers"
  | "layout"
  | "missing"
  | "open"
  | "question"
  | "remove"
  | "rocket"
  | "terminal"
  | "tools"
  | "trash"
  | "warning";

export type SidebarIcon =
  | { kind: "icon"; name: SidebarIconName; tone?: "default" | "muted" | "blue" | "orange" }
  | { kind: "status"; status: SidebarFileStatus; muted?: boolean };

export interface SidebarNode {
  id: string;
  kind:
    | "notice"
    | "section"
    | "changeset"
    | "repository"
    | "group"
    | "folder"
    | "file"
    | "agent"
    | "comment"
    | "placeholder";
  label: string;
  description?: string;
  tooltip?: string;
  icon?: SidebarIcon;
  children?: SidebarNode[];
  muted?: boolean;
  attention?: boolean;
  primaryAction?: SidebarAction;
  inlineActions?: SidebarAction[];
  menuActions?: SidebarAction[];
}

export interface SidebarState {
  nodes: SidebarNode[];
  badge: number;
  selectedNodeId?: string;
}

export type SidebarHostMessage = { type: "state"; state: SidebarState };

export type SidebarWebviewMessage =
  | { type: "requestState" }
  | { type: "runAction"; action: SidebarAction };
