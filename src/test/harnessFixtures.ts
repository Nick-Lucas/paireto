// Shared scaffolding for per-harness mapper fixture suites: drive a strategy's toAppEvent over a
// table of exact (empirically-pinned) raw payloads and assert the mapped AppEvent, field by field.
// The mapper is the ONLY compile-time-unsound seam (a strategy narrows the wire union to its own
// dialect via method bivariance — see AgentStrategy), so these fixtures are the safety net. Each
// harness's suite (claudecode today; codex/opencode as they land) supplies its own fixtures and calls
// runMapperFixtures inside a suite().

import * as assert from "node:assert";

import type { AppEvent } from "../harness/appEvent.js";
import type { AgentStrategy } from "../harness/AgentStrategy.js";
import type { HarnessEventMeta, HarnessHookEvent } from "../protocol/types.js";

export interface MapperFixture {
  name: string;
  /** The raw harness payload, exactly as the plugin forwards it. */
  raw: HarnessHookEvent;
  /** Adapter-injected enrichment travelling alongside the raw event (see HarnessEventMeta) — the
   *  plan a Codex adapter recovered, an OpenCode child→parent correlation. Omitted = no meta. */
  meta?: HarnessEventMeta;
  /** The expected mapped AppEvent as a partial (only the listed fields are asserted), or null when
   *  the strategy must DROP the event (toAppEvent returns undefined). */
  expect: Partial<AppEvent> | null;
}

/** Register one mocha `test` per fixture. Call inside a `suite`. */
export function runMapperFixtures(strategy: AgentStrategy, fixtures: MapperFixture[]): void {
  for (const fx of fixtures) {
    test(fx.name, () => {
      const mapped = strategy.toAppEvent(fx.raw, fx.meta);
      if (fx.expect === null) {
        assert.strictEqual(mapped, undefined, `${fx.name}: expected the event to be dropped`);
        return;
      }
      assert.ok(mapped, `${fx.name}: expected a mapped AppEvent, got undefined`);
      for (const [key, value] of Object.entries(fx.expect)) {
        assert.deepStrictEqual(
          (mapped as unknown as Record<string, unknown>)[key],
          value,
          `${fx.name}: AppEvent.${key}`,
        );
      }
    });
  }
}
