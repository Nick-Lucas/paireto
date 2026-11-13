export interface RoutePoint {
  x: number;
  y: number;
}

export interface RouteBox extends RoutePoint {
  width: number;
  height: number;
}

export type Side = "left" | "right" | "up" | "down";

export interface Port extends RoutePoint {
  side: Side;
}

export interface Block extends RouteBox {
  pad: number;
}

export interface RouteScene {
  blocks: readonly Block[];
  soft: readonly RouteBox[];
  frames: readonly RouteBox[];
  lines: readonly (readonly RoutePoint[])[];
}

export const ROUTE_GAP = 14;

const SIDES: readonly Side[] = ["right", "down", "left", "up"];
const STEP: Record<Side, RoutePoint> = {
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  up: { x: 0, y: -1 },
};
const BEND = 30;
const CROSS = 120;
const ALONG = 4;
const SOFT = 60;
const FRAME = 20;
const REACH = 160;
const NEAR = 2;

function keyOf(value: number): number {
  return Math.round(value * 2) / 2;
}

function boundsOf(
  points: readonly RoutePoint[],
  boxes: readonly RouteBox[],
  reach: number,
): RouteBox {
  const xs = [...points.map((p) => p.x), ...boxes.flatMap((b) => [b.x, b.x + b.width])];
  const ys = [...points.map((p) => p.y), ...boxes.flatMap((b) => [b.y, b.y + b.height])];
  const x = Math.max(0, Math.min(...xs) - reach);
  const y = Math.max(0, Math.min(...ys) - reach);
  return { x, y, width: Math.max(...xs) + reach - x, height: Math.max(...ys) + reach - y };
}

function meets(box: RouteBox, area: RouteBox, pad: number): boolean {
  return (
    box.x - pad < area.x + area.width &&
    area.x < box.x + box.width + pad &&
    box.y - pad < area.y + area.height &&
    area.y < box.y + box.height + pad
  );
}

interface Segment {
  at: number;
  from: number;
  to: number;
}

function segmentsOf(lines: RouteScene["lines"]): { across: Segment[]; down: Segment[] } {
  const across: Segment[] = [];
  const down: Segment[] = [];
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      if (Math.abs(a.y - b.y) < 0.5) {
        across.push({ at: a.y, from: Math.min(a.x, b.x), to: Math.max(a.x, b.x) });
      } else if (Math.abs(a.x - b.x) < 0.5) {
        down.push({ at: a.x, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y) });
      }
    }
  }
  return { across, down };
}

class Heap {
  private readonly keys: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, cost: number): void {
    const keys = this.keys;
    const costs = this.costs;
    let i = keys.length;
    keys.push(key);
    costs.push(cost);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (costs[parent] <= cost) {
        break;
      }
      keys[i] = keys[parent];
      costs[i] = costs[parent];
      i = parent;
    }
    keys[i] = key;
    costs[i] = cost;
  }

  pop(): number {
    const keys = this.keys;
    const costs = this.costs;
    const top = keys[0];
    const lastKey = keys.pop() as number;
    const lastCost = costs.pop() as number;
    if (keys.length > 0) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let low = i;
        let lowCost = lastCost;
        if (left < keys.length && costs[left] < lowCost) {
          low = left;
          lowCost = costs[left];
        }
        if (right < keys.length && costs[right] < lowCost) {
          low = right;
          lowCost = costs[right];
        }
        if (low === i) {
          break;
        }
        keys[i] = keys[low];
        costs[i] = costs[low];
        i = low;
      }
      keys[i] = lastKey;
      costs[i] = lastCost;
    }
    return top;
  }
}

