import type { VizReviewState } from "../protocol";
import { BarLabel } from "./Header";
import { UiIcon } from "./icons";
import { vscode } from "./vscode";

interface ActionBarProps {
  review: VizReviewState;
}

function agentStatus(waiting: boolean, comments: string, pending: number): string {
  if (waiting) {
    return "Waiting for your review";
  }
  if (pending > 0) {
    return `${comments} not sent yet`;
  }
  return "Not waiting for you";
}

export function ActionBar({ review }: ActionBarProps) {
  const { waiting, pending } = review.feedback;
  const comments = `${pending} ${pending === 1 ? "comment" : "comments"}`;
  return (
    <footer className={`viz-actionbar ${waiting ? "viz-agent--waiting" : ""}`}>
      <section className="viz-actionbar__agent" aria-label="Agent">
        <BarLabel>Agent</BarLabel>
        {waiting && <span className="viz-agent__pulse" aria-hidden />}
        <span className="viz-agent__status">{agentStatus(waiting, comments, pending)}</span>
        {waiting && pending > 0 && <span className="viz-agent__notes">· {comments} not sent</span>}
      </section>
      <span className="viz-header__spacer" />
      <button
        type="button"
        className="viz-tool"
        title="Add a note that asks the agent to make this diagram again. It goes to the agent with Send comments."
        onClick={() => vscode.postMessage({ type: "regenerate" })}
      >
        <UiIcon name="reset" size={14} /> Ask to redraw
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
    </footer>
  );
}
