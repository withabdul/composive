// Import media into a project: files are copied to <project>/media, then appended to the timeline.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { MEDIA, kind, normalize } from "../ui/canvas/stage.js";

// Free name inside <project>/media: "a.mp4" becomes "a-1.mp4" if taken.
export function mediaDest(project: string, name: string) {
  const dir = join(project, "media");
  mkdirSync(dir, { recursive: true });
  const ext = extname(name), stem = basename(name, ext);
  let n = 0, file = name;
  while (existsSync(join(dir, file))) file = `${stem}-${++n}${ext}`;
  return { abs: join(dir, file), rel: `media/${file}` };
}

function duration(file: string) {
  if (kind(file) === "image") return 3;
  const r = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(r.stdout.toString().trim()) || 3;
}

const hasSound = (file: string) =>
  !!Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]).stdout.toString().trim();

// An unlocked track of this type (the first, or one free over start..end), else a new one. Same rule as the editor.
function trackFor(tl: any, type: string, start?: number, end?: number) {
  const free = (t: any) => end === undefined || t.clips.every((x: any) => x.start >= end || x.start + x.duration <= start!);
  let tr = tl.tracks.find((t: any) => t.type === type && !t.lock && free(t));
  if (!tr) {
    const p = type === "audio" ? "A" : "V";
    let n = 1;
    while (tl.tracks.some((t: any) => t.id === p + n)) n++;
    tr = { id: p + n, type, clips: [] };
    type === "audio" ? tl.tracks.push(tr) : tl.tracks.unshift(tr);
  }
  return tr;
}

// Every media file under `folder`, sorted by file name, goes to the end of the matching track.
export async function importFolder(project: string, folder: string) {
  const files = (readdirSync(folder, { recursive: true }) as string[])
    .filter((f) => MEDIA.test(f) && statSync(join(folder, f)).isFile())
    .sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));
  if (!files.length) throw new Error(`No media files found in ${folder}`);

  const tlPath = join(project, "timeline.json");
  const tl = existsSync(tlPath) ? JSON.parse(await Bun.file(tlPath).text()) : { tracks: [] };
  normalize(tl);
  for (const f of files) {
    const { abs, rel } = mediaDest(project, basename(f));
    copyFileSync(join(folder, f), abs);
    const type = kind(rel) === "audio" ? "audio" : "video";
    const tr = trackFor(tl, type);
    const start = Math.max(0, ...tr.clips.map((c: any) => c.start + c.duration));
    const c: any = { src: rel, start, duration: duration(abs) };
    tr.clips.push(c);
    if (kind(rel) === "video" && hasSound(abs)) { // its sound becomes a linked clip on an audio track, as in the editor
      c.link = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      trackFor(tl, "audio", start, start + c.duration).clips.push({ src: rel, start, duration: c.duration, link: c.link });
    }
  }
  normalize(tl); // gives the new clips their ids
  await Bun.write(tlPath, JSON.stringify(tl, null, 2));
  console.log(`imported ${files.length} file(s) into ${join(project, "media")}`);
}