function search(
  starts: readonly Port[],
  ends: readonly Port[],
  scene: RouteScene,
  area: RouteBox,
): RoutePoint[] | undefined {
  const blocks = scene.blocks.filter((b) => meets(b, area, b.pad));
  const soft = scene.soft.filter((b) => meets(b, area, 0));
  const frames = scene.frames.filter((b) => meets(b, area, ROUTE_GAP));
  const ports = [...starts, ...ends];
  const xSet = new Set<number>([area.x, area.x + area.width]);
  const ySet = new Set<number>([area.y, area.y + area.height]);
  for (const port of ports) {
    xSet.add(port.x);
    ySet.add(port.y);
    xSet.add(port.x + STEP[port.side].x * ROUTE_GAP);
    ySet.add(port.y + STEP[port.side].y * ROUTE_GAP);
  }
  for (const box of [...blocks, ...frames]) {
    xSet.add(box.x - ROUTE_GAP);
    xSet.add(box.x + box.width + ROUTE_GAP);
    ySet.add(box.y - ROUTE_GAP);
    ySet.add(box.y + box.height + ROUTE_GAP);
  }
  for (const frame of frames) {
    xSet.add(frame.x + ROUTE_GAP);
    xSet.add(frame.x + frame.width - ROUTE_GAP);
    ySet.add(frame.y + ROUTE_GAP);
    ySet.add(frame.y + frame.height - ROUTE_GAP);
  }
  const inside = (value: number, low: number, high: number) => value >= low && value <= high;
  const xs = [...new Set([...xSet].map(keyOf))]
    .filter((x) => inside(x, area.x, area.x + area.width))
    .sort((a, b) => a - b);
  const ys = [...new Set([...ySet].map(keyOf))]
    .filter((y) => inside(y, area.y, area.y + area.height))
    .sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  const xIndex = new Map(xs.map((x, i) => [x, i]));
  const yIndex = new Map(ys.map((y, i) => [y, i]));
  const indexOf = (point: RoutePoint): number | undefined => {
    const i = xIndex.get(keyOf(point.x));
    const j = yIndex.get(keyOf(point.y));
    return i === undefined || j === undefined ? undefined : j * nx + i;
  };
  const portPoints = new Set(ports.flatMap((p) => indexOf(p) ?? []));
  const open = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const index = j * nx + i;
      open[index] =
        portPoints.has(index) ||
        !blocks.some(
          (b) =>
            xs[i] > b.x - b.pad + 0.25 &&
            xs[i] < b.x + b.width + b.pad - 0.25 &&
            ys[j] > b.y - b.pad + 0.25 &&
            ys[j] < b.y + b.height + b.pad - 0.25,
        )
          ? 1
          : 0;
    }
  }
  const { across, down } = segmentsOf(scene.lines);
  const acrossCost = new Float64Array(nx * ny).fill(Infinity);
  const downCost = new Float64Array(nx * ny).fill(Infinity);
  for (let j = 0; j < ny; j++) {
    const y = ys[j];
    for (let i = 0; i + 1 < nx; i++) {
      const from = xs[i];
      const to = xs[i + 1];
      if (
        blocks.some(
          (b) =>
            y > b.y - b.pad + 0.25 &&
            y < b.y + b.height + b.pad - 0.25 &&
            to > b.x - b.pad + 0.25 &&
            from < b.x + b.width + b.pad - 0.25,
        )
      ) {
        continue;
      }
      let cost = to - from;
      for (const s of down) {
        if (s.at >= from && s.at < to && y > s.from && y < s.to) {
          cost += CROSS;
        }
      }
      for (const s of across) {
        if (Math.abs(s.at - y) < NEAR) {
          cost += ALONG * Math.max(0, Math.min(to, s.to) - Math.max(from, s.from));
        }
      }
      for (const b of soft) {
        if (y > b.y && y < b.y + b.height && to > b.x && from < b.x + b.width) {
          cost += SOFT;
        }
      }
      for (const f of frames) {
        if (y > f.y && y < f.y + f.height) {
          for (const edge of [f.x, f.x + f.width]) {
            if (edge >= from && edge < to) {
              cost += FRAME;
            }
          }
        }
      }
      acrossCost[j * nx + i] = cost;
    }
  }
  for (let i = 0; i < nx; i++) {
    const x = xs[i];
    for (let j = 0; j + 1 < ny; j++) {
      const from = ys[j];
      const to = ys[j + 1];
      if (
        blocks.some(
          (b) =>
            x > b.x - b.pad + 0.25 &&
            x < b.x + b.width + b.pad - 0.25 &&
            to > b.y - b.pad + 0.25 &&
            from < b.y + b.height + b.pad - 0.25,
        )
      ) {
        continue;
      }
      let cost = to - from;
      for (const s of across) {
        if (s.at >= from && s.at < to && x > s.from && x < s.to) {
          cost += CROSS;
        }
      }
      for (const s of down) {
        if (Math.abs(s.at - x) < NEAR) {
          cost += ALONG * Math.max(0, Math.min(to, s.to) - Math.max(from, s.from));
        }
      }
      for (const b of soft) {
        if (x > b.x && x < b.x + b.width && to > b.y && from < b.y + b.height) {
          cost += SOFT;
        }
      }
      for (const f of frames) {
        if (x > f.x && x < f.x + f.width) {
          for (const edge of [f.y, f.y + f.height]) {
            if (edge >= from && edge < to) {
              cost += FRAME;
            }
          }
        }
      }
      downCost[j * nx + i] = cost;
    }
  }
  const stepCost = (index: number, dir: number): [number, number] | undefined => {
    const i = index % nx;
    const j = (index - i) / nx;
    switch (SIDES[dir]) {
      case "right":
        return i + 1 < nx ? [index + 1, acrossCost[index]] : undefined;
      case "left":
        return i > 0 ? [index - 1, acrossCost[index - 1]] : undefined;
      case "down":
        return j + 1 < ny ? [index + nx, downCost[index]] : undefined;
      default:
        return j > 0 ? [index - nx, downCost[index - nx]] : undefined;
    }
  };
  const states = nx * ny * 4;
  const dist = new Float64Array(states).fill(Infinity);
  const prev = new Int32Array(states).fill(-1);
  const startPoints = new Set<number>();
  const heap = new Heap();
  for (const port of starts) {
    const index = indexOf(port);
    if (index === undefined) {
      continue;
    }
    startPoints.add(index);
    const state = index * 4 + SIDES.indexOf(port.side);
    dist[state] = 0;
    heap.push(state, 0);
  }
  const goals = new Set(
    ends.flatMap((port) => {
      const index = indexOf(port);
      return index === undefined ? [] : [index * 4 + ((SIDES.indexOf(port.side) + 2) % 4)];
    }),
  );
  let found = -1;
  while (heap.size > 0) {
    const state = heap.pop();
    if (goals.has(state)) {
      found = state;
      break;
    }
    const index = state >> 2;
    const dir = state & 3;
    for (let next = 0; next < 4; next++) {
      if (next === (dir + 2) % 4 || (next !== dir && startPoints.has(index) && prev[state] < 0)) {
        continue;
      }
      const step = stepCost(index, next);
      if (!step || !Number.isFinite(step[1]) || !open[step[0]]) {
        continue;
      }
      const cost = dist[state] + step[1] + (next === dir ? 0 : BEND);
      const target = step[0] * 4 + next;
      if (cost < dist[target]) {
        dist[target] = cost;
        prev[target] = state;
        heap.push(target, cost);
      }
    }
  }
  if (found < 0) {
    return undefined;
  }
  const path: RoutePoint[] = [];
  let lastDir = -1;
  for (let state = found; state >= 0; state = prev[state]) {
    const index = state >> 2;
    const dir = state & 3;
    const point = { x: xs[index % nx], y: ys[Math.floor(index / nx)] };
    if (path.length === 0 || prev[state] < 0 || dir !== lastDir) {
      path.push(point);
    }
    lastDir = dir;
  }
  path.reverse();
  return path;
}

export function routeLine(
  starts: readonly Port[],
  ends: readonly Port[],
  scene: RouteScene,
): RoutePoint[] | undefined {
  if (starts.length === 0 || ends.length === 0) {
    return undefined;
  }
  const ports = [...starts, ...ends];
  return (
    search(starts, ends, scene, boundsOf(ports, [], REACH)) ??
    search(starts, ends, scene, boundsOf(ports, [...scene.blocks, ...scene.frames], REACH))
  );
}
