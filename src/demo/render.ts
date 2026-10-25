import * as fs from "node:fs";
import * as path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

import { demoConfig } from "./config.js";
import type { Music } from "./style.js";
import type { Timeline } from "./timeline.js";

const repoRoot = path.resolve(__dirname, "..", "..");

async function main(): Promise<void> {
  const outDir = path.join(repoRoot, demoConfig.outputDir);
  const timelineFile = path.join(outDir, process.argv[2] ?? "timeline.json");
  const timeline = JSON.parse(fs.readFileSync(timelineFile, "utf8")) as Timeline;
  fs.copyFileSync(
    path.join(repoRoot, "media", demoConfig.video.logo),
    path.join(outDir, demoConfig.video.logo),
  );
  const style = { ...demoConfig.video, music: publishMusic(outDir) };

  console.log("[demo] bundling the composition");
  const serveUrl = await bundle({
    entryPoint: path.join(repoRoot, "src", "demo", "video", "index.ts"),
    publicDir: outDir,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
      },
    }),
  });
  const inputProps = { timeline, style };
  const composition = await selectComposition({ serveUrl, id: "PairetoDemo", inputProps });
  const outputLocation = path.join(outDir, demoConfig.outputFile);
  console.log(
    `[demo] rendering ${composition.durationInFrames} frames (${(composition.durationInFrames / composition.fps).toFixed(1)}s)`,
  );
  let lastReported = -1;
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: "h264",
    crf: 16,
    x264Preset: "slow",
    outputLocation,
    concurrency: process.env.PAIRETO_DEMO_CONCURRENCY ?? "75%",
    chromiumOptions: { gl: "swangle" },
    onProgress: ({ progress }) => {
      const percent = Math.floor(progress * 10) * 10;
      if (percent !== lastReported) {
        lastReported = percent;
        console.log(`[demo] ${percent}%`);
      }
    },
  });
  console.log(`[demo] wrote ${path.relative(repoRoot, outputLocation)}`);
}

function publishMusic(outDir: string): Music | undefined {
  const { music } = demoConfig.video;
  const source = path.join(repoRoot, music.file);
  if (!fs.existsSync(source)) {
    console.warn(`[demo] no music: ${music.file} does not exist, so the video has no audio`);
    return undefined;
  }
  const file = path.basename(source);
  fs.copyFileSync(source, path.join(outDir, file));
  return { ...music, file };
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
