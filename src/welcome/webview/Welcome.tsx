// The Welcome / onboarding screen, rendered in the webview with React. Styles live in the colocated
// welcome.css (imported by index.tsx and bundled to dist/welcome.css). State + actions flow over
// postMessage to the extension host (see ../protocol for the contract).
import { useEffect, useRef, useState } from "react";

import type {
  AgentState,
  InboundMessage,
  OutboundMessage,
  ShortcutState,
  WelcomeState,
} from "../protocol.js";

interface VsCodeApi {
  postMessage(msg: InboundMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

export function Welcome() {
  const [state, setState] = useState<WelcomeState | undefined>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const msg = event.data as OutboundMessage | undefined;
      if (!msg) {
        return;
      }
      if (msg.type === "state") {
        setState(msg.state);
      } else if (msg.type === "agentBusy") {
        setBusy((prev) => new Set(prev).add(msg.agentId));
      } else if (msg.type === "agentResult") {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(msg.agentId);
          return next;
        });
      }
    }
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "requestState" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function setupAgent(id: string) {
    setBusy((prev) => new Set(prev).add(id));
    vscode.postMessage({ type: "setupAgent", agentId: id });
  }

  return (
    <>
      <header className="hero">
        {!!state?.logoUri && <img className="logo" src={state.logoUri} alt="Paireto" />}
      </header>

      <section className="card">
        <h2>Set up your agent</h2>
        <p className="muted">
          Install the bridge plugin so your agent can talk to Paireto, and configure a terminal profile so you create sessions instantly.
        </p>
        <div className="rows">
          {(state?.agents ?? []).map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              busy={busy.has(a.id)}
              onSetupPlugin={() => setupAgent(a.id)}
              onConfigureProfile={() => vscode.postMessage({ type: "setupProfile", agentId: a.id })}
            />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>The Paireto way</h2>
          <div className="head-actions">
            <button
              type="button"
              className="btn"
              onClick={() => vscode.postMessage({ type: "setAllKeybindings" })}
            >
              Set all recommended
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => vscode.postMessage({ type: "openKeybindings" })}
            >
              Edit Keybindings
            </button>
          </div>
        </div>
        <p className="muted">
          Recommended keyboard shortcuts for driving the agent in the terminal. We only see your
          overrides and known defaults — bindings from other extensions aren&apos;t visible here.
        </p>
        <div className="rows">
          {(state?.shortcuts ?? []).map((s) => (
            <ShortcutRow key={s.id} shortcut={s} />
          ))}
        </div>
      </section>
    </>
  );
}

// The bridge-plugin step's right-hand action — split out so AgentRow stays free of nested ternaries.
function PluginStepAction({
  agent,
  busy,
  onSetup,
}: {
  agent: AgentState;
  busy: boolean;
  onSetup: () => void;
}) {
  // Popover state for the installed branch (hooks run unconditionally, before the early returns).
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function onPointer(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (busy) {
    return (
      <button type="button" className="btn" disabled>
        Setting up…
      </button>
    );
  }
  if (agent.installed) {
    // Click the "Installed" status to reveal a popover with the Reinstall action.
    return (
      <span className="installed-menu" ref={ref}>
        <button
          type="button"
          className="installed-toggle status-ok"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Manage"
          onClick={() => setMenuOpen((open) => !open)}
        >
          ✓ Installed ▾
        </button>
        {menuOpen && (
          <div className="popover" role="menu">
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setMenuOpen(false);
                onSetup();
              }}
            >
              Reinstall
            </button>
          </div>
        )}
      </span>
    );
  }
  return (
    <button type="button" className="btn" onClick={onSetup}>
      Set up
    </button>
  );
}

// One agent card: a header (name + status tag) and a list of setup steps, each with its own status
// and action (bridge plugin, then terminal profile).
function AgentRow({
  agent,
  busy,
  onSetupPlugin,
  onConfigureProfile,
}: {
  agent: AgentState;
  busy: boolean;
  onSetupPlugin: () => void;
  onConfigureProfile: () => void;
}) {
  return (
    <div className="row agent-row">
      <div className="agent-head">
        <span className="name">{agent.name}</span>
        {!agent.available && <span className="tag">Planned</span>}
      </div>
      <div className="steps">
        {agent.available && (
          <div className="step">
            <span className="step-label">Bridge plugin</span>
            <PluginStepAction agent={agent} busy={busy} onSetup={onSetupPlugin} />
          </div>
        )}
        {!!agent.profileName && (
          <div className="step">
            <span className="step-label">Terminal profile · {agent.profileName}</span>
            {agent.profileConfigured ? (
              <span className="status-ok">✓ Configured</span>
            ) : (
              <button type="button" className="btn" onClick={onConfigureProfile}>
                Configure
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The current-binding cell of a shortcut row — its own component so ShortcutRow avoids nesting.
function CurrentBinding({ shortcut }: { shortcut: ShortcutState }) {
  if (!shortcut.isSet) {
    return (
      <>
        <span className="src">recommended</span>
        <span className="kbd">{shortcut.recommended}</span>
      </>
    );
  }
  if (!shortcut.current) {
    return null;
  }
  return (
    <>
      <span className={"kbd" + (shortcut.currentSource === "default" ? " default" : "")}>
        {shortcut.current}
      </span>
      {shortcut.currentSource === "default" && <span className="src">(default)</span>}
    </>
  );
}

function ShortcutRow({ shortcut }: { shortcut: ShortcutState }) {
  return (
    <div className="row">
      <div className="label">
        <div className="name">{shortcut.label}</div>
        <button
          type="button"
          className="cmd-id"
          title="View this command in Keyboard Shortcuts"
          onClick={() => vscode.postMessage({ type: "openKeybindings", query: shortcut.command })}
        >
          {shortcut.command}
        </button>
      </div>
      <div className="current">
        <CurrentBinding shortcut={shortcut} />
      </div>
      {shortcut.isSet ? (
        <span className="status-ok">✓ Set</span>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => vscode.postMessage({ type: "setKeybinding", id: shortcut.id })}
        >
          Set
        </button>
      )}
    </div>
  );
}
