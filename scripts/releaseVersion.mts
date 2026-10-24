import * as fs from "node:fs";
import * as path from "node:path";

type Bump = "patch" | "minor" | "major";

interface Version {
  major: number;
  minor: number;
  patch: number;
}

const BUMPS: readonly Bump[] = ["patch", "minor", "major"];

export function parseVersion(text: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) {
    throw new Error(`${text} is not a major.minor.patch version`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion({ major, minor, patch }: Version): string {
  return `${major}.${minor}.${patch}`;
}

export function nextStable(current: Version, bump: Bump): Version {
  switch (bump) {
    case "major":
      return { major: current.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: current.major, minor: current.minor + 2 - (current.minor % 2), patch: 0 };
    case "patch":
      return { ...current, patch: current.patch + 1 };
  }
}

export function preRelease(stable: Version, build: number): Version {
  return { major: stable.major, minor: stable.minor + 1 + (stable.minor % 2), patch: build };
}

function isBump(value: string): value is Bump {
  return (BUMPS as readonly string[]).includes(value);
}

function main([command, arg]: string[]): string {
  const manifest = path.resolve(import.meta.dirname, "../package.json");
  const current = parseVersion(JSON.parse(fs.readFileSync(manifest, "utf8")).version);
  if (command === "stable" && arg !== undefined && isBump(arg)) {
    return formatVersion(nextStable(current, arg));
  }
  if (command === "prerelease" && arg !== undefined && /^[1-9]\d*$/.test(arg)) {
    return formatVersion(preRelease(current, Number(arg)));
  }
  throw new Error(
    "usage: releaseVersion.mts stable <patch|minor|major> | prerelease <build number>",
  );
}

if (import.meta.main) {
  console.log(main(process.argv.slice(2)));
}
