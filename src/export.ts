import puppeteer from "puppeteer-core";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./server.ts";
import { audible, envelope, gainAt } from "../ui/canvas/stage.js";

// ffmpeg volume filters for gain points P (video time) over a..b of a clip; t = 0 at a after atrim.
// A fixed gain is one number; else straight lines between the points, evaluated per 256 samples (~5 ms).
// ffmpeg cannot parse a long expression, so each volume filter holds at most 16 lines and is 1 outside
// them: the chain multiplies to the whole curve.
export function gainFilter(P: { t: number; v: number }[], a: number, b: number) {
  const r = (x: number) => +x.toFixed(6);
  const Q = [{ t: a, v: gainAt(P, a) }, ...P.filter((p) => p.t > a && p.t < b), { t: b, v: gainAt(P, b) }];
  if (Q.every((p) => Math.abs(p.v - Q[0].v) < 1e-6)) return `volume=${r(Q[0].v)}`;
  const segs: { from: number; to: number; term: string }[] = [];
  for (let i = 1; i < Q.length; i++) {
    const p = Q[i - 1], q = Q[i], x = r(p.t - a), y = r(q.t - a);
    if (y - x < 1e-6) continue;
    const k = r((q.v - p.v) / (q.t - p.t));
    segs.push({ from: x, to: y, term: `gte(t,${x})*lt(t,${y})*(${r(p.v)}${k ? `+${k}*(t-${x})` : ""})` });
  }
  const end = r(b - a), filters = [];
  for (let i = 0; i < segs.length; i += 16) {
    const part = segs.slice(i, i + 16), last = i + 16 >= segs.length;
    const from = part[0].from, to = part.at(-1)!.to;
    const terms = [...part.map((s) => s.term), last ? `gte(t,${end})*${r(Q.at(-1)!.v)}` : `gte(t,${to})`];
    if (from > 0) terms.push(`lt(t,${from})`); // 1 before this part
    filters.push(`volume='${terms.join("+").replaceAll("+-", "-")}':eval=frame`);
  }
  return ["asetnsamples=n=256:p=0", ...filters].join(",");
}
import { compose } from "../ui/core/project.js";

const CHROMES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
export function chrome() {
  const exe = CHROMES.find((p) => p && existsSync(p));
  if (!exe) throw new Error("Chrome not found. Set CHROME_PATH.");
  return exe;
}
// Chrome processes that render frames at the same time: more = faster, but more CPU and RAM
export const PERF = { low: 1, normal: 4, fast: 8 } as const;
export type Perf = keyof typeof PERF;

