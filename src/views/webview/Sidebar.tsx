import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type {
  SidebarAction,
  SidebarHostMessage,
  SidebarIcon,
  SidebarIconName,
  SidebarNode,
  SidebarState,
  SidebarWebviewMessage,
} from "../sidebarProtocol.js";

interface PersistedState {
  collapsed: string[];
}

interface VsCodeApi {
  postMessage(message: SidebarWebviewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface VisibleNode {
  node: SidebarNode;
  depth: number;
  parentId?: string;
}

export function Sidebar() {
  const [state, setState] = useState<SidebarState>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(vscode.getState()?.collapsed ?? []),
  );
  const [activeId, setActiveId] = useState<string>();
  const [selectionId, setSelectionId] = useState<string>();
  const rowElements = useRef(new Map<string, HTMLDivElement>());

  const visible = useMemo(() => flattenVisible(state?.nodes ?? [], collapsed), [state, collapsed]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      const message = event.data as SidebarHostMessage | undefined;
      if (message?.type === "state") {
        setState(message.state);
      }
    }
    window.addEventListener("message", receive);
    vscode.postMessage({ type: "requestState" });
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    const selected = state?.selectedNodeId;
    if (!selected) {
      return;
    }
    const ancestors = findAncestors(state.nodes, selected);
    if (ancestors.length) {
      setCollapsed((current) => {
        const next = new Set(current);
        for (const id of ancestors) {
          next.delete(id);
        }
        persist(next);
        return next;
      });
    }
    setActiveId(selected);
    setSelectionId(selected);
    requestAnimationFrame(() =>
      rowElements.current.get(selected)?.scrollIntoView({ block: "nearest" }),
    );
  }, [state?.selectedNodeId, state?.nodes]);

  function persist(next: ReadonlySet<string>) {
    vscode.setState({ collapsed: [...next] });
  }

  function toggle(node: SidebarNode) {
    if (!node.children?.length) {
      return;
    }
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      persist(next);
      return next;
    });
  }

  function run(action: SidebarAction | undefined) {
    if (action) {
      vscode.postMessage({ type: "runAction", action });
    }
  }

  function activate(node: SidebarNode) {
    setActiveId(node.id);
    setSelectionId(node.id);
    if (node.primaryAction) {
      run(node.primaryAction);
    } else {
      toggle(node);
    }
  }

  function onKeyDown(event: React.KeyboardEvent, current: SidebarNode) {
    const index = visible.findIndex(({ node }) => node.id === current.id);
    if (index < 0) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      focusNode(visible[index + offset]?.node.id);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (current.children?.length && collapsed.has(current.id)) {
        toggle(current);
      } else if (current.children?.length) {
        focusNode(current.children[0].id);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (current.children?.length && !collapsed.has(current.id)) {
        toggle(current);
      } else {
        focusNode(visible[index].parentId);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(current);
    } else if (event.key === " ") {
      event.preventDefault();
      toggle(current);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusNode(visible[0]?.node.id);
    } else if (event.key === "End") {
      event.preventDefault();
      focusNode(visible.at(-1)?.node.id);
    }
  }

  function focusNode(id: string | undefined) {
    if (!id) {
      return;
    }
    setActiveId(id);
    setSelectionId(id);
    requestAnimationFrame(() => rowElements.current.get(id)?.focus());
  }

  if (!state) {
    return <div className="loading">Loading…</div>;
  }

  return (
    <div className="tree" role="tree" aria-label="Paireto">
      {renderNodes(state.nodes, 0)}
    </div>
  );

  function renderNodes(nodes: SidebarNode[], depth: number): React.ReactNode {
    return nodes.map((node) => {
      const hasChildren = !!node.children?.length;
      const expanded = hasChildren && !collapsed.has(node.id);
      const selected = (selectionId ?? state?.selectedNodeId) === node.id;
      const active = activeId === node.id || (!activeId && selected);
      const style = { "--tree-depth": depth } as CSSProperties;
      const context = JSON.stringify({
        webviewSection: `sidebar.${node.kind}`,
        preventDefaultContextMenuItems: true,
        pairetoSidebarNodeId: node.id,
        pairetoSidebarActions: `,${[
          ...new Set(node.menuActions?.map(({ operation }) => operation) ?? []),
        ].join(",")},`,
      });
      return (
        <div role="none" key={node.id}>
          <div
            ref={(element) => {
              if (element) {
                rowElements.current.set(node.id, element);
              } else {
                rowElements.current.delete(node.id);
              }
            }}
            className={`tree-row kind-${node.kind}${selected ? " selected" : ""}${node.attention ? " attention" : ""}`}
            style={style}
            role="treeitem"
            aria-expanded={hasChildren ? expanded : undefined}
            aria-selected={selected}
            tabIndex={active ? 0 : -1}
            title={node.tooltip}
            data-node-id={node.id}
            data-vscode-context={context}
            onFocus={() => {
              setActiveId(node.id);
              setSelectionId(node.id);
            }}
            onKeyDown={(event) => onKeyDown(event, node)}
            onDoubleClick={() => hasChildren && toggle(node)}
            onClick={() => activate(node)}
            onContextMenu={() => {
              setActiveId(node.id);
              setSelectionId(node.id);
            }}
          >
            <button
              type="button"
              className={`twisty${expanded ? " expanded" : ""}${hasChildren ? "" : " empty"}`}
              aria-label={expanded ? "Collapse" : "Expand"}
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                toggle(node);
              }}
            >
              {hasChildren && <Glyph name="chevron" />}
            </button>
            <NodeIcon icon={node.icon} />
            <span className="label">{node.label}</span>
            {!!node.description && <span className="description">{node.description}</span>}
            {!!node.inlineActions?.length && (
              <span className="inline-actions">
                {node.inlineActions.map((action, index) => (
                  <button
                    type="button"
                    title={action.label}
                    aria-label={action.label}
                    key={`${action.operation}:${index}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      run(action);
                    }}
                  >
                    <Glyph name={action.icon} />
                  </button>
                ))}
              </span>
            )}
          </div>
          {expanded && node.children && (
            <div role="group">{renderNodes(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });
  }
}

function flattenVisible(
  nodes: SidebarNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
  parentId?: string,
): VisibleNode[] {
  const result: VisibleNode[] = [];
  for (const node of nodes) {
    result.push({ node, depth, parentId });
    if (node.children?.length && !collapsed.has(node.id)) {
      result.push(...flattenVisible(node.children, collapsed, depth + 1, node.id));
    }
  }
  return result;
}

function findAncestors(nodes: SidebarNode[], id: string, parents: string[] = []): string[] {
  for (const node of nodes) {
    if (node.id === id) {
      return parents;
    }
    if (node.children?.length) {
      const found = findAncestors(node.children, id, [...parents, node.id]);
      if (found.length) {
        return found;
      }
    }
  }
  return [];
}

function NodeIcon({ icon }: { icon: SidebarIcon | undefined }) {
  if (!icon) {
    return <span className="node-icon empty" />;
  }
  if (icon.kind === "status") {
    return (
      <span className={`node-icon status status-${icon.status}${icon.muted ? " muted" : ""}`}>
        {icon.status}
      </span>
    );
  }
  return (
    <span className={`node-icon tone-${icon.tone ?? "default"}`}>
      <Glyph name={icon.name} />
    </span>
  );
}

const ICON_GLYPHS: Record<SidebarIconName, string> = {
  add: "\uea60",
  bell: "\ueb9a",
  check: "\ueab2",
  chevron: "\ueab6",
  circle: "\ueabc",
  commit: "\ueafc",
  compare: "\ueafd",
  discard: "\ueae2",
  edit: "\uea73",
  eye: "\uea70",
  eyeClosed: "\ueae7",
  file: "\uea7b",
  folder: "\uea83",
  layers: "\uebd2",
  layout: "\ueb86",
  missing: "\ueabd",
  open: "\uea94",
  question: "\ueb32",
  remove: "\ueb3b",
  rocket: "\ueb44",
  terminal: "\uea85",
  tools: "\ueb6d",
  trash: "\uea81",
  warning: "\uea6c",
};

function Glyph({ name }: { name: SidebarIconName }) {
  return (
    <span className="codicon" aria-hidden="true">
      {ICON_GLYPHS[name]}
    </span>
  );
}
