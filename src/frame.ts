// composive frame: still frames of a project as PNG, drawn by the export renderer (/render), so a frame
// here is the frame the export writes. For an AI that edits the files and must see the result.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { serve } from "./server.ts";
import { chrome } from "./export.ts";
import { compose, layout } from "../ui/core/project.js";

// at: times in seconds (scene time with `scene`, else video time); sheet: N frames spread over the clip,
// in one image with time labels. With `out`: one time writes `out`, more write <out>-<time>s.png next to it.
// Without: <project>/preview/frames/<scene or "video">-<time>s.png, or -sheet.png.
type Opts = { scene?: string; at?: number[]; sheet?: number };
export async function frames(dir: string, out: string | undefined, { scene, at = [], sheet }: Opts) {
  const exe = chrome();
  const server = serve(dir, 0);
  const browser = await puppeteer.launch({ executablePath: exe, headless: true });
  try {
    const project = await (await fetch(`http://localhost:${server.port}/api/project`)).json();
    if (project.error) throw new Error(project.error);
    if (scene && !project.scenes?.some((s: any) => s.slug === scene))
      throw new Error(`No scene "${scene}". Scenes: ${project.scenes.map((s: any) => s.slug).join(", ") || "none"}`);
    const { tl, a, b } = compose(project, scene);
    const len = scene ? b - a : Math.max(b, ...tl.tracks.flatMap((t: any) => t.clips.map((c: any) => c.start + c.duration)));
    if (len <= 0) throw new Error("Timeline is empty.");
    const last = Math.max(0, len - 1 / tl.fps); // the last frame, not the black after the end
    const times = sheet ? Array.from({ length: sheet }, (_, i) => (sheet > 1 ? (last * i) / (sheet - 1) : 0)) : at.length ? at : [0];
    for (const t of times) if (!(t >= 0 && t <= len)) throw new Error(`Time ${t}s is outside 0..${+len.toFixed(3)}s${scene ? ` (scene ${scene})` : ""}.`);
    const L = layout(project);
    const label = (t: number) => {
      const v = (scene ? a : 0) + t, s = !scene && [...L].reverse().find((w) => v >= w.a);
      return `${t.toFixed(2)}s` + (s ? `  ${s.slug}` : "");
    };

    const page = await browser.newPage();
    // errors of the clips (also inside their iframes): the page draws on, they are listed at the end
    const problems = new Set<string>();
    page.on("pageerror", (e: any) => {
      const where = String(e?.stack ?? "").match(/\/(?:p|t)\/[^\s)]+?:\d+:\d+/)?.[0]; // the file of the clip that threw, from the stack
      problems.add((where ? `${where.slice(3)}: ` : "") + String(e?.message ?? e));
    });
    // (a failed load is listed once, by its url: its console line has none)
    const path = (u: string) => u.replace(`http://localhost:${server.port}`, "");
    page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.add(m.text()); });
    page.on("requestfailed", (r) => problems.add(`failed to load ${path(r.url())}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) problems.add(`${r.status()} ${path(r.url())}`); });
    await page.setViewport({ width: tl.width, height: tl.height });
    await page.goto(`http://localhost:${server.port}/render`);
    await page.evaluate((t) => (globalThis as any).__init(t), tl);
    const shots: Buffer[] = [];
    for (const t of times) {
      await page.evaluate((t) => (globalThis as any).__frame(t), (scene ? a : 0) + t);
      shots.push(Buffer.from(await page.screenshot({ type: "png" })));
    }

    const named = !!out;
    out ??= join(resolve(dir), "preview", "frames", `${scene ?? "video"}${sheet ? "-sheet" : ""}.png`);
    mkdirSync(dirname(out), { recursive: true });
    const written: string[] = [];
    if (sheet) {
      // a grid about 1600 px wide and about 16:10, whatever the frame shape
      const cols = Math.max(1, Math.min(sheet, Math.ceil(Math.sqrt((1.6 * sheet * tl.height) / tl.width))));
      const w = Math.floor(1600 / cols), h = Math.round((w * tl.height) / tl.width);
      await page.setViewport({ width: cols * w, height: 100 });
      await page.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${w}px);font:600 14px system-ui,sans-serif}
        figure{margin:0;position:relative}img{display:block;width:${w}px;height:${h}px;outline:1px solid #333;outline-offset:-1px}
        figcaption{position:absolute;left:4px;top:4px;padding:2px 6px;background:#000c;color:#fff;border-radius:3px}</style>` +
        shots.map((s, i) => `<figure><img src="data:image/png;base64,${s.toString("base64")}"><figcaption>${label(times[i])}</figcaption></figure>`).join(""));
      await Bun.write(out, await page.screenshot({ type: "png", fullPage: true }));
      written.push(out);
    } else if (times.length === 1 && named) {
      await Bun.write(out, shots[0]);
      written.push(out);
    } else {
      const ext = extname(out) || ".png", stem = out.slice(0, out.length - extname(out).length);
      for (const [i, t] of times.entries()) {
        const f = `${stem}-${+t.toFixed(3)}s${ext}`;
        await Bun.write(f, shots[i]);
        written.push(f);
      }
    }
    return { written, times, label: times.map(label), problems: [...problems] };
  } finally {
    // close() sometimes never returns on Windows: give it 3 s, then kill the process
    await Promise.race([browser.close(), Bun.sleep(3000)]).then(() => browser.process()?.kill());
    server.stop(true);
  }
}