// scene: one scene folder (e.g. "001-hook") with the global tracks under it; else the whole video.
// From the editor: port = its running server (no second one), onFrame = progress, signal = cancel
// (the half-written file is then deleted).
type Opts = { port?: number; onFrame?: (i: number, n: number) => void; signal?: AbortSignal; perf?: Perf };
export async function exportVideo(dir: string, out: string, scene?: string, { port, onFrame, signal, perf = "normal" }: Opts = {}) {
  const PAGES = PERF[perf];
  const exe = chrome();

  const server = port ? { port, stop() {} } : serve(dir, 0);
  const project = await (await fetch(`http://localhost:${server.port}/api/project`)).json();
  if (scene && !project.scenes?.some((s: any) => s.slug === scene)) {
    server.stop(true);
    throw new Error(`No scene "${scene}". Scenes: ${project.scenes.map((s: any) => s.slug).join(", ") || "none"}`);
  }
  const { tl, a, b } = compose(project, scene);
  const clips = tl.tracks.flatMap((t: any) => t.clips);
  const end = scene ? b : Math.max(0, ...clips.map((c: any) => c.start + c.duration));
  // a scene: its own time window; else the in/out markers set in the editor (I / O keys), or the whole timeline
  const t0 = scene ? a : Math.max(0, tl.range?.in ?? 0), t1 = scene ? b : Math.min(end, tl.range?.out ?? end);
  const total = t1 - t0;
  if (total <= 0) { server.stop(true); throw new Error(end ? "Export range is empty." : "Timeline is empty."); }
  // audio clips cut to the range: a = first, b = last second of the clip that is inside it
  // clips on audio tracks, by mute and solo; a src may be a video file (its sound stream is used)
  const audio = audible(tl)
    .map((c: any) => ({ c, a: Math.max(c.start, t0), b: Math.min(c.start + c.duration, t1) }))
    .filter((x: any) => x.b > x.a);

  let graphFile = "";
  const args = ["-y", "-f", "image2pipe", "-framerate", String(tl.fps), "-i", "-"];
  for (const { c } of audio) args.push("-i", join(dir, c.src));
  if (audio.length) {
    const chains = audio.map(({ c, a, b }: any, i: number) => {
      const cut = a - c.start, len = b - a, ms = Math.round((a - t0) * 1000);
      // volume, keyframes, fades and ducking: the points the preview uses too (stage.js envelope)
      return `[${i + 1}:a]atrim=start=${(c.offset ?? 0) + cut}:duration=${len},asetpts=PTS-STARTPTS,${gainFilter(envelope(tl, c), a, b)}` +
        `,adelay=${ms}:all=1[a${i}]`;
    });
    const mix = audio.map((_: any, i: number) => `[a${i}]`).join("") + `amix=inputs=${audio.length}:normalize=0:duration=longest[aout]`;
    const graph = [...chains, mix].join(";");
    // a long graph (many gain points) goes in a file: a Windows command line holds about 32 000 characters
    if (graph.length > 8000) {
      graphFile = join(tmpdir(), `composive-graph-${process.pid}-${Date.now()}.txt`);
      writeFileSync(graphFile, graph);
      args.push("-/filter_complex", graphFile); // ffmpeg 7+
    } else args.push("-filter_complex", graph);
    args.push("-map", "0:v", "-map", "[aout]", "-c:a", "aac");
  } else args.push("-an");
  args.push("-t", String(total), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(tl.fps), out);

  const ff = Bun.spawn(["ffmpeg", ...args], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const ffErr = new Response(ff.stderr).text();
  let ok = false;
  const browsers: Awaited<ReturnType<typeof puppeteer.launch>>[] = [];
  try {
    // one Chrome per worker: in one Chrome only the front tab runs requestAnimationFrame, so others hang
    // each worker renders every PAGES-th frame; one round = PAGES frames, written in order
    const pages = await Promise.all(Array.from({ length: PAGES }, async () => {
      const b = await puppeteer.launch({ executablePath: exe, headless: true });
      browsers.push(b);
      const page = await b.newPage();
      await page.setViewport({ width: tl.width, height: tl.height });
      await page.goto(`http://localhost:${server.port}/render`);
      await page.evaluate((t) => (globalThis as any).__init(t), tl);
      return page;
    }));
    const frames = Math.round(total * tl.fps);
    for (let i = 0; i < frames; i += PAGES) {
      if (signal?.aborted) throw new Error("Export cancelled.");
      const shots = await Promise.all(pages.slice(0, frames - i).map(async (page, k) => {
        await page.evaluate((t) => (globalThis as any).__frame(t), t0 + (i + k) / tl.fps);
        return page.screenshot({ type: "png", optimizeForSpeed: true });
      }));
      for (const s of shots) ff.stdin.write(s);
      await ff.stdin.flush();
      const done = i + shots.length;
      if (onFrame) onFrame(done, frames);
      else process.stdout.write(`\rframe ${done}/${frames}`);
    }
    ff.stdin.end();
    if (await ff.exited) throw new Error("\n" + (await ffErr));
    ok = true;
    console.log(`\nwrote ${out}`);
  } finally {
    // close() sometimes never returns on Windows: give it 3 s, then kill the process
    await Promise.all(browsers.map((b) => Promise.race([b.close(), Bun.sleep(3000)]).then(() => b.process()?.kill())));
    server.stop(true);
    if (graphFile) rmSync(graphFile, { force: true });
    if (!ok) { ff.kill(); await ff.exited; rmSync(out, { force: true }); } // never leave a broken half file
  }
}
