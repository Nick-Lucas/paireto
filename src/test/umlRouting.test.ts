import * as assert from "node:assert";

import ELK from "elkjs/lib/elk.bundled.js";

import { applyFocus, NO_FILTERS, type FocusOptions } from "../uml/core/focus.js";
import {
  layoutDiagram,
  placeRoleLabels,
  type DiagramLayout,
  type EdgeLayout,
  type Measure,
  type Point,
} from "../uml/core/layout.js";
import type { RelationKind, UmlModel, UmlType } from "../uml/core/model.js";

const measure: Measure = (text, font) =>
  text.length * (font === "title" ? 8 : font === "code" ? 7.2 : 6.5);

const PLAIN: FocusOptions = { filters: NO_FILTERS, expanded: new Set() };

const CLEAR = 12;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Segment {
  a: Point;
  b: Point;
  edge: EdgeLayout;
}

function tangledModel(seed: number, typeCount: number, relationCount: number): UmlModel {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const model: UmlModel = {
    comparison: "HEAD",
    repoCount: 1,
    files: [],
    types: [],
    relations: [],
    comments: [],
    notes: [],
  };
  for (let f = 0; f < Math.ceil(typeCount / 3); f++) {
    model.files.push({
      key: `r:f${f}.ts`,
      repoRoot: "/r",
      repoName: "r",
      path: `src/m${f % 3}/f${f}.ts`,
      status: "M",
      counts: { added: 10, removed: 2 },
      read: false,
      openThreads: 0,
      hasOutline: true,
      changes: [],
    });
  }
  for (let i = 0; i < typeCount; i++) {
    const fileKey = model.files[i % model.files.length].key;
    const id = `${fileKey}::Type${i}`;
    const members = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, k) => ({
      id: `${id}::method:m${k}`,
      name: `member${k}`,
      compartment: "method" as const,
      isStatic: false,
      isAbstract: false,
      label: `member${k}(arg)`,
      short: `member${k}()`,
      change: "added" as const,
      counts: { added: 5, removed: 0 },
      span: { side: "modified" as const, start: k * 10, end: k * 10 + 5 },
      openThreads: 0,
    }));
    const type: UmlType = {
      id,
      name: `Type${i}`,
      kind: next() < 0.3 ? "interface" : "class",
      isAbstract: false,
      fileKey,
      change: "modified",
      headerChanged: false,
      counts: { added: 5 * members.length, removed: 0 },
      members,
      span: { side: "modified", start: 1, end: 90 },
      context: false,
      openThreads: 0,
    };
    model.types.push(type);
  }
  const kinds: RelationKind[] = [
    "association",
    "dependency",
    "generalization",
    "realization",
    "association",
    "dependency",
  ];
  const linked = new Set<string>();
  while (model.relations.length < relationCount) {
    const s = Math.floor(next() * typeCount);
    const t = Math.floor(next() * typeCount);
    if (s === t) {
      continue;
    }
    const kind = kinds[Math.floor(next() * kinds.length)];
    if (linked.has(`${s}-${t}`) || linked.has(`${t}-${s}`)) {
      continue;
    }
    linked.add(`${s}-${t}`);
    const multiplicity = next() < 0.3 ? "0..*" : undefined;
    model.relations.push({
      id: `${kind}:${s}->${t}`,
      kind,
      source: model.types[s].id,
      target: model.types[t].id,
      change: "added",
      via: [],
      roles: ["x"],
      multiplicity,
    });
  }
  return model;
}

const FIXTURES = [
  { name: "small", model: () => tangledModel(19, 10, 16) },
  { name: "medium", model: () => tangledModel(7, 14, 18) },
  { name: "large", model: () => tangledModel(11, 22, 30) },
];

const LAYOUTS = ["relationships", "folders"] as const;

async function layoutOf(model: UmlModel, mode: (typeof LAYOUTS)[number]): Promise<DiagramLayout> {
  return layoutDiagram(
    {
      view: applyFocus(model, "all", PLAIN),
      files: model.files,
      mode,
      aspectRatio: 1.6,
      repoCount: 1,
    },
    measure,
    new ELK(),
  );
}

