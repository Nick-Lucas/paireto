import { findNodeAtLocation, parseTree, type Node } from "jsonc-parser";

export function issuePathSegments(issuePath: string): (string | number)[] {
  return [...issuePath.matchAll(/\[(\d+)\]|([^.[\]]+)/g)].map((match) =>
    match[1] === undefined ? match[2] : Number(match[1]),
  );
}

export function issueRange(text: string, issuePath: string): [number, number] {
  const tree = parseTree(text);
  if (!tree) {
    return [0, 0];
  }
  const segments = issuePathSegments(issuePath);
  for (let length = segments.length; length > 0; length--) {
    const node = findNodeAtLocation(tree, segments.slice(0, length));
    if (node) {
      const target = keyOf(node) ?? node;
      return [target.offset, target.offset + target.length];
    }
  }
  return [tree.offset, tree.offset + Math.min(tree.length, 1)];
}

function keyOf(node: Node): Node | undefined {
  return node.parent?.type === "property" ? node.parent.children?.[0] : undefined;
}
