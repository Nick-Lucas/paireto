import { useState, type ReactNode } from "react";

import type { VizDelta, VizFileRef, VizLineCounts, VizMember, VizNode } from "../../protocol/viz";
import {
  stepAt,
  type IndexedEdge,
  type IndexedStep,
  type Stage,
  type VizIndex,
} from "../model/index";
import {
  changeWord,
  linksCausedBy,
  multiplicityText,
  nodeContextChips,
  notesAbout,
} from "../model/inspector";
import { edgeTarget, memberTarget, nodeTarget } from "../model/notes";
import { changedMembers, rankedNodes } from "../model/review";
import type { VizRef } from "../model/types";
import { commentsAllowed, type UiAction } from "../model/ui";
import { chipOf, overviewKind } from "../model/visible";
import type { VizNote, VizNoteTarget, VizReviewState } from "../protocol";
import { KindIcon, UiIcon, type UiIconName } from "./icons";
import { ChipMark, Counts } from "./parts";
import { vscode } from "./vscode";
import "./inspector.css";

interface InspectorProps {
  index: VizIndex;
  stage: Stage;
  selection: VizRef | undefined;
  review: VizReviewState;
  dispatch: (action: UiAction) => void;
}

type Dispatch = InspectorProps["dispatch"];

const MEMBER_ICON: Record<VizMember["kind"], UiIconName> = {
  method: "symbolMethod",
  constructor: "symbolMethod",
  field: "symbolField",
  property: "symbolField",
  variant: "symbolField",
};

function lines(file: VizFileRef): string {
  if (!file.line) {
    return "";
  }
  return file.endLine && file.endLine !== file.line
    ? `lines ${file.line}–${file.endLine}`
    : `line ${file.line}`;
}

function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

function openFile(file: VizFileRef, mode: "diff" | "file") {
  vscode.postMessage({ type: "open", file, mode });
}

function comment(dispatch: Dispatch, target: VizNoteTarget | undefined) {
  if (target) {
    dispatch({
      type: "startDraft",
      noteKind: "comment",
      targets: [target],
      place: undefined,
      at: { x: 0, y: 0 },
    });
  }
}

function Change({ item }: { item: { delta?: VizDelta; detail?: VizNode["detail"] } }) {
  const delta = item.delta ?? "unchanged";
  return <span className={`viz-chg viz-chg--${delta}`}>{changeWord(item)}</span>;
}

function Head({
  icon,
  title,
  struck,
  crumb,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  struck?: boolean;
  crumb?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="viz-inspector__head">
      <h3 className="viz-inspector__title">
        <span className="viz-inspector__icon">{icon}</span>
        <span className={struck ? "viz-struck" : ""}>{title}</span>
      </h3>
      {crumb && <div className="viz-inspector__crumb">{crumb}</div>}
      {children && <div className="viz-chips">{children}</div>}
    </header>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="viz-inspector__actions">{children}</div>;
}

function ActionButton({
  icon,
  primary,
  title,
  onClick,
  children,
}: {
  icon: UiIconName;
  primary?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`viz-btn ${primary ? "" : "viz-btn--secondary"}`}
      title={title}
      onClick={onClick}
    >
      <UiIcon name={icon} size={13} /> {children}
    </button>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="viz-isec">
      <button
        type="button"
        className="viz-isec__head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <UiIcon name={open ? "down" : "next"} size={12} />
        <span className="viz-isec__title">{title}</span>
        {count && <span className="viz-isec__count">{count}</span>}
      </button>
      {open && <div className="viz-isec__body">{children}</div>}
    </section>
  );
}

