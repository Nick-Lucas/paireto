import type { Locator, Page } from "playwright-core";

import type { Director } from "./director.js";
import { rectOf } from "./director.js";
import type { Point, Rect } from "./timeline.js";

const AGENT_READY = /plan mode on/i;
const PERMISSION_PROMPT = /do you want to (?:proceed|make this edit|create)/i;
const NBSP = /\u00a0/g;
const HOOK_ERROR = /hook error/i;

interface DomNode {
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
}

export interface Changeset {
  readonly title: RegExp;
  readonly files: readonly string[];
}

export class Workbench {
  constructor(
    readonly page: Page,
    readonly d: Director,
  ) {}

  part(name: "sidebar" | "editor" | "panel"): Locator {
    return this.page.locator(`.part.${name}`).first();
  }

  partRect(name: "sidebar" | "editor" | "panel"): Promise<Rect> {
    return rectOf(this.part(name));
  }

  async sidebarRect(minWidth = 0): Promise<Rect> {
    const sidebar = await this.partRect("sidebar");
    const rows = await this.page
      .locator(".part.sidebar .monaco-list-row")
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          (node as unknown as { getBoundingClientRect(): Rect }).getBoundingClientRect(),
        ),
      );
    const sidebarBottom = sidebar.y + sidebar.height;
    const rowBottoms = rows
      .filter((box) => box.height > 0 && box.y < sidebarBottom)
      .map((box) => box.y + box.height);
    const bottom = Math.min(sidebarBottom, Math.max(sidebar.y + 240, ...rowBottoms) + 24);
    return { x: 0, y: 0, width: Math.max(sidebar.x + sidebar.width, minWidth), height: bottom };
  }

  async headerRect(): Promise<Rect> {
    const editor = await this.partRect("editor");
    return { x: editor.x + editor.width - 520, y: editor.y, width: 520, height: 160 };
  }

  async promptRect(): Promise<Rect> {
    const panel = await this.partRect("panel");
    return {
      x: panel.x,
      y: panel.y + panel.height - 220,
      width: Math.min(panel.width, 1000),
      height: 220,
    };
  }

  async changedRegion(): Promise<Rect> {
    const editor = await this.partRect("editor");
    const inserts = await this.page
      .locator(".part.editor .editor.modified .view-overlays .line-insert")
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          (node as unknown as { getBoundingClientRect(): Rect }).getBoundingClientRect(),
        ),
      );
    const visible = inserts.filter((box) => box.y >= editor.y && box.y <= editor.y + editor.height);
    if (visible.length === 0) {
      return editor;
    }
    const top = Math.min(...visible.map((box) => box.y));
    const bottom = Math.max(...visible.map((box) => box.y + box.height));
    return {
      x: editor.x,
      y: top - 40,
      width: editor.width,
      height: Math.max(220, bottom - top + 80),
    };
  }

  private async rowInfo(): Promise<{ text: string; aria: string }[]> {
    return this.page.locator(".part.sidebar .monaco-list-row").evaluateAll((nodes) =>
      nodes.map((node) => {
        const row = node as unknown as DomNode;
        return { text: (row.textContent ?? "").trim(), aria: row.getAttribute("aria-label") ?? "" };
      }),
    );
  }

  async rows(): Promise<string[]> {
    return (await this.rowInfo()).map((row) => row.aria);
  }

  row(label: RegExp): Locator {
    return this.page.locator(".part.sidebar .monaco-list-row").filter({ hasText: label }).first();
  }

  agentRow(): Locator {
    return this.page.locator('.part.sidebar .monaco-list-row[aria-label*="\\A Session "]').first();
  }

  fileRow(path: string): Locator {
    return this.page.locator(`.part.sidebar .monaco-list-row[aria-label^="${path}\\A "]`).first();
  }

  checkbox(row: Locator): Locator {
    return row
      .locator(".custom-view-tree-node-item-checkbox, .monaco-checkbox, input[type=checkbox]")
      .first();
  }

  async rowAction(row: Locator, action: RegExp): Promise<Locator> {
    await this.d.hover(row);
    return row.getByRole("button", { name: action }).first();
  }

  viewAction(action: RegExp): Locator {
    return this.page
      .locator(".part.sidebar .title-actions")
      .getByRole("button", { name: action })
      .first();
  }

  editorAction(action: RegExp): Locator {
    return this.page
      .locator(".part.editor .editor-actions")
      .getByRole("button", { name: action })
      .first();
  }

  tab(title: RegExp): Locator {
    return this.page
      .locator(".part.editor .tabs-container .tab")
      .filter({ hasText: title })
      .first();
  }

  async agentState(): Promise<string> {
    const agent = (await this.rows()).find((row) => row.includes("\nSession ")) ?? "";
    return agent.split("\n").at(-1) ?? "";
  }

  async changesets(): Promise<Changeset[]> {
    const rows = await this.rowInfo();
    const out: { title: string; files: string[] }[] = [];
    for (const row of rows) {
      if (/^(Feedback|Other changes)/.test(row.text)) {
        break;
      }
      const isChangeset =
        /\d+ files?$/.test(row.text) &&
        !row.aria.includes("\n") &&
        !row.text.startsWith("Review Plan");
      if (isChangeset) {
        out.push({
          title: row.aria.replace(/,\s*has actions$/, "").replace(/\s+\d+ files?$/, ""),
          files: [],
        });
      } else if (out.length > 0 && row.aria.includes("\n")) {
        out[out.length - 1].files.push(row.aria.split("\n")[0]);
      }
    }
    return out.map((changeset) => ({
      title: new RegExp(`^${escape(changeset.title)}`),
      files: changeset.files,
    }));
  }

  async terminalText(): Promise<string> {
    const lines = await this.page
      .locator(".part.panel .xterm-rows > div")
      .evaluateAll((nodes) => nodes.map((node) => (node as unknown as DomNode).textContent ?? ""));
    return lines.join("\n").replace(NBSP, " ");
  }

  terminal(): Locator {
    return this.page.locator(".part.panel .terminal-wrapper").first();
  }

  async until(
    desc: string,
    check: () => Promise<boolean>,
    timeoutMs = 120_000,
    intervalMs = 250,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check().catch(() => false)) {
        return;
      }
      await this.page.waitForTimeout(intervalMs);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${desc}`);
  }

  async waitForAgent(done: () => Promise<boolean>, timeoutMs = 600_000): Promise<void> {
    let reported = false;
    await this.until(
      "the agent",
      async () => {
        await this.answerPermissionPrompts();
        if (!reported && HOOK_ERROR.test(await this.terminalText())) {
          reported = true;
          console.warn(`[demo] the agent reported a hook error:\n${await this.terminalText()}`);
        }
        return done();
      },
      timeoutMs,
    );
  }

  watchAgentState(match: (state: string) => boolean): Promise<void> {
    return this.until("the agent state", async () => match(await this.agentState()), 600_000, 50);
  }

  async quickPickItem(label: RegExp): Promise<Locator> {
    const rows = this.page.locator(".quick-input-widget .monaco-list-row");
    await rows.first().waitFor();
    const labels = await rows.evaluateAll((nodes) =>
      nodes.map((node) => (node as unknown as DomNode).getAttribute("aria-label") ?? ""),
    );
    const index = labels.findIndex((text) => label.test(text));
    if (index < 0) {
      throw new Error(`no quick pick item matches ${label} in ${JSON.stringify(labels)}`);
    }
    return rows.nth(index);
  }

  activeEditor(): Locator {
    return this.page
      .locator(".part.editor .editor-group-container.active .editor-instance")
      .first();
  }

  modifiedEditor(): Locator {
    return this.page
      .locator(".part.editor .editor-group-container.active")
      .locator(
        ".monaco-diff-editor .editor.modified, .monaco-editor:not(.original-in-monaco-diff-editor)",
      )
      .last();
  }

  line(editor: Locator, text: RegExp): Locator {
    const spaced = new RegExp(text.source.replace(/ |\\s/g, "[\\s\\u00a0]"), text.flags);
    return editor.locator(".view-lines .view-line").filter({ hasText: spaced }).first();
  }

  async text(locator: Locator): Promise<string> {
    return (await locator.innerText()).replace(NBSP, " ");
  }

  token(line: Locator, text: string): Locator {
    return line
      .locator("span > span")
      .filter({ hasText: new RegExp(`^${escape(text)}$`) })
      .first();
  }

  async firstToken(line: Locator, candidates: readonly string[]): Promise<Locator> {
    for (const candidate of candidates) {
      const token = this.token(line, candidate);
      if ((await token.count()) > 0) {
        return token;
      }
    }
    throw new Error(`none of ${candidates.join(", ")} is on the line`);
  }

  async awayFrom(line: Locator): Promise<Point> {
    const box = await rectOf(line);
    return { x: Math.round(box.x + box.width * 0.75), y: Math.round(box.y + 110) };
  }

  async scrollTo(editor: Locator, text: RegExp, position = 0.4): Promise<Locator> {
    const line = this.line(editor, text);
    const area = await rectOf(editor);
    await this.d.moveTo({ x: area.x + area.width * 0.55, y: area.y + area.height * 0.5 });
    const target = area.y + area.height * position;
    let direction = 1;
    let flips = 0;
    for (let step = 0; step < 150; step += 1) {
      const box = (await line.count()) > 0 ? await line.boundingBox() : null;
      if (box && Math.abs(box.y - target) < 40) {
        return line;
      }
      const before = await this.scrollPosition(editor);
      const delta = box
        ? Math.sign(box.y - target) * Math.min(160, Math.abs(box.y - target))
        : direction * 160;
      await this.page.mouse.wheel(0, delta);
      await this.page.waitForTimeout(60);
      if ((await this.scrollPosition(editor)) === before) {
        if (box) {
          return line;
        }
        direction = -direction;
        flips += 1;
        if (flips > 1) {
          break;
        }
      }
    }
    throw new Error(`could not scroll to a line matching ${text}`);
  }

  private async scrollPosition(editor: Locator): Promise<string> {
    const slider = editor.locator(".scrollbar.vertical .slider").first();
    return (await slider.getAttribute("style").catch(() => null)) ?? "";
  }

  async commentGutter(editor: Locator, line: Rect): Promise<Point> {
    const margin = await rectOf(editor.locator(".margin").first());
    const y = Math.round(line.y + Math.min(line.height, 22) / 2);
    const x = Math.round(margin.x + margin.width - 6);
    await this.d.moveTo({ x, y });
    await this.page.waitForTimeout(250);
    const glyph = await editor.locator(".comment-range-glyph.line-hover").first().boundingBox();
    return glyph ? { x: Math.round(glyph.x + glyph.width / 2), y } : { x, y };
  }

  async resizePanel(height: number): Promise<void> {
    const panel = await this.partRect("panel");
    const x = panel.x + panel.width / 2;
    const target = panel.y + panel.height - height;
    await this.page.mouse.move(x, panel.y - 1);
    await this.page.mouse.down();
    await this.page.mouse.move(x, target, { steps: 10 });
    await this.page.mouse.up();
  }

  async startAgent(): Promise<void> {
    await this.page.keyboard.press("Control+Backquote");
    await this.until(
      "the shell prompt",
      async () => /\$\s*$/m.test(await this.terminalText()),
      60_000,
    );
    await this.page.waitForTimeout(500);
    await this.page.keyboard.type("claude");
    await this.page.keyboard.press("Enter");
    await this.until(
      "the agent to start",
      async () => AGENT_READY.test(await this.terminalText()),
      60_000,
    );
    await this.page.keyboard.press("Control+l");
  }

  async answerPermissionPrompts(): Promise<boolean> {
    const text = await this.terminalText();
    if (!PERMISSION_PROMPT.test(text)) {
      return false;
    }
    console.warn(`[demo] answered a manual permission prompt:\n${text}`);
    await this.page.keyboard.press("1");
    await this.page.waitForTimeout(1500);
    return true;
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
