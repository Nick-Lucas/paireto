import * as assert from "node:assert";
import { setTimeout as delay } from "node:timers/promises";

import type { FeedbackRef } from "../git/gitCli.js";
import {
  createFeedbackRebuilder,
  type FeedbackRebuilder,
} from "../review/feedback/feedbackRebuilder.js";
import type { FeedbackContext, FeedbackSession } from "../review/feedback/FeedbackSession.js";

const main: FeedbackRef = { kind: "branch", value: "main" };

const context = (repoRoot: string): FeedbackContext => ({ roots: [{ repoRoot, ref: main }] });

const nameOf = (next: FeedbackContext): string => next.roots[0].repoRoot;

interface Gate<T> {
  promise: Promise<T>;
  release: (value: T) => void;
}

function gate<T>(): Gate<T> {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Let every pending job run, so a rebuild that can move forward has moved forward. */
const tick = (): Promise<void> => delay(0);

/** True when the promise already has its answer. */
async function finished(promise: Promise<unknown>): Promise<boolean> {
  return (await Promise.race([promise.then(() => "yes"), delay(10).then(() => "no")])) === "yes";
}

suite("feedback rebuilder", () => {
  let calls: string[];
  let installed: Array<FeedbackSession | undefined>;
  let sessions: Map<string, FeedbackSession>;
  let names: Map<FeedbackSession, string>;
  let openNext: (next: FeedbackContext) => Promise<FeedbackSession>;
  let rebuilder: FeedbackRebuilder;

  /**
   * A stand-in for one session. FeedbackSession has a private constructor and private fields, so a
   * fake can only reach the type through a cast. The rebuilder calls close, dispose and render only.
   */
  function makeSession(name: string): FeedbackSession {
    const fake = {
      close: async (): Promise<void> => {
        calls.push(`${name} close`);
      },
      dispose: (): void => {
        calls.push(`${name} dispose`);
      },
      render: (): void => {
        calls.push(`${name} render`);
      },
    };
    const session = fake as unknown as FeedbackSession;
    sessions.set(name, session);
    names.set(session, name);
    return session;
  }

  setup(() => {
    calls = [];
    installed = [];
    sessions = new Map();
    names = new Map();
    openNext = async (next) => makeSession(nameOf(next));
    rebuilder = createFeedbackRebuilder({
      open: (next, outgoing) => {
        calls.push(`open ${nameOf(next)}${outgoing ? ` after ${names.get(outgoing)}` : ""}`);
        return openNext(next);
      },
      install: (session) => {
        installed.push(session);
        calls.push(`install ${names.get(session)}`);
      },
    });
  });

  teardown(async () => {
    await rebuilder.dispose();
  });

  test("a context change takes the old threads down, then opens and installs the new session", async () => {
    await rebuilder.apply(context("/a"));
    calls.length = 0;

    await rebuilder.apply(context("/b"));

    assert.deepStrictEqual(calls, ["/a dispose", "open /b after /a", "install /b", "/a close"]);
  });

  test("the outgoing session is offered to the next one, so an unchanged bucket is not reopened", async () => {
    await rebuilder.apply(context("/a"));
    const first = sessions.get("/a");
    let offered: FeedbackSession | undefined;
    openNext = async (next) => makeSession(nameOf(next));
    rebuilder = createFeedbackRebuilder({
      open: (next, outgoing) => {
        offered = outgoing;
        return openNext(next);
      },
      install: () => {},
    });

    await rebuilder.apply(context("/b"));
    assert.strictEqual(offered, undefined, "a fresh rebuilder has nothing to hand over");
    await rebuilder.apply(context("/c"));
    assert.strictEqual(offered, sessions.get("/b"));
    assert.notStrictEqual(offered, first);
  });

  test("the live session is never absent across a rebuild that has comments on both sides", async () => {
    await rebuilder.apply(context("/a"));
    const first = sessions.get("/a");
    const opening = gate<FeedbackSession>();
    openNext = () => opening.promise;

    const rebuild = rebuilder.apply(context("/b"));
    await tick();

    assert.strictEqual(installed.length, 1, "no second install while the new session opens");
    assert.strictEqual(installed[0], first);
    assert.deepStrictEqual(calls, ["open /a", "install /a", "/a dispose", "open /b after /a"]);

    opening.release(makeSession("/b"));
    await rebuild;

    assert.strictEqual(installed.length, 2);
    assert.strictEqual(installed[1], sessions.get("/b"));
    assert.ok(
      installed.every((session) => session !== undefined),
      "install always names a session",
    );
    assert.deepStrictEqual(calls, [
      "open /a",
      "install /a",
      "/a dispose",
      "open /b after /a",
      "install /b",
      "/a close",
    ]);
  });

  test("two context changes run one at a time and the newest one is installed", async () => {
    const opening = gate<FeedbackSession>();
    openNext = () => opening.promise;
    const first = rebuilder.apply(context("/a"));
    await tick();
    openNext = async (next) => makeSession(nameOf(next));

    const second = rebuilder.apply(context("/b"));
    await tick();
    assert.deepStrictEqual(calls, ["open /a"], "the second rebuild waits for the first");

    opening.release(makeSession("/a"));
    await Promise.all([first, second]);

    assert.deepStrictEqual(calls, [
      "open /a",
      "install /a",
      "/a dispose",
      "open /b after /a",
      "install /b",
      "/a close",
    ]);
    assert.strictEqual(installed.at(-1), sessions.get("/b"));
  });

  test("a failed open puts the old threads back and does not block a later rebuild", async () => {
    await rebuilder.apply(context("/a"));
    openNext = () => Promise.reject(new Error("the bucket file is unreadable"));

    await rebuilder.apply(context("/b"));

    assert.deepStrictEqual(calls, [
      "open /a",
      "install /a",
      "/a dispose",
      "open /b after /a",
      "/a render",
    ]);
    assert.strictEqual(installed.at(-1), sessions.get("/a"), "the old session stays installed");

    openNext = async (next) => makeSession(nameOf(next));
    await rebuilder.apply(context("/c"));

    assert.deepStrictEqual(calls, [
      "open /a",
      "install /a",
      "/a dispose",
      "open /b after /a",
      "/a render",
      "/a dispose",
      "open /c after /a",
      "install /c",
      "/a close",
    ]);
    assert.strictEqual(installed.at(-1), sessions.get("/c"));
  });

  test("dispose writes the live session out and takes its threads down", async () => {
    await rebuilder.apply(context("/a"));
    calls.length = 0;

    await rebuilder.dispose();
    assert.deepStrictEqual(calls, ["/a close", "/a dispose"]);

    await rebuilder.dispose();
    assert.deepStrictEqual(calls, ["/a close", "/a dispose"], "there is nothing left to take down");

    await rebuilder.apply(context("/b"));
    assert.deepStrictEqual(calls, ["/a close", "/a dispose", "open /b", "install /b"]);
  });

  test("settled resolves only when no rebuild is running", async () => {
    assert.strictEqual(await finished(rebuilder.settled()), true, "an idle rebuilder is settled");

    const opening = gate<FeedbackSession>();
    openNext = () => opening.promise;
    const rebuild = rebuilder.apply(context("/a"));
    const settled = rebuilder.settled();

    assert.strictEqual(await finished(settled), false);

    opening.release(makeSession("/a"));
    await rebuild;

    assert.strictEqual(await finished(settled), true);
  });

  test("dispose waits for a rebuild that is already running", async () => {
    const opening = gate<FeedbackSession>();
    openNext = () => opening.promise;
    const rebuild = rebuilder.apply(context("/a"));
    await tick();

    const closed = rebuilder.dispose();
    assert.strictEqual(await finished(closed), false);
    assert.deepStrictEqual(calls, ["open /a"], "dispose does not cut in front of the rebuild");

    opening.release(makeSession("/a"));
    await Promise.all([rebuild, closed]);

    assert.deepStrictEqual(calls, ["open /a", "install /a", "/a close", "/a dispose"]);
  });
});
