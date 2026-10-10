import * as assert from "node:assert";

import { GateCoordinator, type GateEntry, type GateSession } from "../gate/GateCoordinator.js";

interface FakeSession extends GateSession {
  calls: string[];
}

function fakeSession(answer: () => boolean | Promise<boolean>): FakeSession {
  const calls: string[] = [];
  return {
    kind: "review",
    calls,
    approve: () => {
      calls.push("approve");
      return answer();
    },
    sendFeedback: () => {
      calls.push("sendFeedback");
      return answer();
    },
    hasFeedback: () => false,
  };
}

function entry(id: string, session: GateSession): GateEntry {
  return {
    id,
    kind: session.kind,
    repoRoot: "/repo",
    session,
    foreground: () => undefined,
    background: () => undefined,
  };
}

suite("GateCoordinator answers", () => {
  let coordinator: GateCoordinator;

  setup(() => {
    coordinator = new GateCoordinator(
      () => undefined,
      () => undefined,
    );
  });

  teardown(() => {
    coordinator.dispose();
  });

  test("a gate is marked answered before its session runs, so the buttons go first", async () => {
    let answeredWhileRunning: boolean | undefined;
    const session = fakeSession(() => {
      answeredWhileRunning = coordinator.isAnswered();
      return true;
    });
    await coordinator.register(entry("g1", session));
    let changes = 0;
    coordinator.onDidChange(() => changes++);

    await coordinator.answer((gate) => gate.sendFeedback());

    assert.strictEqual(answeredWhileRunning, true);
    assert.ok(changes > 0, "listeners hear about the answer");
    assert.strictEqual(coordinator.isAnswered(), true);
  });

  test("a second click on an answered gate does not reach its session", async () => {
    const session = fakeSession(() => true);
    await coordinator.register(entry("g1", session));

    await coordinator.answer((gate) => gate.sendFeedback());
    await coordinator.answer((gate) => gate.approve());

    assert.deepStrictEqual(session.calls, ["sendFeedback"]);
  });

  test("a second click while the first answer is still running does not reach the session", async () => {
    let finish: (answered: boolean) => void = () => undefined;
    const session = fakeSession(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await coordinator.register(entry("g1", session));

    const first = coordinator.answer((gate) => gate.sendFeedback());
    await coordinator.answer((gate) => gate.approve());
    finish(true);
    await first;

    assert.deepStrictEqual(session.calls, ["sendFeedback"]);
  });

  test("a refused answer opens the gate to the buttons again", async () => {
    const session = fakeSession(() => false);
    await coordinator.register(entry("g1", session));

    await coordinator.answer((gate) => gate.sendFeedback());

    assert.strictEqual(coordinator.isAnswered(), false);
    await coordinator.answer((gate) => gate.approve());
    assert.deepStrictEqual(session.calls, ["sendFeedback", "approve"]);
  });

  test("the next pending gate comes forward unanswered when the answered one closes", async () => {
    const first = fakeSession(() => true);
    const second = fakeSession(() => true);
    await coordinator.register(entry("g1", first));
    await coordinator.register(entry("g2", second));

    await coordinator.answer((gate) => gate.approve());
    await coordinator.unregister("g1");

    assert.strictEqual(coordinator.isAnswered(), false);
    await coordinator.answer((gate) => gate.approve());
    assert.deepStrictEqual(second.calls, ["approve"]);
  });
});
