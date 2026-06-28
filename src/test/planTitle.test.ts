// Unit tests for planDocLabel — the pure plan tab-title builder.

import * as assert from "node:assert";

import { planDocLabel } from "../plan/planTitle.js";

const AT = new Date(2026, 5, 28, 14, 30); // 2026-06-28 14:30 local (month is 0-based)
const STAMP = "2026-06-28 14:30";

suite("planDocLabel", () => {
  test("uses the first meaningful line and appends the datetime", () => {
    assert.strictEqual(planDocLabel("Add a login form\nmore detail", AT), `PLAN: Add a login form - ${STAMP}`);
  });

  test("strips leading markdown heading markers", () => {
    assert.strictEqual(planDocLabel("# Refactor the gate model", AT), `PLAN: Refactor the gate model - ${STAMP}`);
  });

  test("strips list/quote/bold markers and leading whitespace", () => {
    assert.strictEqual(planDocLabel("   - **Do the thing**", AT), `PLAN: Do the thing** - ${STAMP}`);
  });

  test("skips blank lines to the first non-empty one", () => {
    assert.strictEqual(planDocLabel("\n\n  \nFirst real line", AT), `PLAN: First real line - ${STAMP}`);
  });

  test("removes slashes so the title stays a single path segment", () => {
    assert.strictEqual(planDocLabel("Update src/foo/bar.ts", AT), `PLAN: Update src foo bar.ts - ${STAMP}`);
  });

  test("truncates long first lines with an ellipsis", () => {
    const long = "x".repeat(100);
    const label = planDocLabel(long, AT);
    const title = label.slice("PLAN: ".length, label.length - ` - ${STAMP}`.length);
    assert.strictEqual(title.length, 60);
    assert.ok(title.endsWith("…"));
  });

  test("falls back to 'Plan' when there is no text", () => {
    assert.strictEqual(planDocLabel("   \n  \n", AT), `PLAN: Plan - ${STAMP}`);
  });

  test("zero-pads month, day, hour, and minute", () => {
    assert.strictEqual(planDocLabel("hi", new Date(2026, 0, 3, 9, 5)), "PLAN: hi - 2026-01-03 09:05");
  });
});
