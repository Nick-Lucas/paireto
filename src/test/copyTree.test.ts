import * as assert from "node:assert";

import { copyTreeSync } from "../e2e/drivers/copyTree.js";

function eintr(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("EINTR, Interrupted system call");
  error.code = "EINTR";
  return error;
}

suite("interrupted tree copy", () => {
  test("resumes a copy a signal interrupted", () => {
    let calls = 0;
    copyTreeSync("/from", "/to", () => {
      calls += 1;
      if (calls < 3) {
        throw eintr();
      }
    });

    assert.strictEqual(calls, 3, "each interruption is retried until the copy completes");
  });

  test("gives up after the last attempt rather than looping", () => {
    let calls = 0;
    assert.throws(
      () =>
        copyTreeSync(
          "/from",
          "/to",
          () => {
            calls += 1;
            throw eintr();
          },
          3,
        ),
      /EINTR/,
    );
    assert.strictEqual(calls, 3);
  });

  test("a failure that is not an interruption is not retried", () => {
    let calls = 0;
    assert.throws(
      () =>
        copyTreeSync("/from", "/to", () => {
          calls += 1;
          const error: NodeJS.ErrnoException = new Error("ENOSPC, no space left");
          error.code = "ENOSPC";
          throw error;
        }),
      /ENOSPC/,
    );
    assert.strictEqual(calls, 1, "a real failure surfaces at once");
  });
});