function Row({
  lead,
  children,
  side,
  title,
  onClick,
}: {
  lead?: ReactNode;
  children: ReactNode;
  side?: ReactNode;
  title?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      {lead && <span className="viz-irow__lead">{lead}</span>}
      <span className="viz-irow__main">{children}</span>
      {side && <span className="viz-irow__side">{side}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="viz-irow viz-irow--link" title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="viz-irow" title={title}>
      {body}
    </div>
  );
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function FilesSection({
  files,
  review,
  title = "Files",
}: {
  files: readonly VizFileRef[] | undefined;
  review: VizReviewState;
  title?: string;
}) {
  if (!files || files.length === 0) {
    return null;
  }
  return (
    <Section title={title} count={String(files.length)}>
      {files.map((file, i) => {
        const { name, dir } = splitPath(file.path);
        const seen = review.files.find((entry) => entry.path === file.path)?.seen;
        return (
          <div key={i} className="viz-irow viz-irow--file">
            <span className="viz-irow__lead">
              <UiIcon name="file" size={13} />
            </span>
            <span className="viz-irow__main" title={file.path}>
              {name}
              <span className="viz-irow__dim">
                {[dir, lines(file)].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="viz-irow__side">
              {seen && (
                <span className="viz-irow__seen" title="You marked this file seen">
                  <UiIcon name="check" size={12} />
                </span>
              )}
              <button
                type="button"
                className="viz-iconbtn"
                title="Open diff"
                onClick={() => openFile(file, "diff")}
              >
                <UiIcon name="diff" />
              </button>
              <button
                type="button"
                className="viz-iconbtn"
                title="Open file"
                onClick={() => openFile(file, "file")}
              >
                <UiIcon name="file" />
              </button>
            </span>
          </div>
        );
      })}
    </Section>
  );
}

function CommentsSection({ notes, dispatch }: { notes: VizNote[]; dispatch: Dispatch }) {
  if (notes.length === 0) {
    return null;
  }
  const unsent = notes.filter((note) => !note.sent).length;
  return (
    <Section title="Comments" count={unsent > 0 ? `${unsent} not sent` : String(notes.length)}>
      {notes.map((note) => (
        <button
          key={note.id}
          type="button"
          className="viz-icomment"
          onClick={() => dispatch({ type: "openThread", id: note.id })}
        >
          <span className="viz-icomment__who">
            {note.kind === "question" ? "Question" : "Comment"} ·{" "}
            {note.sent ? (note.waiting ? "sent, waiting" : "sent") : "not sent"}
            {note.unread > 0 ? ` · ${plural(note.unread, "new reply", "new replies")}` : ""}
          </span>
          <span className="viz-icomment__body">{note.body}</span>
        </button>
      ))}
    </Section>
  );
}

function EdgeList({
  index,
  edges,
  direction,
  dispatch,
}: {
  index: VizIndex;
  edges: IndexedEdge[];
  direction: "out" | "in";
  dispatch: Dispatch;
}) {
  return edges.map((edge) => {
    const otherId = direction === "out" ? edge.to : edge.from;
    const other = index.nodeById.get(otherId);
    return (
      <Row
        key={edge.id}
        lead={<UiIcon name={direction === "out" ? "arrow" : "arrowLeft"} size={13} />}
        side={<span className="viz-irow__dim">{edge.label ?? edge.kind}</span>}
        title={`${edge.kind}${edge.label ? `: ${edge.label}` : ""}`}
        onClick={() => dispatch({ type: "goto", ref: { kind: "edge", id: edge.id } })}
      >
        {other?.label ?? otherId}
      </Row>
    );
  });
}

function MemberRows({
  node,
  members,
  dispatch,
}: {
  node: VizNode;
  members: VizMember[];
  dispatch: Dispatch;
}) {
  return members.map((member) => (
    <Row
      key={member.id}
      lead={<ChipMark chip={chipOf(member)} soft />}
      side={member.counts && <Counts counts={member.counts} />}
      title={member.label}
      onClick={() =>
        dispatch({ type: "goto", ref: { kind: "member", id: member.id, node: node.id } })
      }
    >
      <span className={member.delta === "removed" ? "viz-struck" : ""}>
        {member.short ?? member.label}
      </span>
    </Row>
  ));
}

function FlowRows({
  index,
  flows,
  nodeId,
  dispatch,
}: {
  index: VizIndex;
  flows: readonly string[];
  nodeId: string;
  dispatch: Dispatch;
}) {
  return flows.map((flowId) => {
    const flow = index.flowById.get(flowId);
    return (
      <Row
        key={flowId}
        lead={<UiIcon name="flow" size={13} />}
        side={flow && <Change item={flow} />}
        title="Open this flow's sequence diagram"
        onClick={() =>
          dispatch({
            type: "goto",
            ref: { kind: "node", id: nodeId },
            stage: { kind: "flow", flow: flowId },
          })
        }
      >
        {flow?.title ?? flowId}
      </Row>
    );
  });
}

function NodePanel({
  index,
  node,
  review,
  commentable,
  dispatch,
}: {
  index: VizIndex;
  node: VizNode;
  review: VizReviewState;
  commentable: boolean;
  dispatch: Dispatch;
}) {
  const out = (index.outEdges.get(node.id) ?? []).map((id) => index.edgeById.get(id)!);
  const inn = (index.inEdges.get(node.id) ?? []).map((id) => index.edgeById.get(id)!);
  const flows = index.flowsByNode.get(node.id) ?? [];
  const changed = changedMembers(node);
  const notes = notesAbout(review.notes, { kind: "node", id: node.id });
  const context = nodeContextChips(node, index);
  const file = node.files?.[0];
  return (
    <>
      <Head
        icon={<KindIcon kind={node.kind} size={16} />}
        title={node.label}
        struck={node.delta === "removed"}
        crumb={[node.kind, node.sub, context.length > 0 ? `in ${context.join(", ")}` : ""]
          .filter(Boolean)
          .join(" · ")}
      >
        <Change item={node} />
        {node.counts && <Counts counts={node.counts} />}
        {notes.length > 0 && (
          <span className="viz-kind-chip viz-kind-chip--muted">
            {plural(notes.length, "comment")}
          </span>
        )}
      </Head>
      {node.role && <p className="viz-inspector__role">{node.role}</p>}
      <Actions>
        {file && (
          <ActionButton icon="diff" primary onClick={() => openFile(file, "diff")}>
            Open diff
          </ActionButton>
        )}
        {file && (
          <ActionButton icon="file" onClick={() => openFile(file, "file")}>
            Open file
          </ActionButton>
        )}
        {commentable && (
          <ActionButton
            icon="comment"
            onClick={() => comment(dispatch, nodeTarget(index, node.id))}
          >
            Comment
          </ActionButton>
        )}
      </Actions>
      {changed.length > 0 && (
        <Section title="What changed" count={plural(changed.length, "member")}>
          <MemberRows node={node} members={changed} dispatch={dispatch} />
        </Section>
      )}
      <FilesSection files={node.files} review={review} />
      {out.length > 0 && (
        <Section title="Uses" count={String(out.length)}>
          <EdgeList index={index} edges={out} direction="out" dispatch={dispatch} />
        </Section>
      )}
      {inn.length > 0 && (
        <Section title="Used by" count={String(inn.length)}>
          <EdgeList index={index} edges={inn} direction="in" dispatch={dispatch} />
        </Section>
      )}
      {flows.length > 0 && (
        <Section title="In flows" count={String(flows.length)}>
          <FlowRows index={index} flows={flows} nodeId={node.id} dispatch={dispatch} />
        </Section>
      )}
      <CommentsSection notes={notes} dispatch={dispatch} />
    </>
  );
}

function MemberPanel({
  index,
  node,
  member,
  review,
  commentable,
  dispatch,
}: {
  index: VizIndex;
  node: VizNode;
  member: VizMember;
  review: VizReviewState;
  commentable: boolean;
  dispatch: Dispatch;
}) {
  const file = member.file ?? node.files?.[0];
  const links = linksCausedBy(index, member.id);
  const others = changedMembers(node).filter((other) => other.id !== member.id);
  const notes = notesAbout(review.notes, { kind: "member", id: member.id, node: node.id });
  const flags = [
    member.visibility,
    member.isStatic ? "static" : undefined,
    member.isAbstract ? "abstract" : undefined,
  ].filter((flag): flag is string => Boolean(flag));
  return (
    <>
      <Head
        icon={<UiIcon name={MEMBER_ICON[member.kind]} size={16} />}
        title={member.short ?? member.label}
        struck={member.delta === "removed"}
        crumb={
          <>
            {member.kind} · in{" "}
            <button
              type="button"
              className="viz-link viz-link--inline"
              onClick={() => dispatch({ type: "goto", ref: { kind: "node", id: node.id } })}
            >
              {node.label}
            </button>
          </>
        }
      >
        <Change item={member} />
        {member.counts && <Counts counts={member.counts} />}
        {flags.map((flag) => (
          <span key={flag} className="viz-kind-chip viz-kind-chip--muted">
            {flag}
          </span>
        ))}
      </Head>
      <Actions>
        {file && (
          <ActionButton icon="diff" primary onClick={() => openFile(file, "diff")}>
            {file.line ? `Open diff at line ${file.line}` : "Open diff"}
          </ActionButton>
        )}
        {commentable && (
          <ActionButton
            icon="comment"
            onClick={() => comment(dispatch, memberTarget(index, member.id))}
          >
            Comment
          </ActionButton>
        )}
      </Actions>
      <Section title="Signature">
        {member.previous && member.previous !== member.label ? (
          <div className="viz-isig">
            <div>
              <span className="viz-isig__key">Before</span>
              <code className="viz-isig__before">{member.previous}</code>
            </div>
            <div>
              <span className="viz-isig__key">Now</span>
              <code className="viz-isig__after">{member.label}</code>
            </div>
          </div>
        ) : (
          <div className="viz-isig">
            <code>{member.label}</code>
          </div>
        )}
      </Section>
      <FilesSection files={file ? [file] : undefined} review={review} title="File" />
      {links.length > 0 && (
        <Section title="Links it causes" count={String(links.length)}>
          <EdgeList index={index} edges={links} direction="out" dispatch={dispatch} />
        </Section>
      )}
      {others.length > 0 && (
        <Section title={`Other changes in ${node.label}`} count={plural(others.length, "member")}>
          <MemberRows node={node} members={others} dispatch={dispatch} />
        </Section>
      )}
      <CommentsSection notes={notes} dispatch={dispatch} />
    </>
  );
}

function EdgePanel({
  index,
  id,
  review,
  commentable,
  dispatch,
}: {
  index: VizIndex;
  id: string;
  review: VizReviewState;
  commentable: boolean;
  dispatch: Dispatch;
}) {
  const edge = index.edgeById.get(id);
  if (!edge) {
    return null;
  }
  const from = index.nodeById.get(edge.from);
  const to = index.nodeById.get(edge.to);
  const rides = index.stepsByEdge.get(id) ?? [];
  const causes = (edge.via ?? [])
    .map((memberId) => index.memberById.get(memberId))
    .filter((found) => found !== undefined);
  const notes = notesAbout(review.notes, { kind: "edge", id });
  const many = multiplicityText(edge.multiplicity);
  const file = edge.files?.[0];
  const goNode = (nodeId: string) => dispatch({ type: "goto", ref: { kind: "node", id: nodeId } });
  return (
    <>
      <Head
        icon={<UiIcon name="arrow" size={16} />}
        title={
          <>
            <button
              type="button"
              className="viz-link viz-link--inline"
              onClick={() => goNode(edge.from)}
            >
              {from?.label ?? edge.from}
            </button>
            <span className="viz-inspector__arrow">→</span>
            <button
              type="button"
              className="viz-link viz-link--inline"
              onClick={() => goNode(edge.to)}
            >
              {to?.label ?? edge.to}
            </button>
          </>
        }
        crumb={[edge.kind, edge.label && `"${edge.label}"`].filter(Boolean).join(" · ")}
      >
        <Change item={edge} />
        {edge.hero && (
          <span className="viz-kind-chip viz-kind-chip--hero">main path of this change</span>
        )}
        {many && <span className="viz-kind-chip viz-kind-chip--muted">{many}</span>}
      </Head>
      <Actions>
        {file && (
          <ActionButton icon="diff" primary onClick={() => openFile(file, "diff")}>
            Open diff
          </ActionButton>
        )}
        {commentable && (
          <ActionButton icon="comment" onClick={() => comment(dispatch, edgeTarget(index, id))}>
            Comment
          </ActionButton>
        )}
      </Actions>
      {causes.length > 0 && (
        <Section title="Caused by" count={plural(causes.length, "member")}>
          {causes.map(({ node, member }) => (
            <Row
              key={member.id}
              lead={<UiIcon name={MEMBER_ICON[member.kind]} size={13} />}
              onClick={() =>
                dispatch({ type: "goto", ref: { kind: "member", id: member.id, node: node.id } })
              }
            >
              {node.label}.{member.short ?? member.label}
            </Row>
          ))}
        </Section>
      )}
      <FilesSection files={edge.files} review={review} />
      {rides.length > 0 && (
        <Section title="Steps that use it" count={String(rides.length)}>
          {rides.map((locator) => {
            const step = stepAt(index, locator);
            const flow = index.flowById.get(locator.flow);
            return (
              <Row
                key={`${locator.flow}:${locator.index}`}
                lead={<span className="viz-link__num">{locator.index + 1}</span>}
                side={<span className="viz-irow__dim">{flow?.title}</span>}
                onClick={() => dispatch({ type: "goto", ref: { kind: "step", ...locator } })}
              >
                {step?.label}
              </Row>
            );
          })}
        </Section>
      )}
      <CommentsSection notes={notes} dispatch={dispatch} />
    </>
  );
}

function StepPanel({
  index,
  step,
  review,
  dispatch,
}: {
  index: VizIndex;
  step: IndexedStep;
  review: VizReviewState;
  dispatch: Dispatch;
}) {
  const from = index.nodeById.get(step.from);
  const to = index.nodeById.get(step.to);
  const flow = index.flowById.get(step.flow);
  const total = flow?.steps.length ?? 0;
  const goStep = (at: number) =>
    dispatch({ type: "goto", ref: { kind: "step", flow: step.flow, index: at } });
  const goNode = (nodeId: string) => dispatch({ type: "goto", ref: { kind: "node", id: nodeId } });
  return (
    <>
      <Head
        icon={<span className="viz-link__num viz-link__num--big">{step.index + 1}</span>}
        title={step.label}
        crumb={
          <>
            <button
              type="button"
              className="viz-link viz-link--inline"
              onClick={() => goNode(step.from)}
            >
              {from?.label ?? step.from}
            </button>
            {" → "}
            <button
              type="button"
              className="viz-link viz-link--inline"
              onClick={() => goNode(step.to)}
            >
              {to?.label ?? step.to}
            </button>
            {` · step ${step.index + 1} of ${total}`}
            {flow ? ` in ${flow.title}` : ""}
          </>
        }
      >
        <Change item={step} />
        {step.kind && <span className="viz-kind-chip viz-kind-chip--muted">{step.kind}</span>}
        {step.phase && (
          <span className="viz-kind-chip viz-kind-chip--muted">phase: {step.phase}</span>
        )}
      </Head>
      <Actions>
        {step.index > 0 && (
          <ActionButton icon="prev" onClick={() => goStep(step.index - 1)}>
            Step {step.index}
          </ActionButton>
        )}
        {step.index + 1 < total && (
          <ActionButton icon="next" onClick={() => goStep(step.index + 1)}>
            Step {step.index + 2}
          </ActionButton>
        )}
        <ActionButton
          icon="hierarchy"
          onClick={() => dispatch({ type: "goto", ref: step.overviewRef })}
        >
          Show in Overview
        </ActionButton>
      </Actions>
      {step.note && <p className="viz-inspector__role">{step.note}</p>}
      {step.request && (
        <Section title="Sends">
          <pre className="viz-code">{step.request}</pre>
        </Section>
      )}
      {step.response && (
        <Section title="Gets back">
          <pre className="viz-code">{step.response}</pre>
        </Section>
      )}
      <FilesSection files={step.files} review={review} />
    </>
  );
}

function biggest(index: VizIndex): { node: VizNode; counts?: VizLineCounts }[] {
  return rankedNodes(index)
    .slice(0, 6)
    .map((node) => ({ node, counts: node.counts }));
}

function StagePanel({
  index,
  stage,
  dispatch,
}: {
  index: VizIndex;
  stage: Stage;
  dispatch: Dispatch;
}) {
  if (stage.kind === "overview") {
    const changed = index.overviewNodes.filter((node) => node.delta !== "unchanged").length;
    const top = biggest(index);
    return (
      <>
        <Head
          icon={<UiIcon name="hierarchy" size={16} />}
          title="Overview"
          crumb={`${overviewKind(index)} · ${changed} of ${index.overviewNodes.length} parts changed${
            index.lanes.length > 0 ? ` across ${index.lanes.length} lanes` : ""
          }`}
        />
        <p className="viz-inspector__hint">
          Nothing selected. Click a part, a member or an arrow to see its details here.
        </p>
        {top.length > 0 && (
          <Section title="Biggest changes" count={String(top.length)}>
            {top.map(({ node, counts }) => (
              <Row
                key={node.id}
                lead={<ChipMark chip={chipOf(node)} soft />}
                side={counts && <Counts counts={counts} />}
                onClick={() => dispatch({ type: "goto", ref: { kind: "node", id: node.id } })}
              >
                {node.label}
              </Row>
            ))}
          </Section>
        )}
        <p className="viz-inspector__hint">Press ? for keys.</p>
      </>
    );
  }
  const flow = index.flowById.get(stage.flow);
  if (!flow) {
    return null;
  }
  return (
    <>
      <Head
        icon={<UiIcon name="flow" size={16} />}
        title={flow.title}
        crumb={`sequence diagram · ${plural(flow.steps.length, "step")} · ${plural(
          flow.participants.length,
          "participant",
        )}`}
      >
        <Change item={flow} />
      </Head>
      {flow.summary && <p className="viz-inspector__role">{flow.summary}</p>}
      <p className="viz-inspector__hint">
        Nothing selected. Press space to play the flow, or click a step to see it here.
      </p>
    </>
  );
}

export function Inspector({ index, stage, selection, review, dispatch }: InspectorProps) {
  const commentable = commentsAllowed(stage);
  let body: ReactNode;
  if (!selection) {
    body = <StagePanel index={index} stage={stage} dispatch={dispatch} />;
  } else if (selection.kind === "node") {
    const node = index.nodeById.get(selection.id);
    body = node ? (
      <NodePanel
        index={index}
        node={node}
        review={review}
        commentable={commentable}
        dispatch={dispatch}
      />
    ) : null;
  } else if (selection.kind === "member") {
    const found = index.memberById.get(selection.id);
    body = found ? (
      <MemberPanel
        index={index}
        node={found.node}
        member={found.member}
        review={review}
        commentable={commentable}
        dispatch={dispatch}
      />
    ) : null;
  } else if (selection.kind === "edge") {
    body = (
      <EdgePanel
        index={index}
        id={selection.id}
        review={review}
        commentable={commentable}
        dispatch={dispatch}
      />
    );
  } else if (selection.kind === "step") {
    const step = stepAt(index, selection);
    body = step ? (
      <StepPanel index={index} step={step} review={review} dispatch={dispatch} />
    ) : null;
  } else {
    body = (
      <StagePanel index={index} stage={{ kind: "flow", flow: selection.id }} dispatch={dispatch} />
    );
  }
  return <div className="viz-inspector">{body}</div>;
}
