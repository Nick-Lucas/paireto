// The id one piece of feedback is keyed by. Real ids are random, but a recorded E2E run and its
// replay must mint the same ids in the same order: the replayed agent quotes an id back from the
// cassette, and the window it reaches has to be holding that same item. Under test the ids therefore
// come from a fixed list rather than from randomness.

/** The first id a test window hands out — the token every recorded cassette already carries in the
 *  tool calls it replays, which is what keeps an existing recording matchable. */
export const RECORDED_FEEDBACK_ID = "PAIRETO_E2E_FEEDBACK_ID";

let issued = 0;

/** The next id in the fixed sequence a recording and its replay both walk. Ids after the first only
 *  have to be distinct and stable, so they count on from the recorded one. */
export function fakeNanoId(): string {
  issued += 1;
  return issued === 1 ? RECORDED_FEEDBACK_ID : `${RECORDED_FEEDBACK_ID}_${issued}`;
}

/** A new feedback id: deterministic under E2E, random in a real window. nanoid is ESM-only, so it is
 *  reached through a dynamic import. */
export async function newFeedbackId(): Promise<string> {
  if (process.env.PAIRETO_TEST === "1") {
    return fakeNanoId();
  }
  return (await import("nanoid")).nanoid();
}
