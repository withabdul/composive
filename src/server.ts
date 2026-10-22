import { watch, readdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve, basename, sep } from "node:path";
import { MEDIA } from "../ui/canvas/stage.js";
import { mediaDest } from "./import.ts";

const UI = resolve(import.meta.dir, "..", "ui");
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

export function serve(dir: string, port = 9999) {
  const root = resolve(dir);
  const tlPath = join(root, "timeline.json");
  let lastWritten = ""; // own writes must not echo back through the watcher
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
    if (/^(\.git|node_modules)(\/|$)/.test(n)) return;
    clearTimeout(timers.get(n));
    timers.set(n, setTimeout(async () => {
      if (n === "timeline.json" && existsSync(tlPath) && (await Bun.file(tlPath).text()) === lastWritten) return;
      send(`data: ${n}\n\n`);
    }, 80));
  });

  return Bun.serve({
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

      if (pathname === "/") return sendFile(req, join(UI, "index.html"));
      if (pathname === "/render") return sendFile(req, join(UI, "render.html"));
      if (pathname.startsWith("/ui/")) return sendFile(req, safe(UI, pathname.slice(3)));
      if (pathname.startsWith("/p/")) return sendFile(req, safe(root, pathname.slice(2)));

      if (pathname === "/api/events") {
        let ctl!: ReadableStreamDefaultController;
        return new Response(new ReadableStream({
          start(c) { ctl = c; clients.add(c); c.enqueue(enc.encode(": hi\n\n")); },
          cancel() { clients.delete(ctl); },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }

      if (pathname === "/api/timeline" || pathname === "/api/project") {
        if (req.method === "PUT") {
          try {
            lastWritten = JSON.stringify(JSON.parse(await req.text()), null, 2);
          } catch { return new Response("invalid json", { status: 400 }); }
          await Bun.write(tlPath, lastWritten);
          return new Response("ok");
        }
        try {
          const timeline = existsSync(tlPath) ? JSON.parse(await Bun.file(tlPath).text()) : EMPTY;
          if (pathname === "/api/timeline") return Response.json(timeline);
          const files = walk(root, root);
          return Response.json({
            name: basename(root),
            timeline,
            scenes: files
              .map((p) => p.match(/^scenes\/([^/]+)\/index\.html$/))
              .filter(Boolean)
              .map((m) => ({ name: m![1], path: m![0] })),
            media: files.filter((p) => MEDIA.test(p)),
          });
        } catch (e) {
          // AI may be mid-edit; the UI keeps its last good state.
          return Response.json({ error: String(e) }, { status: 500 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
}
