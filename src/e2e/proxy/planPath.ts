const PLAN_PATH = /\/plans\/plan-[a-zA-Z0-9._-]+\.md/;
const PLAN_PATHS = new RegExp(PLAN_PATH.source, "g");

interface SseEvent {
  readonly raw: string;
  readonly data?: {
    type?: string;
    index?: number;
    delta?: { type?: string; partial_json?: string };
  };
}

export function livePlanPath(requestBody: string): string | undefined {
  return PLAN_PATH.exec(requestBody)?.[0];
}

export function rewritePlanPath(sse: string, planPath: string): string {
  const events = parseEvents(sse);
  const deltas = new Map<number, number[]>();
  const replaced = new Map<number, string>();
  const dropped = new Set<number>();
  events.forEach((event, position) => {
    const { data } = event;
    if (data?.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
      deltas.set(data.index ?? -1, [...(deltas.get(data.index ?? -1) ?? []), position]);
      return;
    }
    if (data?.type !== "content_block_stop") {
      return;
    }
    const positions = deltas.get(data.index ?? -1) ?? [];
    deltas.delete(data.index ?? -1);
    const json = positions.map((at) => events[at].data?.delta?.partial_json ?? "").join("");
    if (positions.length === 0 || !PLAN_PATH.test(json)) {
      return;
    }
    const [first, ...rest] = positions;
    const data0 = events[first].data;
    replaced.set(
      first,
      `event: content_block_delta\ndata: ${JSON.stringify({
        ...data0,
        delta: { ...data0?.delta, partial_json: json.replace(PLAN_PATHS, planPath) },
      })}\n\n`,
    );
    for (const at of rest) {
      dropped.add(at);
    }
  });
  if (replaced.size === 0) {
    return sse;
  }
  return events
    .map((event, position) => (dropped.has(position) ? "" : (replaced.get(position) ?? event.raw)))
    .join("");
}

function parseEvents(sse: string): SseEvent[] {
  const events: SseEvent[] = [];
  const pattern = /[\s\S]*?(?:\r?\n\r?\n|$)/g;
  for (const match of sse.matchAll(pattern)) {
    const raw = match[0];
    if (raw === "") {
      break;
    }
    const line = raw.split(/\r?\n/).find((text) => text.startsWith("data: "));
    let data: SseEvent["data"];
    try {
      data = line ? (JSON.parse(line.slice(6)) as SseEvent["data"]) : undefined;
    } catch {
      data = undefined;
    }
    events.push({ raw, data });
  }
  return events;
}