function segments(layout: DiagramLayout): Segment[] {
  return layout.edges.flatMap((edge) =>
    edge.points.slice(1).map((b, i) => ({ a: edge.points[i], b, edge })),
  );
}

function vertical(s: Segment): boolean {
  return Math.abs(s.a.x - s.b.x) < 0.5;
}

function shared(from: number, to: number, start: number, end: number): number {
  return Math.min(Math.max(from, to), end) - Math.max(Math.min(from, to), start);
}

function gapAlongSides(s: Segment, box: Box): { gap: number; run: number } {
  if (vertical(s)) {
    return {
      gap: Math.min(Math.abs(s.a.x - box.x), Math.abs(s.a.x - box.x - box.width)),
      run: shared(s.a.y, s.b.y, box.y, box.y + box.height),
    };
  }
  return {
    gap: Math.min(Math.abs(s.a.y - box.y), Math.abs(s.a.y - box.y - box.height)),
    run: shared(s.a.x, s.b.x, box.x, box.x + box.width),
  };
}

function touches(s: Segment, box: Box): boolean {
  return (
    Math.max(s.a.x, s.b.x) > box.x &&
    Math.min(s.a.x, s.b.x) < box.x + box.width &&
    Math.max(s.a.y, s.b.y) > box.y &&
    Math.min(s.a.y, s.b.y) < box.y + box.height
  );
}

function describe(s: Segment): string {
  return `${s.edge.id} (${Math.round(s.a.x)},${Math.round(s.a.y)})→(${Math.round(s.b.x)},${Math.round(s.b.y)})`;
}

suite("UML diff — line routing", () => {
  for (const mode of LAYOUTS) {
    for (const fixture of FIXTURES) {
      test(`${mode}, ${fixture.name}: lines keep a clear gap from boxes they do not join`, async () => {
        const result = await layoutOf(fixture.model(), mode);
        const close: string[] = [];
        for (const s of segments(result)) {
          for (const node of result.nodes) {
            if (node.id === s.edge.relation.source || node.id === s.edge.relation.target) {
              continue;
            }
            const { gap, run } = gapAlongSides(s, node);
            if (gap < CLEAR && run > 4) {
              close.push(`${describe(s)} is ${gap.toFixed(1)} from ${node.id}`);
            }
          }
        }
        assert.deepStrictEqual(close, []);
      });

      test(`${mode}, ${fixture.name}: side-by-side lines keep a clear gap`, async () => {
        const result = await layoutOf(fixture.model(), mode);
        const all = segments(result);
        const close: string[] = [];
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            const p = all[i];
            const q = all[j];
            if (p.edge.id === q.edge.id || vertical(p) !== vertical(q)) {
              continue;
            }
            const gap = vertical(p) ? Math.abs(p.a.x - q.a.x) : Math.abs(p.a.y - q.a.y);
            const run = vertical(p)
              ? shared(p.a.y, p.b.y, Math.min(q.a.y, q.b.y), Math.max(q.a.y, q.b.y))
              : shared(p.a.x, p.b.x, Math.min(q.a.x, q.b.x), Math.max(q.a.x, q.b.x));
            if (gap < CLEAR && run > 20) {
              close.push(`${describe(p)} and ${describe(q)} are ${gap.toFixed(1)} apart`);
            }
          }
        }
        assert.deepStrictEqual(close, []);
      });

      test(`${mode}, ${fixture.name}: lines along a frame keep a clear gap from its border`, async () => {
        const result = await layoutOf(fixture.model(), mode);
        const close: string[] = [];
        for (const s of segments(result)) {
          for (const frame of result.containers) {
            const { gap, run } = gapAlongSides(s, frame);
            if (gap < CLEAR && run > 10) {
              close.push(`${describe(s)} is ${gap.toFixed(1)} from the border of ${frame.id}`);
            }
          }
        }
        assert.deepStrictEqual(close, []);
      });

      test(`${mode}, ${fixture.name}: multiplicity labels do not sit on lines or boxes`, async () => {
        const result = await layoutOf(fixture.model(), mode);
        const all = segments(result);
        const labelled = result.edges.filter((e) => e.label);
        assert.ok(labelled.length > 0, "the fixture has labels");
        const hidden: string[] = [];
        for (const edge of labelled) {
          const label = edge.label as Box;
          for (const s of all) {
            if (s.edge.id !== edge.id && touches(s, label)) {
              hidden.push(`${edge.id} label is on ${describe(s)}`);
            }
          }
          for (const node of result.nodes) {
            if (overlapsBox(node, label)) {
              hidden.push(`${edge.id} label is on ${node.id}`);
            }
          }
          for (const other of labelled) {
            if (other.id !== edge.id && overlapsBox(other.label as Box, label)) {
              hidden.push(`${edge.id} label is on the label of ${other.id}`);
            }
          }
        }
        assert.deepStrictEqual(hidden, []);
      });
    }
  }
});

