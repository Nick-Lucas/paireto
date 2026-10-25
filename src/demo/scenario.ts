import type { Locator } from "playwright-core";

import type { DemoConfig } from "./config.js";
import { rectOf } from "./director.js";
import type { Rect } from "./timeline.js";
import type { Workbench } from "./ui.js";

export interface Scenario {
  readonly ui: Workbench;
  readonly config: DemoConfig;
}

export const CHAPTERS = [planning, development, viewModes, guidedReview] as const;

export async function preroll({ ui, config }: Scenario): Promise<void> {
  const { page } = ui;
  await page.locator('.activitybar a[aria-label^="Paireto"]').click();
  await ui.row(/^Agents/).waitFor({ timeout: 60_000 });
  await ui
    .tab(/Welcome to Paireto/)
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await ui.until("the editors to close", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.press("w");
    await page.waitForTimeout(500);
    return (await page.locator(".part.editor .tabs-container .tab").count()) === 0;
  });
  await runCommand(ui, "Toggle Do Not Disturb Mode");
  await ui.startAgent();
  await ui.resizePanel(config.terminalHeight);
  await page.mouse.move(800, 450);
  await page.waitForTimeout(1200);
}

async function planning({ ui, config }: Scenario): Promise<void> {
  const { d } = ui;
  d.chapter(config.chapters.planning);
  await promptAgent(ui, config.planning.prompt);
  await watchAgentUntil(ui, async () => (await ui.tab(/^PLAN:/).count()) > 0);
  await d.pause(900);

  const editor = ui.activeEditor();
  await d.focus(await ui.partRect("editor"), () => d.read(1400), 1.2);
  const line = await ui.scrollTo(editor, config.planning.comment.anchor, 0.3);
  await d.focus(await around(line, 70, 260), async () => {
    await d.read(900);
    await commentOn(ui, editor, line, config.planning.comment.text);
  });
  await d.focus(
    await ui.headerRect(),
    async () => {
      await d.click(ui.editorAction(/Send Feedback/));
    },
    1.6,
  );

  const editorArea = await ui.partRect("editor");
  await d.moveTo({
    x: editorArea.x + editorArea.width * 0.6,
    y: editorArea.y + editorArea.height * 0.6,
  });
  await d.focus(editorArea, () =>
    d.fastForward(() => ui.waitForAgent(async () => (await ui.tab(/\(revised\)/).count()) > 0)),
  );
  await d.pause(700);
  await d.optional("the revised plan close-up", async () => {
    await d.focus(await ui.changedRegion(), () => d.read(3200), 1.3);
  });
  await d.focus(
    await ui.headerRect(),
    async () => {
      await d.click(ui.editorAction(/Approve/));
    },
    1.6,
  );
}

async function development({ ui, config }: Scenario): Promise<void> {
  const { d } = ui;
  const { development: step } = config;
  d.chapter(config.chapters.development);
  await focusAgent(ui);
  await watchAgentUntil(ui, "Awaiting code review");
  await d.pause(800);
  await d.focus(
    await ui.partRect("sidebar"),
    async () => {
      await d.read(1300);
      await d.click(ui.fileRow(step.files.rules));
    },
    1.5,
  );

  const rules = ui.activeEditor();
  await d.optional("the type hover", async () => {
    const signature = await ui.scrollTo(rules, step.hover.line, 0.45);
    const symbol = await ui.firstToken(signature, step.hover.symbols);
    await d.focus(await around(signature, 120, 160), async () => {
      await d.hover(symbol);
      await d.read(2400);
      await d.moveTo(await ui.awayFrom(signature));
      await d.pause(300);
    });
  });

  const constant = await ui.scrollTo(rules, step.edit.find, 0.35);
  const current = step.edit.find.exec(await ui.text(constant))?.[1];
  await d.focus(await around(constant, 60, 240), async () => {
    if (current) {
      await d.click(ui.token(constant, current), { count: 2 });
      await d.type(step.edit.replaceWith);
      await d.pause(400);
      await d.press("Control+s", "Ctrl+S");
      await d.pause(700);
    }
    await commentOn(ui, rules, constant, step.comment.text);
  });

  await d.focus(
    await ui.partRect("sidebar"),
    async () => {
      await d.click(ui.fileRow(step.files.wiring));
    },
    1.5,
  );
  await d.optional("the peek definition", async () => {
    const wiring = ui.modifiedEditor();
    const call = await ui.scrollTo(wiring, step.peek.line, 0.35);
    await d.focus(await around(call, 60, 360), async () => {
      await d.click(ui.token(call, step.peek.symbol));
      await d.press("Control+Shift+F10", "Peek Definition");
      await d.read(2800);
      await d.press("Escape");
      await d.pause(400);
    });
  });

  const resumed = ui.watchAgentState((state) => !state.includes("Awaiting"));
  await d.focus(
    await ui.partRect("sidebar"),
    async () => {
      await d.click(await ui.rowAction(ui.fileRow(step.files.rules), /^Stage Changes/));
      await d.read(900);
      await d.click(ui.viewAction(/Send Feedback/));
    },
    1.5,
  );
  await resumed;
  await focusAgent(ui);
  await watchAgentUntil(ui, "Awaiting code review");
  await d.read(1500);
  await d.focus(
    await ui.partRect("sidebar"),
    async () => {
      await d.read(900);
      await d.click(ui.viewAction(/Approve/));
    },
    1.5,
  );
  await ui.waitForAgent(async () => !(await ui.agentState()).includes("Awaiting"));
}

