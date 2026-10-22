import { watch, readdirSync, existsSync, rmSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve, basename, dirname, sep } from "node:path";
import { MEDIA } from "../ui/canvas/stage.js";
import { SCENE } from "../ui/core/project.js";
import { mediaDest } from "./import.ts";

const UI = resolve(import.meta.dir, "..", "ui");
const TEMPLATES = resolve(import.meta.dir, "..", "templates");
const EMPTY = {
  fps: 30, width: 1920, height: 1080,
  tracks: [{ id: "V1", type: "video", clips: [] }, { id: "A1", type: "audio", clips: [] }],
};

const safe = (base: string, rel: string) => {
  const p = resolve(base, "." + decodeURIComponent(rel));
  return p === base || p.startsWith(base + sep) ? p : null;
};

function walk(dir: string, root: string, out: string[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else out.push(p.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return out;
}

// Bun's file Response has no Range support we can rely on; <video> needs it to seek.
async function sendFile(req: Request, path: string | null) {
  const f = path && Bun.file(path);
  if (!f || !(await f.exists())) return new Response("not found", { status: 404 });
  const m = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  const h = { "accept-ranges": "bytes", "cache-control": "no-store" };
  if (!m) return new Response(f, { headers: h });
  const start = m[1] ? Number(m[1]) : f.size - Number(m[2]);
  const end = m[1] && m[2] ? Number(m[2]) : f.size - 1;
  return new Response(f.slice(start, end + 1, f.type), {
    status: 206,
    headers: { ...h, "content-range": `bytes ${start}-${end}/${f.size}` },
  });
}

const readJson = async (path: string, empty: any) => (existsSync(path) ? JSON.parse(await Bun.file(path).text()) : empty);

// templates/<slug>/index.html, used by a clip as src "@<slug>". Label = its <title>; <meta name="track"
// content="bottom"> = add it on the bottom video track (a background).
async function templates() {
  if (!existsSync(TEMPLATES)) return [];
  const out = [];
  for (const e of readdirSync(TEMPLATES, { withFileTypes: true })) {
    const f = join(TEMPLATES, e.name, "index.html");
    if (!e.isDirectory() || e.name.startsWith(".") || !existsSync(f)) continue;
    const html = await Bun.file(f).text();
    out.push({
      slug: e.name,
      label: html.match(/<title>([^<]*)<\/title>/i)?.[1].trim() || e.name,
      bottom: /<meta\s+name="track"\s+content="bottom"/i.test(html),
    });
  }
  return out;
}

// scenes/###-slug folders in order; other folders in scenes/ are ignored (warned once)
const warned = new Set<string>();
function sceneDirs(root: string) {
  const dir = join(root, "scenes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => {
    if (SCENE.test(n)) return true;
    if (!warned.has(n)) { warned.add(n); console.warn(`scenes/${n} is skipped: a scene folder name must be ###-slug, e.g. 001-hook`); }
    return false;
  }).sort();
}

export function serve(dir: string, port = 9999) {
  const root = resolve(dir);
  const tlPath = join(root, "timeline.json");
  const lastWritten = new Map<string, string>(); // file -> what we wrote: own writes must not echo back through the watcher
  const enc = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController>();
  const send = (s: string) => {
    for (const c of clients) {
      try { c.enqueue(enc.encode(s)); } catch { clients.delete(c); }
    }
  };
  setInterval(() => send(": ping\n\n"), 15000);

  const timers = new Map<string, Timer>();
  watch(root, { recursive: true }, (_, name) => {
    if (!name) return;
    const n = name.replaceAll("\\", "/");
    if (/^(\.git|node_modules|exports)(\/|$)/.test(n)) return; // exports/: a video being written
    clearTimeout(timers.get(n));
    timers.set(n, setTimeout(async () => {
      const p = join(root, n);
      if (lastWritten.has(n) && existsSync(p) && (await Bun.file(p).text()) === lastWritten.get(n)) return;
      send(`data: ${n}\n\n`);
    }, 80));
  });

  // a template edit reloads the editor too (sent as templates/<path>, outside the project)
  if (existsSync(TEMPLATES)) watch(TEMPLATES, { recursive: true }, (_, name) => {
    if (name) send(`data: templates/${name.replaceAll("\\", "/")}\n\n`);
  });

  // one export at a time, started by the editor's Export button; GET /api/export reads its progress
  let job: { state: string; file: string; i: number; n: number; error?: string; ctl: AbortController } | null = null;

  const server = Bun.serve({
    port,
    idleTimeout: 255,
    maxRequestBodySize: 2 * 1024 ** 3, // uploaded videos can be large
    async fetch(req) {
      const { pathname, searchParams } = new URL(req.url);

      if (pathname === "/api/upload" && req.method === "POST") {
        const name = (searchParams.get("name") ?? "").split(/[\\/]/).pop()!; // never trust a client path
        if (!MEDIA.test(name)) return new Response("unsupported file type", { status: 400 });
        const { abs, rel } = mediaDest(root, name);
        // stream to disk chunk by chunk; Bun.write(path, new Response(req.body)) left no file here
        const w = Bun.file(abs).writer({ highWaterMark: 1 << 20 });
        try {
          if (!req.body) throw new Error("empty body");
          for await (const chunk of req.body) w.write(chunk);
          await w.end();
        } catch (e) {
          try { await w.end(); } catch {}
          rmSync(abs, { force: true }); // never leave a broken half file in media/
          console.error("upload failed:", name, e);
          return new Response("upload failed: " + String(e), { status: 500 });
        }
        return Response.json({ path: rel });
      }

      // Delete a media file: DELETE /api/media?src=media/a.mp4 moves it to <project>/.trash/media/a.mp4
      // (a name taken there becomes a-1.mp4). The editor removes its clips first.
      if (pathname === "/api/media" && req.method === "DELETE") {
        const rel = (searchParams.get("src") ?? "").replaceAll("\\", "/");
        const file = MEDIA.test(rel) && !rel.split("/").some((p) => p.startsWith(".")) ? safe(root, "/" + encodeURIComponent(rel).replaceAll("%2F", "/")) : null;
        if (!file || !existsSync(file)) return new Response("not found", { status: 404 });
        let dest = join(root, ".trash", rel), n = 0;
        while (existsSync(dest)) dest = join(root, ".trash", rel.replace(/(\.[^./]+)$/, `-${++n}$1`));
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(file, dest);
        return new Response("ok");
      }

      // Does a media file have a sound stream? (ffprobe; 404 when ffprobe is missing, the client then decodes)
      if (pathname === "/api/probe") {
        try {
          const file = safe(root, "/" + encodeURIComponent(searchParams.get("src") ?? "").replaceAll("%2F", "/"));
          if (!file || !existsSync(file)) return new Response("not found", { status: 404 });
          const r = Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
          if (r.exitCode !== 0) return new Response("ffprobe failed", { status: 404 });
          return Response.json({ audio: !!r.stdout.toString().trim() });
        } catch {
          return new Response("no ffprobe", { status: 404 }); // also a bad path
        }
      }

      // POST ?scene=001-hook&name=x starts one (no scene = the whole video) into exports/<name>.mp4,
      // DELETE cancels it, GET = { state: running|done|error|cancelled, file, i, n, error }
      if (pathname === "/api/export") {
        if (req.method === "POST") {
          if (job?.state === "running") return new Response("an export is running", { status: 409 });
          const scene = searchParams.get("scene") || undefined;
          if (scene && !SCENE.test(scene)) return new Response("bad scene", { status: 400 });
          const name = (searchParams.get("name") ?? "").replace(/\.mp4$/i, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+/, "");
          if (!name) return new Response("bad name", { status: 400 });
          mkdirSync(join(root, "exports"), { recursive: true });
          let file = `exports/${name}.mp4`, k = 0;
          while (existsSync(join(root, file))) file = `exports/${name}-${++k}.mp4`;
          const j = (job = { state: "running", file, i: 0, n: 0, ctl: new AbortController() });
          const { exportVideo } = await import("./export.ts"); // export.ts imports this file
          exportVideo(root, join(root, file), scene, { port: server.port, signal: j.ctl.signal, onFrame: (i, n) => { j.i = i; j.n = n; } })
            .then(() => { j.state = "done"; })
            .catch((e) => {
              j.state = j.ctl.signal.aborted ? "cancelled" : "error";
              j.error = String(e?.message ?? e).trim();
              if (j.state === "error") console.error("export failed:", j.error);
            });
          return Response.json({ file });
        }
        if (req.method === "DELETE") { job?.ctl.abort(); return new Response("ok"); }
        const { ctl, ...rest } = job ?? { state: "idle", ctl: null };
        return Response.json(rest);
      }

      if (pathname === "/") return sendFile(req, join(UI, "index.html"));
      if (pathname === "/render") return sendFile(req, join(UI, "render.html"));
      if (pathname.startsWith("/ui/")) return sendFile(req, safe(UI, pathname.slice(3)));
      if (pathname.startsWith("/t/")) return sendFile(req, safe(TEMPLATES, pathname.slice(2)));
      if (pathname.startsWith("/p/")) return sendFile(req, safe(root, pathname.slice(2)));

      if (pathname === "/api/events") {
        let ctl!: ReadableStreamDefaultController;
        return new Response(new ReadableStream({
          start(c) { ctl = c; clients.add(c); c.enqueue(enc.encode(": hi\n\n")); },
          cancel() { clients.delete(ctl); },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }

      // new scene: POST /api/scene?name=Hook -> scenes/<next number>-hook/timeline.json
      if (pathname === "/api/scene" && req.method === "POST") {
        const name = (searchParams.get("name") ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        if (!name) return new Response("bad name", { status: 400 });
        const last = sceneDirs(root).at(-1);
        const slug = String((last ? Number(last.slice(0, 3)) : 0) + 1).padStart(3, "0") + "-" + name;
        mkdirSync(join(root, "scenes", slug), { recursive: true });
        await Bun.write(join(root, "scenes", slug, "timeline.json"), JSON.stringify({ tracks: [] }, null, 2));
        return Response.json({ slug });
      }

      if (pathname === "/api/timeline" || pathname === "/api/project") {
        if (req.method === "PUT") {
          // ?scene=001-hook saves that scene's timeline, else the global one
          const scene = searchParams.get("scene");
          if (scene && (!SCENE.test(scene) || !existsSync(join(root, "scenes", scene)))) return new Response("no such scene", { status: 404 });
          const rel = scene ? `scenes/${scene}/timeline.json` : "timeline.json";
          let text;
          try {
            text = JSON.stringify(JSON.parse(await req.text()), null, 2);
          } catch { return new Response("invalid json", { status: 400 }); }
          lastWritten.set(rel, text);
          await Bun.write(join(root, rel), text);
          return new Response("ok");
        }
        try {
          const timeline = await readJson(tlPath, EMPTY);
          if (pathname === "/api/timeline") return Response.json(timeline);
          const files = walk(root, root);
          return Response.json({
            name: basename(root),
            timeline,
            scenes: await Promise.all(sceneDirs(root).map(async (slug) => ({
              slug,
              timeline: await readJson(join(root, "scenes", slug, "timeline.json"), { tracks: [] }),
              // the HTML clips of this scene: scenes/<slug>/<clip>/index.html
              clips: files.map((p) => p.match(new RegExp(`^scenes/${slug}/([^/]+)/index\\.html$`)))
                .filter(Boolean).map((m) => ({ name: m![1], path: m![0] })),
            }))),
            media: files.filter((p) => MEDIA.test(p) && !p.startsWith("exports/")),
            templates: await templates(),
          });
        } catch (e) {
          // AI may be mid-edit; the UI keeps its last good state.
          return Response.json({ error: String(e) }, { status: 500 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  return server;
}