function overlapsBox(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function onOwnLine(label: Box, points: readonly Point[]): boolean {
  const cx = label.x + label.width / 2;
  const cy = label.y + label.height / 2;
  return points.slice(1).some((b, i) => {
    const a = points[i];
    if (Math.abs(a.x - b.x) < 0.5) {
      return Math.abs(cx - a.x) < 0.5 && cy >= Math.min(a.y, b.y) && cy <= Math.max(a.y, b.y);
    }
    return Math.abs(cy - a.y) < 0.5 && cx >= Math.min(a.x, b.x) && cx <= Math.max(a.x, b.x);
  });
}

function crossesLine(points: readonly Point[], box: Box): boolean {
  return points
    .slice(1)
    .some((b, i) => touches({ a: points[i], b, edge: undefined as unknown as EdgeLayout }, box));
}

suite("UML diff — link labels", () => {
  const size = { width: 60, height: 18 };

  test("a label sits on its own line, not on a box beside the line", () => {
    const points = [
      { x: 100, y: 0 },
      { x: 100, y: 200 },
    ];
    const box = { x: 112, y: 80, width: 90, height: 40 };
    const placed = placeRoleLabels([{ id: "e", points, ...size }], [box], []);
    const label = placed.get("e");
    assert.ok(label);
    assert.ok(onOwnLine(label, points), JSON.stringify(label));
    assert.ok(!overlapsBox(label, box), JSON.stringify(label));
  });

  test("a label moves off the place where another selected line crosses its line", () => {
    const points = [
      { x: 0, y: 100 },
      { x: 300, y: 100 },
    ];
    const other = [
      { x: 150, y: 0 },
      { x: 150, y: 300 },
    ];
    const placed = placeRoleLabels(
      [{ id: "e", points, ...size }],
      [],
      [{ id: "o", points: other, strong: true }],
    );
    const label = placed.get("e");
    assert.ok(label);
    assert.ok(onOwnLine(label, points), JSON.stringify(label));
    assert.ok(!crossesLine(other, label), JSON.stringify(label));
  });

  test("labels on lines side by side do not cover each other", () => {
    const a = [
      { x: 100, y: 0 },
      { x: 100, y: 120 },
    ];
    const b = [
      { x: 130, y: 0 },
      { x: 130, y: 120 },
    ];
    const placed = placeRoleLabels(
      [
        { id: "a", points: a, ...size },
        { id: "b", points: b, ...size },
      ],
      [],
      [],
    );
    const first = placed.get("a");
    const second = placed.get("b");
    assert.ok(first && second);
    assert.ok(onOwnLine(first, a) && onOwnLine(second, b));
    assert.ok(!overlapsBox(first, second), JSON.stringify([first, second]));
  });

  test("a label with no room on its line sits beside it, tied to it by a leader", () => {
    const points = [
      { x: 100, y: 50 },
      { x: 140, y: 50 },
    ];
    const left = { x: 0, y: 0, width: 100, height: 100 };
    const right = { x: 140, y: 0, width: 100, height: 100 };
    const placed = placeRoleLabels([{ id: "e", points, ...size }], [left, right], []);
    const label = placed.get("e");
    assert.ok(label?.anchor, JSON.stringify(label));
    assert.ok(onOwnLine({ ...label.anchor, width: 0, height: 0 }, points));
    assert.ok(!overlapsBox(label, left) && !overlapsBox(label, right), JSON.stringify(label));
  });

  test("labels for many selected lines in a dense diagram are placed quickly", () => {
    const boxes = [];
    for (let row = 0; row < 10; row++) {
      for (let column = 0; column < 10; column++) {
        boxes.push({ x: column * 220, y: row * 160, width: 180, height: 120 });
      }
    }
    const lines = [];
    for (let i = 0; i < 30; i++) {
      const y = 140 + i * 3;
      lines.push({
        id: `e${i}`,
        strong: true,
        points: [
          { x: 200 + i * 7, y: 130 },
          { x: 200 + i * 7, y },
          { x: 2100 - i * 7, y },
          { x: 2100 - i * 7, y: 1500 },
        ],
      });
    }
    const labels = lines.map((line) => ({
      id: line.id,
      points: line.points,
      width: 90,
      height: 18,
    }));
    placeRoleLabels(labels, boxes, lines);
    const started = performance.now();
    const placed = placeRoleLabels(labels, boxes, lines);
    const took = performance.now() - started;
    assert.strictEqual(placed.size, 30);
    assert.ok(took < 120, `took ${Math.round(took)} ms`);
  });

  for (const mode of LAYOUTS) {
    for (const fixture of FIXTURES) {
      test(`${mode}, ${fixture.name}: labels of a selected type are on their own line and in clear space`, async () => {
        const result = await layoutOf(fixture.model(), mode);
        const hidden: string[] = [];
        for (const node of result.nodes) {
          const hot = result.edges.filter(
            (e) => e.relation.source === node.id || e.relation.target === node.id,
          );
          const taken = result.edges.flatMap((e) => (e.label ? [e.label] : []));
          const placed = placeRoleLabels(
            hot.map((e) => ({ id: e.id, points: e.points, width: 80, height: 18 })),
            [...result.nodes, ...taken],
            result.edges.map((e) => ({ id: e.id, points: e.points, strong: hot.includes(e) })),
          );
          for (const edge of hot) {
            const label = placed.get(edge.id);
            if (!label) {
              hidden.push(`${node.id}: ${edge.id} has no label`);
              continue;
            }
            const anchor = label.anchor ? { ...label.anchor, width: 0, height: 0 } : label;
            if (!onOwnLine(anchor, edge.points)) {
              hidden.push(`${node.id}: ${edge.id} label is not on its line`);
            }
            for (const box of result.nodes) {
              if (overlapsBox(box, label)) {
                hidden.push(`${node.id}: ${edge.id} label is on ${box.id}`);
              }
            }
            for (const other of hot) {
              const otherLabel = placed.get(other.id);
              if (other.id !== edge.id && otherLabel && overlapsBox(otherLabel, label)) {
                hidden.push(`${node.id}: ${edge.id} label is on the label of ${other.id}`);
              }
              if (other.id !== edge.id && crossesLine(other.points, label)) {
                hidden.push(`${node.id}: ${edge.id} label is on the line of ${other.id}`);
              }
              if (other.id !== edge.id && otherLabel?.anchor && label.anchor) {
                const tie = { x: label.anchor.x, y: label.anchor.y, width: 0, height: 0 };
                if (overlapsBox(otherLabel, { ...tie, width: 1, height: 1 })) {
                  hidden.push(
                    `${node.id}: ${edge.id} leader starts under the label of ${other.id}`,
                  );
                }
              }
            }
          }
        }
        assert.deepStrictEqual(hidden, []);
      });
    }
  }
});
