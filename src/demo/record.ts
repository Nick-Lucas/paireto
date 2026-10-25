import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { startRecording, type Recording } from "./capture.js";
import { demoConfig } from "./config.js";
import { Director } from "./director.js";
import { startEnvironment, type DemoMode } from "./environment.js";
import { CHAPTERS, preroll } from "./scenario.js";
import type { Timeline } from "./timeline.js";
import { Workbench } from "./ui.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const CAPTURE = "capture.mp4";

async function main(): Promise<void> {
  const mode = parseMode(process.argv[2]);
  const env = await startEnvironment(repoRoot, demoConfig, mode);
  const { page } = env.workbench;
  const { screen } = demoConfig;
  const d = new Director(page, demoConfig.pacing, { x: screen.width / 2, y: screen.height / 2 });
  const ui = new Workbench(page, d);
  const scenario = { ui, config: demoConfig };
  let recording: Recording | undefined;
  let succeeded = false;
  try {
    await preroll(scenario);
    recording = await startRecording(env.screen, path.join(env.outDir, CAPTURE), screen.fps);
    d.startClock(recording.startedAt);
    await d.pause(1200);
    for (const chapter of CHAPTERS) {
      console.log(`[demo] ${chapter.name}`);
      await chapter(scenario);
    }
    await d.pause(1500);
    succeeded = true;
  } catch (err) {
    await page.screenshot({ path: path.join(env.outDir, "failure.png") }).catch(() => undefined);
    const miss = env.replayMiss();
    if (miss) {
      console.error(
        `[demo] replay miss — re-record the cassette with \`pnpm demo:record\`\n${miss}`,
      );
    }
    throw err;
  } finally {
    if (recording) {
      await recording.stop();
      writeTimeline(env.outDir, d);
    }
    await env.finish(succeeded);
  }
  console.log(`[demo] wrote ${path.join(demoConfig.outputDir, "timeline.json")}`);
}

function writeTimeline(outDir: string, d: Director): void {
  const { screen } = demoConfig;
  const durationMs = Math.round(
    Number(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          path.join(outDir, CAPTURE),
        ],
        { encoding: "utf8" },
      ).trim(),
    ) * 1000,
  );
  const timeline: Timeline = {
    video: {
      file: CAPTURE,
      fps: screen.fps,
      width: screen.width * screen.scale,
      height: screen.height * screen.scale,
      scale: screen.scale,
      durationMs,
    },
    events: d.events,
  };
  fs.writeFileSync(path.join(outDir, "timeline.json"), JSON.stringify(timeline, null, 1));
}

function parseMode(value: string | undefined): DemoMode {
  if (value === "record" || value === "replay") {
    return value;
  }
  throw new Error(`usage: record.js <record|replay> (got ${value ?? "nothing"})`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
