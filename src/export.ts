import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "./server.ts";
import { audible, normalize } from "../ui/canvas/stage.js";

const CHROMES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export async function exportVideo(dir: string, out: string) {
  const exe = CHROMES.find((p) => p && existsSync(p));
  if (!exe) throw new Error("Chrome not found. Set CHROME_PATH.");

  const server = serve(dir, 0);
  const tl = normalize(await (await fetch(`http://localhost:${server.port}/api/timeline`)).json());
  const clips = tl.tracks.flatMap((t: any) => t.clips);
  const end = Math.max(0, ...clips.map((c: any) => c.start + c.duration));
  // in/out markers set in the editor (I / O keys); without them the whole timeline
  const t0 = Math.max(0, tl.range?.in ?? 0), t1 = Math.min(end, tl.range?.out ?? end);
  const total = t1 - t0;
  if (total <= 0) throw new Error(end ? "Export range is empty." : "Timeline is empty.");
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
  const browser = await puppeteer.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: tl.width, height: tl.height });
    await page.goto(`http://localhost:${server.port}/render`);
    await page.evaluate((t) => (globalThis as any).__init(t), tl);
    const frames = Math.round(total * tl.fps);
    for (let i = 0; i < frames; i++) {
      await page.evaluate((t) => (globalThis as any).__frame(t), t0 + i / tl.fps);
      ff.stdin.write(await page.screenshot({ type: "png" }));
      await ff.stdin.flush();
      process.stdout.write(`\rframe ${i + 1}/${frames}`);
    }
    ff.stdin.end();
    if (await ff.exited) throw new Error("\n" + (await ffErr));
    console.log(`\nwrote ${out}`);
  } finally {
    await browser.close();
    server.stop(true);
  }
}
