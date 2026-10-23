// composive new: an empty project at a preset size, with one scene (001-main) and a music track.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FORMATS, FPS } from "../ui/core/project.js";

export function newProject(dir: string, preset: string, fps: number) {
  const f = FORMATS.find((x) => x.id === preset);
  if (!f) throw new Error(`No preset "${preset}". Presets: ${FORMATS.map((x) => `${x.id} (${x.width}x${x.height})`).join(", ")}`);
  if (!(fps > 0 && fps <= 120)) throw new Error(`--fps must be a number from 1 to 120 (common: ${FPS.join(", ")})`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty.`);
  const json = (v: any) => JSON.stringify(v, null, 2) + "\n";
  mkdirSync(join(dir, "scenes", "001-main"), { recursive: true });
  mkdirSync(join(dir, "media"), { recursive: true });
  writeFileSync(join(dir, "timeline.json"), json({ fps, width: f.width, height: f.height, tracks: [{ id: "GA1", type: "audio", clips: [] }] }));
  writeFileSync(join(dir, "scenes", "001-main", "timeline.json"), json({ tracks: [{ id: "V1", type: "video", clips: [] }] }));
  const rel = relative(join(import.meta.dir, "..", "projects"), dir);
  const name = rel && !/^\.\.|[\\/]/.test(rel) ? rel : `"${dir}"`; // a folder right in projects/: its bare name
  console.log(`made ${dir}  (${f.label}, ${f.width}x${f.height}, ${fps} fps)\nopen it: composive dev ${name}`);
}
