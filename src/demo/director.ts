import type { Locator, Page } from "playwright-core";

import type { DemoConfig } from "./config.js";
import { easeInOutCubic } from "./edit.js";
import type { Point, Rect, TimelineEvent } from "./timeline.js";

export type Target = Locator | Point;

type Pacing = DemoConfig["pacing"];

const STEP_MS = 1000 / 60;

export class Director {
  readonly events: TimelineEvent[] = [];
  private origin: number | undefined;
  private cursor: Point;

  constructor(
    readonly page: Page,
    private readonly pacing: Pacing,
    start: Point,
  ) {
    this.cursor = start;
  }

  pacingOf(key: keyof Pacing): number {
    return this.pacing[key];
  }

  startClock(origin: number): void {
    this.origin = origin;
    this.events.push({
      kind: "move",
      start: this.now(),
      end: this.now(),
      from: this.cursor,
      to: this.cursor,
    });
  }

  now(): number {
    return this.origin === undefined ? 0 : Date.now() - this.origin;
  }

  private log(event: TimelineEvent): void {
    if (this.origin !== undefined) {
      this.events.push(event);
    }
  }

  chapter(title: string): void {
    this.log({ kind: "chapter", at: this.now(), title });
  }

  keys(label: string): void {
    this.log({ kind: "keys", at: this.now(), label });
  }

  async pause(ms = this.pacing.settleMs): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async read(ms = this.pacing.readMs): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async span<T>(kind: "fastForward" | "cut" | "wide", work: () => Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await work();
    } finally {
      this.log({ kind, start, end: this.now() });
    }
  }

  async optional(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      console.warn(
        `[demo] skipped ${name}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
      await this.page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  fastForward<T>(work: () => Promise<T>): Promise<T> {
    return this.span("fastForward", work);
  }

  cut<T>(work: () => Promise<T>): Promise<T> {
    return this.span("cut", work);
  }

  wide<T>(work: () => Promise<T>): Promise<T> {
    return this.span("wide", work);
  }

  async focus<T>(area: Rect | Locator, work: () => Promise<T>, zoom?: number): Promise<T> {
    const rect = isRect(area) ? area : await rectOf(area);
    const start = this.now();
    try {
      return await work();
    } finally {
      this.log({ kind: "focus", start, end: this.now(), rect, zoom });
    }
  }

  async moveTo(target: Target): Promise<Point> {
    const to = await pointOf(target);
    const from = this.cursor;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < 1) {
      return to;
    }
    const duration = Math.min(
      this.pacing.maxMouseMs,
      Math.max(this.pacing.minMouseMs, (distance / this.pacing.mousePixelsPerSecond) * 1000),
    );
    const start = this.now();
    const began = Date.now();
    for (;;) {
      const progress = Math.min(1, (Date.now() - began) / duration);
      const eased = easeInOutCubic(progress);
      await this.page.mouse.move(
        from.x + (to.x - from.x) * eased,
        from.y + (to.y - from.y) * eased,
      );
      if (progress >= 1) {
        break;
      }
      await this.page.waitForTimeout(STEP_MS);
    }
    this.cursor = to;
    this.log({ kind: "move", start, end: start + duration, from, to });
    return to;
  }

  async hover(target: Target): Promise<void> {
    await this.moveTo(target);
    await this.pause(this.pacing.settleMs);
  }

  async click(
    target: Target,
    options: { count?: number; button?: "left" | "right" } = {},
  ): Promise<void> {
    const point = await this.moveTo(target);
    await this.page.waitForTimeout(120);
    const count = options.count ?? 1;
    this.log({ kind: "click", at: this.now(), point, count });
    await this.page.mouse.click(point.x, point.y, { clickCount: count, button: options.button });
    await this.pause();
  }

  async type(text: string, charsPerSecond = this.pacing.typingCharsPerSecond): Promise<void> {
    await this.page.keyboard.type(text, { delay: 1000 / charsPerSecond });
  }

  async press(key: string, label?: string): Promise<void> {
    if (label) {
      this.keys(label);
    }
    await this.page.keyboard.press(key);
  }
}

function isRect(value: Rect | Locator): value is Rect {
  return typeof (value as Rect).width === "number";
}

export async function rectOf(locator: Locator): Promise<Rect> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const visible = await locator
      .waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) })
      .then(() => true)
      .catch(() => false);
    const box = visible ? await locator.boundingBox({ timeout: 1000 }).catch(() => null) : null;
    if (box) {
      return box;
    }
  }
  throw new Error(`no bounding box for ${String(locator)}`);
}

async function pointOf(target: Target): Promise<Point> {
  if ("x" in target && typeof target.x === "number") {
    return target;
  }
  const box = await rectOf(target as Locator);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}
