import type { VizReviewState } from "../protocol";
import { UiIcon } from "./icons";
import { vscode } from "./vscode";

function commentsText(pending: number): string {
  return `${pending} ${pending === 1 ? "comment" : "comments"}`;
}

function agentStatus(waiting: boolean, pending: number): string {
  if (waiting) {
    return "Agent is waiting for your review";
  }
  if (pending > 0) {
    return `${commentsText(pending)} not sent yet`;
  }
  return "Agent is not waiting for you";
}

export function AgentStatus({ review }: { review: VizReviewState }) {
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

export function AgentActions({ review }: { review: VizReviewState }) {
  const { waiting, pending } = review.feedback;
  const comments = commentsText(pending);
  return (
    <>
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
