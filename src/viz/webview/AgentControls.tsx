import type { VizReviewState } from "../protocol";
import { UiIcon } from "./icons";
import { BarLabel } from "./parts";
import { vscode } from "./vscode";

function commentsText(pending: number): string {
  return `${pending} ${pending === 1 ? "comment" : "comments"}`;
}

function agentStatus(waiting: boolean, pending: number): string {
  if (waiting) {
    return "Waiting for your review of this change";
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
}

function AgentActions({ review }: AgentBarProps) {
  const { waiting, pending } = review.feedback;
  const comments = commentsText(pending);
  return (
    <>
      {pending > 0 && (
        <button
          type="button"
          className="viz-btn"
          title={`Send the ${comments} not sent yet to the agent`}
          onClick={() => vscode.postMessage({ type: "gate", action: "sendFeedback" })}
        >
          <UiIcon name="send" size={13} /> Send {comments}
        </button>
      )}
      {waiting && (
        <button
          type="button"
          className={`viz-btn ${pending > 0 ? "viz-btn--secondary" : ""}`}
          title="End your review. The agent carries on with no changes. Comments not sent yet stay here."
          onClick={() => vscode.postMessage({ type: "gate", action: "approve" })}
        >
          <UiIcon name="check" size={13} /> Continue, no changes
        </button>
      )}
    </>
  );
}

export function AgentBar(props: AgentBarProps) {
  return (
    <div className="viz-agentbar">
      <BarLabel>Agent</BarLabel>
      <AgentStatus review={props.review} />
      <span className="viz-header__spacer" />
      <AgentActions {...props} />
    </div>
  );
}