async function viewModes({ ui, config }: Scenario): Promise<void> {
  const { d } = ui;
  const { viewModes: step } = config;
  d.chapter(config.chapters.viewModes);
  const section = ui.row(/^Changed Files/);
  const area = widen(await ui.partRect("sidebar"), 760, 420);
  await d.focus(
    area,
    async () => {
      await d.click(await ui.rowAction(section, /View Modes/));
      for (const mode of step.modes) {
        await d.click(await ui.quickPickItem(mode));
        await d.read(1100);
      }
      await d.press("Escape");
      await d.pause(500);
      await d.optional("marking files seen", async () => {
        for (const file of step.markSeen) {
          await d.click(ui.checkbox(ui.fileRow(file)));
          await d.pause(500);
        }
      });
      await d.read(900);
      await d.click(await ui.rowAction(section, /View Modes/));
      for (const mode of step.restore) {
        await d.click(await ui.quickPickItem(mode));
        await d.pause(500);
      }
      await d.press("Escape");
      await d.pause(400);
      await d.click(await ui.rowAction(section, /Compare To/));
      await d.read(900);
      await d.click(await ui.quickPickItem(step.compareTo));
      await d.read(1800);
    },
    1.35,
  );
  await d.focus(
    await ui.partRect("sidebar"),
    async () => {
      await d.click(ui.fileRow(step.openFile));
    },
    1.4,
  );
  await d.focus(await ui.partRect("editor"), () => d.read(2400), 1.15);
}

async function guidedReview({ ui, config }: Scenario): Promise<void> {
  const { d } = ui;
  d.chapter(config.chapters.guidedReview);
  await focusAgent(ui);
  await promptAgent(ui, config.guidedReview.invocation);
  await watchAgentUntil(ui, "Awaiting guided review");
  await d.pause(800);
  await d.focus(
    await ui.partRect("sidebar"),
    async () => {
      await d.read(1500);
      await d.click(ui.row(/^Review Plan/));
    },
    1.4,
  );
  await d.focus(await ui.partRect("editor"), () => d.read(2600), 1.2);

  const changesets = await ui.changesets();
  for (const changeset of changesets.slice(0, config.guidedReview.changesets)) {
    await d.focus(
      await ui.partRect("sidebar"),
      async () => {
        await d.click(ui.row(changeset.title));
      },
      1.4,
    );
    await d.focus(await ui.partRect("editor"), () => d.read(2200), 1.2);
    await d.focus(
      await ui.partRect("sidebar"),
      async () => {
        await d.click(ui.fileRow(changeset.files[0]));
      },
      1.4,
    );
    await d.focus(await ui.partRect("editor"), () => d.read(1800), 1.05);
    await d.focus(
      await ui.partRect("sidebar"),
      async () => {
        await d.click(await ui.rowAction(ui.row(changeset.title), /Stage All/));
        await d.read(900);
      },
      1.4,
    );
  }
  await d.focus(
    await ui.partRect("sidebar"),
    async () => {
      await d.click(ui.viewAction(/Approve/));
      await d.read(1500);
    },
    1.4,
  );
}

async function watchAgentUntil(
  ui: Workbench,
  state: string | (() => Promise<boolean>),
): Promise<void> {
  const { d } = ui;
  const reached =
    typeof state === "string"
      ? async (): Promise<boolean> => (await ui.agentState()).includes(state)
      : state;
  if (await reached()) {
    return;
  }
  const wait = (): Promise<void> => d.fastForward(() => ui.waitForAgent(reached));
  const panel = await ui.part("panel").boundingBox();
  if (panel) {
    await d.focus(panel, wait);
  } else {
    await wait();
  }
}

async function focusAgent(ui: Workbench): Promise<void> {
  const { d } = ui;
  await d.focus(
    await ui.partRect("sidebar"),
    async () => {
      await d.click(await ui.rowAction(ui.agentRow(), /Focus Agent/));
    },
    1.5,
  );
  await d.pause(500);
}

async function promptAgent(ui: Workbench, text: string): Promise<void> {
  const { d } = ui;
  await d.focus(await ui.promptRect(), async () => {
    await d.click(ui.terminal());
    await d.type(text, d.pacingOf("terminalTypingCharsPerSecond"));
    await d.pause(500);
    await d.press("Enter");
    await d.pause(800);
  });
}

async function commentOn(
  ui: Workbench,
  editor: Locator,
  line: Locator,
  text: string,
): Promise<void> {
  const { d, page } = ui;
  const gutter = await ui.commentGutter(editor, await rectOf(line));
  await d.click(gutter);
  await page.locator(".review-widget .monaco-editor, .review-widget textarea").first().waitFor();
  await d.type(text);
  await d.pause(400);
  await d.click(
    page
      .locator(".review-widget .monaco-button")
      .filter({ hasText: /^Comment$/ })
      .first(),
  );
  await d.read(1100);
}

async function runCommand(ui: Workbench, command: string): Promise<void> {
  const { page } = ui;
  await page.keyboard.press("F1");
  await page.keyboard.type(command);
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
}

async function around(line: Locator, above: number, below: number): Promise<Rect> {
  const box = await rectOf(line);
  const x = Math.max(0, box.x - 90);
  return { x, y: box.y - above, width: Math.min(box.width + 90, 1050), height: above + below };
}

function widen(rect: Rect, width: number, height: number): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(rect.width, width),
    height: Math.min(rect.height, height),
  };
}
