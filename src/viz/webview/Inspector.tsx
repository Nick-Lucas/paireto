import type { VizEdge, VizFileRef, VizNode } from "../../protocol/viz";
import { stepAt, type IndexedStep, type Stage, type VizIndex } from "../model/index";
import { edgeKey } from "../model/refs";
import type { EdgeKey, VizRef } from "../model/types";
import type { UiAction } from "../model/ui";
import { DeltaBadge, KindIcon, UiIcon } from "./icons";
import { vscode } from "./vscode";

interface InspectorProps {
  index: VizIndex;
  stage: Stage;
  selection: VizRef | undefined;
  dispatch: (action: UiAction) => void;
}

function fileLabel(file: VizFileRef): string {
  const range = file.line
    ? `:${file.line}${file.endLine && file.endLine !== file.line ? `-${file.endLine}` : ""}`
    : "";
  return `${file.repo ? `${file.repo}/` : ""}${file.path}${range}`;
}

function Files({ files }: { files: readonly VizFileRef[] | undefined }) {
  if (!files || files.length === 0) {
    return null;
  }
  return (
    <section className="viz-inspector__section">
      <h4>Files</h4>
      <ul className="viz-files">
        {files.map((file, i) => (
          <li key={i} className="viz-file">
            <span className="viz-file__path" title={fileLabel(file)}>
              {fileLabel(file)}
            </span>
            <span className="viz-file__actions">
              <button
                type="button"
                className="viz-iconbtn"
                title="Open diff"
                onClick={() => vscode.postMessage({ type: "open", file, mode: "diff" })}
              >
                <UiIcon name="diff" />
              </button>
              <button
                type="button"
                className="viz-iconbtn"
                title="Open file"
                onClick={() => vscode.postMessage({ type: "open", file, mode: "file" })}
              >
                <UiIcon name="file" />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EdgeRow({
  index,
  edge,
  direction,
  dispatch,
}: {
  index: VizIndex;
  edge: VizEdge;
  direction: "in" | "out";
  dispatch: InspectorProps["dispatch"];
}) {
  const otherId = direction === "out" ? edge.to : edge.from;
  const other = index.nodeById.get(otherId);
  return (
    <li>
      <button
        type="button"
        className="viz-link"
        onClick={() =>
          dispatch({ type: "goto", ref: { kind: "edge", key: edgeKey(edge.from, edge.to) } })
        }
      >
        <span className="viz-link__arrow">{direction === "out" ? "→" : "←"}</span>
        <span className="viz-link__text">{other?.label ?? otherId}</span>
        {edge.label && <span className="viz-link__sub">{edge.label}</span>}
        <span className={`viz-kind-chip`}>{edge.kind}</span>
      </button>
    </li>
  );
}

function NodePanel({
  index,
  node,
  dispatch,
}: {
  index: VizIndex;
  node: VizNode;
  dispatch: InspectorProps["dispatch"];
}) {
  const out = (index.outEdges.get(node.id) ?? []).map((key) => index.edgesByKey.get(key)!);
  const inn = (index.inEdges.get(node.id) ?? []).map((key) => index.edgesByKey.get(key)!);
  const flows = index.flowsByNode.get(node.id) ?? [];
  return (
    <>
      <header className="viz-inspector__head">
        <span className={`viz-card__icon viz-card__icon--${node.delta}`}>
          <KindIcon kind={node.kind} size={16} />
        </span>
        <div>
          <h3 className={node.delta === "deleted" ? "viz-struck" : ""}>{node.label}</h3>
          {node.sub && <div className="viz-inspector__sub">{node.sub}</div>}
        </div>
      </header>
      <div className="viz-chips">
        <span className="viz-kind-chip">{node.kind}</span>
        <DeltaBadge delta={node.delta} />
        <span className="viz-kind-chip viz-kind-chip--muted">
          {index.lanes.find((lane) => lane.id === node.lane)?.label}
        </span>
        {node.group && <span className="viz-kind-chip viz-kind-chip--muted">{node.group}</span>}
      </div>
      {node.role && <p className="viz-inspector__role">{node.role}</p>}
      <Files files={node.files} />
      {(out.length > 0 || inn.length > 0) && (
        <section className="viz-inspector__section">
          <h4>Connections</h4>
          <ul className="viz-links">
            {out.map((edge) => (
              <EdgeRow
                key={`o${edge.to}`}
                index={index}
                edge={edge}
                direction="out"
                dispatch={dispatch}
              />
            ))}
            {inn.map((edge) => (
              <EdgeRow
                key={`i${edge.from}`}
                index={index}
                edge={edge}
                direction="in"
                dispatch={dispatch}
              />
            ))}
          </ul>
        </section>
      )}
      {flows.length > 0 && (
        <section className="viz-inspector__section">
          <h4>Appears in flows</h4>
          <div className="viz-chips">
            {flows.map((flowId) => (
              <button
                key={flowId}
                type="button"
                className="viz-chip-btn"
                onClick={() => {
                  dispatch({ type: "stage", stage: { kind: "flow", flow: flowId } });
                  dispatch({ type: "select", ref: { kind: "node", id: node.id } });
                }}
              >
                {index.flowById.get(flowId)?.title ?? flowId}
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function EdgePanel({
  index,
  id,
  dispatch,
}: {
  index: VizIndex;
  id: EdgeKey;
  dispatch: InspectorProps["dispatch"];
}) {
  const edge = index.edgesByKey.get(id);
  if (!edge) {
    return null;
  }
  const from = index.nodeById.get(edge.from);
  const to = index.nodeById.get(edge.to);
  const rides = index.stepsByEdge.get(id) ?? [];
  return (
    <>
      <header className="viz-inspector__head">
        <div>
          <h3>
            <button
              type="button"
              className="viz-link viz-link--inline"
              onClick={() => dispatch({ type: "goto", ref: { kind: "node", id: edge.from } })}
            >
              {from?.label ?? edge.from}
            </button>
            <span className="viz-inspector__arrow">{"→"}</span>
            <button
              type="button"
              className="viz-link viz-link--inline"
              onClick={() => dispatch({ type: "goto", ref: { kind: "node", id: edge.to } })}
            >
              {to?.label ?? edge.to}
            </button>
          </h3>
          {edge.label && <div className="viz-inspector__sub">{edge.label}</div>}
        </div>
      </header>
      <div className="viz-chips">
        <span className="viz-kind-chip">{edge.kind}</span>
        <DeltaBadge delta={edge.delta} />
        {edge.hero && <span className="viz-kind-chip viz-kind-chip--hero">hero path</span>}
      </div>
      <Files files={edge.files} />
      {rides.length > 0 && (
        <section className="viz-inspector__section">
          <h4>Steps on this edge</h4>
          <ul className="viz-links">
            {rides.map((locator) => {
              const step = stepAt(index, locator);
              const flow = index.flowById.get(locator.flow);
              return (
                <li key={`${locator.flow}:${locator.index}`}>
                  <button
                    type="button"
                    className="viz-link"
                    onClick={() => dispatch({ type: "goto", ref: { kind: "step", ...locator } })}
                  >
                    <span className="viz-link__num">{locator.index + 1}</span>
                    <span className="viz-link__text">{step?.label}</span>
                    <span className="viz-link__sub">{flow?.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}

function StepPanel({
  index,
  step,
  dispatch,
}: {
  index: VizIndex;
  step: IndexedStep;
  dispatch: InspectorProps["dispatch"];
}) {
  const from = index.nodeById.get(step.from);
  const to = index.nodeById.get(step.to);
  const overviewRef: VizRef | undefined = step.edge
    ? { kind: "edge", key: step.edge }
    : index.nodeById.get(step.from)?.flowOnly
      ? { kind: "node", id: step.to }
      : { kind: "node", id: step.from };
  return (
    <>
      <header className="viz-inspector__head">
        <span className="viz-link__num viz-link__num--big">{step.index + 1}</span>
        <div>
          <h3>{step.label}</h3>
          <div className="viz-inspector__sub">
            {from?.label ?? step.from} {"→"} {to?.label ?? step.to}
          </div>
        </div>
      </header>
      <div className="viz-chips">
        <span className="viz-kind-chip">{step.kind}</span>
        <DeltaBadge delta={step.delta} />
        {step.phase && <span className="viz-kind-chip viz-kind-chip--muted">{step.phase}</span>}
      </div>
      {step.request && (
        <section className="viz-inspector__section">
          <h4>Request</h4>
          <pre className="viz-code">{step.request}</pre>
        </section>
      )}
      {step.response && (
        <section className="viz-inspector__section">
          <h4>Response</h4>
          <pre className="viz-code">{step.response}</pre>
        </section>
      )}
      {step.note && <p className="viz-inspector__role">{step.note}</p>}
      <Files files={step.files} />
      <section className="viz-inspector__section">
        <button
          type="button"
          className="viz-btn viz-btn--secondary"
          onClick={() => dispatch({ type: "goto", ref: overviewRef })}
        >
          Show in overview
        </button>
      </section>
    </>
  );
}

function StagePanel({ index, stage }: { index: VizIndex; stage: Stage }) {
  if (stage.kind === "overview") {
    const changed = index.nodes.filter(
      (node) => node.delta !== "unchanged" && !node.flowOnly,
    ).length;
    return (
      <>
        <h3>Overview</h3>
        <p className="viz-inspector__role">
          {changed} of {index.nodes.filter((node) => !node.flowOnly).length} parts changed across{" "}
          {index.lanes.length} lanes.
        </p>
        <p className="viz-inspector__hint">
          Select a part or a connection to read its role and files. Press ? for keys.
        </p>
      </>
    );
  }
  const flow = index.flowById.get(stage.flow);
  if (!flow) {
    return null;
  }
  return (
    <>
      <h3>{flow.title}</h3>
      <div className="viz-chips">
        <DeltaBadge delta={flow.delta} />
        <span className="viz-kind-chip viz-kind-chip--muted">{flow.steps.length} steps</span>
        <span className="viz-kind-chip viz-kind-chip--muted">
          {flow.participants.length} participants
        </span>
      </div>
      {flow.summary && <p className="viz-inspector__role">{flow.summary}</p>}
      <p className="viz-inspector__hint">
        Press space to play the flow, or select a step to read it.
      </p>
    </>
  );
}

export function Inspector({ index, stage, selection, dispatch }: InspectorProps) {
  let body: React.ReactNode;
  if (!selection) {
    body = <StagePanel index={index} stage={stage} />;
  } else if (selection.kind === "node") {
    const node = index.nodeById.get(selection.id);
    body = node ? <NodePanel index={index} node={node} dispatch={dispatch} /> : null;
  } else if (selection.kind === "edge") {
    body = <EdgePanel index={index} id={selection.key} dispatch={dispatch} />;
  } else if (selection.kind === "step") {
    const step = stepAt(index, selection);
    body = step ? <StepPanel index={index} step={step} dispatch={dispatch} /> : null;
  } else {
    body = <StagePanel index={index} stage={{ kind: "flow", flow: selection.id }} />;
  }
  return (
    <aside className="viz-inspector">
      {selection && (
        <button
          type="button"
          className="viz-iconbtn viz-inspector__close"
          title="Clear selection (esc)"
          onClick={() => dispatch({ type: "select", ref: undefined })}
        >
          <UiIcon name="close" />
        </button>
      )}
      {body}
    </aside>
  );
}
