import type { DeltaFile } from "../review/delta.js";
import type { SeenFiles } from "../review/SeenFiles.js";

export const RESET_REVIEW = "Reset review";

export async function resetReview(
  seen: Pick<SeenFiles, "isSeen" | "setSeen">,
  files: readonly DeltaFile[],
  confirm: (message: string, action: string) => Thenable<string | undefined>,
): Promise<boolean> {
  const seenCount = files.filter((file) => seen.isSeen(file)).length;
  if (seenCount === 0) {
    return false;
  }
  const answer = await confirm(
    `Reset the review? ${seenCount} of ${files.length} files are marked seen. They will all be marked not seen.`,
    RESET_REVIEW,
  );
  if (answer !== RESET_REVIEW) {
    return false;
  }
  await seen.setSeen([...files], false);
  return true;
}
