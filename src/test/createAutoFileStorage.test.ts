import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createJSONStorage, persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

import { createAutoFileStorage } from "../storage/createAutoFileStorage.js";

const bucketValue = (...ids: string[]): string =>
  JSON.stringify({ state: { threads: ids.map((id) => ({ id })) } });

suite("automatic file storage", () => {
  let root: string;
  let file: string;
  let storage: ReturnType<typeof createAutoFileStorage>;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-file-storage-"));
    file = path.join(root, "buckets", "feedback.json");
    storage = createAutoFileStorage(file);
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a missing file reads as empty", async () => {
    assert.strictEqual(await storage.getItem("feedback"), null);
  });

  test("reads return raw strings for createJSONStorage to parse", async () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{ truncated");
    assert.strictEqual(await storage.getItem("feedback"), "{ truncated");
  });

  test("writes and reads the supplied JSON with private permissions", async () => {
    const value = bucketValue("one");
    await storage.setItem("feedback", value);
    assert.strictEqual(fs.readFileSync(file, "utf8"), value);
    assert.strictEqual(await storage.getItem("feedback"), value);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });

  test("debounces pending writes into one rename with the latest value", async () => {
    const rename = mock.method(fs.promises, "rename");
    try {
      await Promise.all([
        storage.setItem("feedback", bucketValue("one")),
        storage.setItem("feedback", bucketValue("two")),
        storage.setItem("feedback", bucketValue("three")),
      ]);
      assert.strictEqual(
        rename.mock.calls.filter(({ arguments: args }) => args[1] === file).length,
        1,
      );
      assert.strictEqual(fs.readFileSync(file, "utf8"), bucketValue("three"));
    } finally {
      rename.mock.restore();
    }
  });

  test("removing an item also cancels its pending write", async () => {
    await storage.setItem("feedback", bucketValue("one"));
    await Promise.all([
      storage.setItem("feedback", bucketValue("two")),
      storage.removeItem("feedback"),
    ]);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(await storage.getItem("feedback"), null);
  });

  test("setItem preserves an empty state; only removeItem deletes files", async () => {
    await storage.setItem("feedback", bucketValue("one"));
    await storage.setItem("feedback", bucketValue());
    assert.strictEqual(fs.readFileSync(file, "utf8"), bucketValue());
  });

  test("setItem accepts strings without a feedback schema", async () => {
    await storage.setItem("settings", "plain text");
    assert.strictEqual(await storage.getItem("settings"), "plain text");
  });

  test("read failures reach Zustand's hydration error hook", async () => {
    const failure = Object.assign(new Error("access denied"), { code: "EACCES" });
    const read = mock.method(fs.promises, "readFile", async () => {
      throw failure;
    });
    let hydrationError: unknown;
    try {
      const store = createStore<{ count: number }>()(
        persist(() => ({ count: 0 }), {
          name: "settings",
          skipHydration: true,
          storage: createJSONStorage(() => storage),
          onRehydrateStorage: () => (_state, error) => {
            hydrationError = error;
          },
        }),
      );
      await store.persist.rehydrate();
      assert.strictEqual(store.getState().count, 0);
      assert.strictEqual(hydrationError, failure);
    } finally {
      read.mock.restore();
    }
  });

  test("Zustand handles malformed JSON and retains the initial state", async () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{ truncated");
    let hydrationError: unknown;
    const store = createStore<{ count: number }>()(
      persist(() => ({ count: 0 }), {
        name: "settings",
        skipHydration: true,
        storage: createJSONStorage(() => storage),
        onRehydrateStorage: () => (_state, error) => {
          hydrationError = error;
        },
      }),
    );
    await store.persist.rehydrate();
    assert.strictEqual(store.getState().count, 0);
    assert.ok(hydrationError instanceof SyntaxError);
  });

  test("failed writes resolve and retry automatically", async function () {
    this.timeout(5000);
    const original = fs.promises.rename;
    let attempts = 0;
    const rename = mock.method(
      fs.promises,
      "rename",
      async (from: fs.PathLike, to: fs.PathLike) => {
        if (to === file && ++attempts === 1) {
          throw new Error("disk write failed");
        }
        return original(from, to);
      },
    );
    try {
      const results = await Promise.allSettled([
        storage.setItem("feedback", bucketValue("one")),
        storage.setItem("feedback", bucketValue("two")),
      ]);
      assert.deepStrictEqual(
        results.map((result) => result.status),
        ["fulfilled", "fulfilled"],
      );
      for (let i = 0; i < 150 && !fs.existsSync(file); i++) {
        await delay(20);
      }
      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).state.threads[0].id, "two");
      assert.strictEqual(attempts, 2);
    } finally {
      rename.mock.restore();
    }
  });

  test("close writes a pending value and resolves after it lands", async () => {
    void storage.setItem("feedback", bucketValue("pending"));
    await storage.close();
    assert.strictEqual(fs.readFileSync(file, "utf8"), bucketValue("pending"));
  });

  test("close waits for a write that is already running", async function () {
    this.timeout(5000);
    const original = fs.promises.rename;
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const rename = mock.method(
      fs.promises,
      "rename",
      async (from: fs.PathLike, to: fs.PathLike) => {
        if (to === file && first) {
          first = false;
          started();
          await blocked;
        }
        return original(from, to);
      },
    );
    try {
      void storage.setItem("feedback", bucketValue("slow"));
      await writing;
      let closed = false;
      const closing = storage.close().then(() => {
        closed = true;
      });
      await delay(50);
      assert.strictEqual(closed, false, "close waits for the running write");
      release();
      await closing;
      assert.strictEqual(fs.readFileSync(file, "utf8"), bucketValue("slow"));
    } finally {
      release();
      rename.mock.restore();
    }
  });

  test("close refuses a write that arrives after it", async () => {
    await storage.setItem("feedback", bucketValue("kept"));
    await storage.close();
    await storage.setItem("feedback", bucketValue("late"));
    await delay(120);
    assert.strictEqual(fs.readFileSync(file, "utf8"), bucketValue("kept"));
  });

  test("close gives up after a failed write and does not arm a retry", async function () {
    this.timeout(5000);
    let attempts = 0;
    const rename = mock.method(fs.promises, "rename", async (_from: unknown, to: fs.PathLike) => {
      if (to === file) {
        attempts++;
        throw new Error("disk write failed");
      }
    });
    try {
      void storage.setItem("feedback", bucketValue("doomed"));
      await storage.close();
      await delay(1300);
      assert.strictEqual(attempts, 1, "a closed adapter does not retry");
    } finally {
      rename.mock.restore();
    }
  });

  for (const clear of [false, true]) {
    test(`a failed write cannot replace a newer ${clear ? "clear" : "save"}`, async function () {
      this.timeout(5000);
      const original = fs.promises.rename;
      let release!: () => void;
      let started!: () => void;
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const rename = mock.method(
        fs.promises,
        "rename",
        async (from: fs.PathLike, to: fs.PathLike) => {
          if (to === file && first) {
            first = false;
            started();
            await blocked;
            throw new Error("disk write failed");
          }
          return original(from, to);
        },
      );
      try {
        const oldSave = storage.setItem("feedback", bucketValue("old"));
        const oldResult = Promise.allSettled([oldSave]);
        await writing;
        const latest = clear
          ? storage.removeItem("feedback")
          : storage.setItem("feedback", bucketValue("new"));
        await delay(100);
        release();
        assert.strictEqual((await oldResult)[0].status, "fulfilled");
        await latest;
        await delay(1100);
        if (clear) {
          assert.strictEqual(fs.existsSync(file), false);
        } else {
          assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).state.threads[0].id, "new");
        }
      } finally {
        release();
        rename.mock.restore();
      }
    });
  }
});
