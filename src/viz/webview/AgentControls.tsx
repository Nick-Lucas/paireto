import type { UiAction } from "../model/ui";
import type { VizReviewState } from "../protocol";
import { BarLabel } from "./Header";
import { UiIcon } from "./icons";
import { vscode } from "./vscode";

function commentsText(pending: number): string {
  return `${pending} ${pending === 1 ? "comment" : "comments"}`;
}

function agentStatus(waiting: boolean, pending: number): string {
  if (waiting) {
    return "Waiting for your review";
  }
  if (pending > 0) {
    return `${commentsText(pending)} not sent yet`;
  }
  return "Not waiting for you";
}

function AgentStatus({ review }: { review: VizReviewState }) {
  const { waiting, pending } = review.feedback;
  const status = agentStatus(waiting, pending);
  return (
    <section
      className={`viz-agent ${waiting ? "viz-agent--waiting" : ""}`}
      aria-label="Agent"
      title={status}
    >
      {waiting && <span className="viz-agent__pulse" aria-hidden />}
      <span className="viz-agent__status">{status}</span>
    </section>
  );
}

interface AgentBarProps {
  review: VizReviewState;
  placing: boolean;
  dispatch: (action: UiAction) => void;
}

function AgentActions({ review, placing, dispatch }: AgentBarProps) {
  const { waiting, pending } = review.feedback;
  const comments = commentsText(pending);
  return (
    <>
      <button
        type="button"
        className={`viz-tool ${placing ? "viz-tool--on" : ""}`}
        title="Add a comment. Click a part to comment on it, or empty space for a free comment (c)"
        aria-pressed={placing}
        onClick={() => dispatch({ type: "placeComment" })}
      >
        <UiIcon name="comment" size={14} />
        <span className="viz-action__label">Comment</span>
        <kbd>C</kbd>
      </button>
      <button
        type="button"
        className="viz-tool"
        title="Add a note that asks the agent to make this diagram again. It goes to the agent with Send comments."
        onClick={() => vscode.postMessage({ type: "regenerate" })}
      >
        <UiIcon name="reset" size={14} />
        <span className="viz-action__label">Ask to redraw</span>
      </button>
      {pending > 0 && (
        <button
          type="button"
          className="viz-btn"
          title={`Send ${comments} to the agent`}
          onClick={() => vscode.postMessage({ type: "gate", action: "sendFeedback" })}
        >
          <UiIcon name="send" size={13} /> Send comments · {pending}
        </button>
      )}
      {waiting && (
        <button
          type="button"
          className={`viz-btn ${pending > 0 ? "viz-btn--secondary" : ""}`}
          title="Tell the agent the change is good"
          onClick={() => vscode.postMessage({ type: "gate", action: "approve" })}
        >
          <UiIcon name="check" size={13} /> Approve
        </button>
      )}
    </>
  );
}

export function AgentBar(props: AgentBarProps) {
  return (
    <footer className="viz-agentbar">
      <BarLabel>Agent</BarLabel>
      <AgentStatus review={props.review} />
      <span className="viz-header__spacer" />
      <AgentActions {...props} />
    </footer>
  );
}
