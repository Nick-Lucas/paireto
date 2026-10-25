import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";

export interface Screen {
  readonly display: string;
  readonly width: number;
  readonly height: number;
  stop(): void;
}

export async function startScreen(display: string, width: number, height: number): Promise<Screen> {
  const socket = `/tmp/.X11-unix/X${display.replace(":", "")}`;
  fs.rmSync(socket, { force: true });
  const xvfb = spawn(
    "Xvfb",
    [display, "-ac", "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"],
    {
      stdio: "ignore",
    },
  );
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(socket)) {
    if (Date.now() > deadline || xvfb.exitCode !== null) {
      throw new Error(`Xvfb did not start on ${display}`);
    }
    await delay(50);
  }
  return { display, width, height, stop: () => xvfb.kill() };
}

export interface Recording {
  readonly startedAt: number;
  stop(): Promise<void>;
}

export async function startRecording(
  screen: Screen,
  file: string,
  fps: number,
): Promise<Recording> {
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-framerate",
      String(fps),
      "-video_size",
      `${screen.width}x${screen.height}`,
      "-i",
      `${screen.display}.0`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(fps),
      "-progress",
      "pipe:1",
      "-stats_period",
      "0.1",
      file,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const startedAt = await firstFrameClock(ffmpeg);
  return {
    startedAt,
    stop: () =>
      new Promise((resolve) => {
        ffmpeg.on("close", () => resolve());
        ffmpeg.stdin?.write("q");
        ffmpeg.stdin?.end();
      }),
  };
}

function firstFrameClock(ffmpeg: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const estimates: number[] = [];
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (!match || Number(match[1]) <= 0) {
          continue;
        }
        estimates.push(Date.now() - Number(match[1]) / 1000);
        if (estimates.length === 5) {
          ffmpeg.stdout?.off("data", onData);
          ffmpeg.stdout?.resume();
          resolve(Math.min(...estimates));
        }
      }
    };
    ffmpeg.stdout?.on("data", onData);
    ffmpeg.on("exit", (code) => reject(new Error(`ffmpeg exited early with code ${code}`)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
