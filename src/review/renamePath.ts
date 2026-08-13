// Works out the repo-relative path a rename input box asks for, and says why it cannot when it
// cannot. Pure and POSIX-only: repo-relative paths are `/`-separated everywhere in this codebase, so
// node:path would drag Windows separators into a value that has none.

/** Characters no repository can carry. Rejected on EVERY platform: a name that only works on macOS
 *  breaks the checkout for everyone on Windows. */
const FORBIDDEN = '<>:"|?*';

export type RenameTarget = { ok: true; path: string } | { ok: false; message: string };

/**
 * Resolve what the user typed against the file's own folder. A bare name renames in place, a name
 * with `/` moves the file, and `..` walks up. A result equal to `currentPath` is ok — "unchanged" is
 * a cancel for the caller, not something to show a message about.
 */
export function resolveRenameTarget(currentPath: string, input: string): RenameTarget {
  const typed = input.replace(/\\/g, "/").trim();
  const segments = typed.split("/");
  const last = segments[segments.length - 1];
  if (typed === "" || last === "" || last === "." || last === "..") {
    return { ok: false, message: "Type a file name." };
  }
  // A drive letter needs its separator: without it, `b:.ts` is a name holding a forbidden `:`, and
  // that is the more useful message to show.
  if (typed.startsWith("/") || /^[a-zA-Z]:\//.test(typed)) {
    return { ok: false, message: "Type a name or a path inside the repository." };
  }
  if (segments.some((segment) => segment === "")) {
    return { ok: false, message: "Remove the empty folder name." };
  }
  for (const segment of segments) {
    const bad = [...segment].find(
      (char) => FORBIDDEN.includes(char) || char.codePointAt(0)! < 0x20,
    );
    if (bad !== undefined) {
      return { ok: false, message: `The character ${bad} cannot be used in a file name.` };
    }
  }

  const parts = currentPath.split("/").slice(0, -1);
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (parts.length === 0) {
        return { ok: false, message: "The new path must stay inside the repository." };
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return { ok: true, path: parts.join("/") };
}
