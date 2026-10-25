import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [, , outDir, fromArg, toArg, stepArg] = process.argv;
const html = resolve(import.meta.dirname, "index.html");
const fps = 30;
const from = Number(fromArg ?? 0), to = Number(toArg ?? 1200), step = Number(stepArg ?? 1);
const times = process.env.TIMES ? process.env.TIMES.split(",").map(Number) : null;
mkdirSync(outDir, { recursive: true });

const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${port}`, "--window-size=1920,1080", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--allow-file-access-from-files", "--disable-gpu-vsync",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "brag-chrome-"))}`, "--no-first-run", "--mute-audio", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => chrome.kill());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(1));

let targets;
for (let i = 0; i < 100; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.find((x) => x.type === "page")) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const ws = new WebSocket(targets.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file://" + html });
await new Promise((r) => setTimeout(r, 800));
const rd = await send("Runtime.evaluate", { expression: "window.ready", awaitPromise: true, returnByValue: true });
if (!rd.result?.result?.value) { console.error("not ready", JSON.stringify(rd)); process.exit(1); }

const list = times ?? Array.from({ length: Math.ceil((to - from) / step) }, (_, k) => (from + k * step) / fps);
let k = 0;
for (const t of list) {
  const ev = await send("Runtime.evaluate", { expression: `render(${t}); 1`, returnByValue: true });
  if (ev.result?.exceptionDetails) { console.error(t, JSON.stringify(ev.result.exceptionDetails)); process.exit(1); }
  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 95 });
  const name = times ? `t${t.toFixed(2)}.jpg` : `f${String(Math.round(t * fps)).padStart(4, "0")}.jpg`;
  writeFileSync(resolve(outDir, name), Buffer.from(shot.result.data, "base64"));
  if (++k % 100 === 0) console.log(k, "frames");
}
ws.close();
process.exit(0);
