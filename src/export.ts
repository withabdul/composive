import puppeteer from "puppeteer-core";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { serve } from "./server.ts";
import { audible } from "../ui/canvas/stage.js";
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

  const args = ["-y", "-f", "image2pipe", "-framerate", String(tl.fps), "-i", "-"];
  for (const { c } of audio) args.push("-i", join(dir, c.src));
  if (audio.length) {
    const chains = audio.map(({ c, a, b }: any, i: number) => {
      const cut = a - c.start, len = b - a, ms = Math.round((a - t0) * 1000);
      // fades keep their place on the clip; the part cut away by the range is dropped
      // shortcut: a fade-in cut in the middle restarts from silence instead of from its mid level
      const fi = Math.max(0, (c.fadeIn ?? 0) - cut);
      const foStart = c.duration - (c.fadeOut ?? 0) - cut, foSt = Math.max(0, foStart), fo = (c.fadeOut ?? 0) - (foSt - foStart);
      return `[${i + 1}:a]atrim=start=${(c.offset ?? 0) + cut}:duration=${len},asetpts=PTS-STARTPTS,volume=${c.volume ?? 1}` +
        (fi ? `,afade=t=in:st=0:d=${fi}` : "") +
        (c.fadeOut && fo > 0 && foSt < len ? `,afade=t=out:st=${foSt}:d=${fo}` : "") +
        `,adelay=${ms}:all=1[a${i}]`;
    });
    const mix = audio.map((_: any, i: number) => `[a${i}]`).join("") + `amix=inputs=${audio.length}:normalize=0:duration=longest[aout]`;
    args.push("-filter_complex", [...chains, mix].join(";"), "-map", "0:v", "-map", "[aout]", "-c:a", "aac");
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
    if (!ok) { ff.kill(); await ff.exited; rmSync(out, { force: true }); } // never leave a broken half file
  }
}
