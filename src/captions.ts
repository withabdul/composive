// composive captions: SRT / VTT or ElevenLabs alignment JSON -> <project>/media/<name>.captions.json,
// { lines: [{ t, e, words: [{ w, t, e }] }] } (seconds), read by templates/captions*. --add puts a clip on a scene.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { SCENE } from "../ui/core/project.js";

const TEMPLATES = join(import.meta.dir, "..", "templates");

type Word = { w: string; t: number; e: number };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// SRT and VTT: each cue is a block with "00:00:01,000 --> 00:00:02,500" and its text. A cue has no word
// times, so its words share the cue time by their length. A cue never shares a line with another.
function fromSubs(text: string) {
  const time = (s: string) => {
    const m = s.trim().match(/^(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) return NaN;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
  };
  const cues: Word[][] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n"), i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->").map(time);
    const words = lines.slice(i + 1).join(" ").replace(/<[^>]+>|\{[^}]+\}/g, "").split(/\s+/).filter(Boolean); // drop <i>, <c.x>, {\an8}
    if (!words.length || !(b > a)) continue;
    const total = words.reduce((n, w) => n + w.length + 1, 0);
    let t = a;
    cues.push(words.map((w) => {
      const e = t + ((b - a) * (w.length + 1)) / total, x = { w, t: r3(t), e: r3(e) };
      t = e;
      return x;
    }));
  }
  return cues;
}

// ElevenLabs JSON: TTS "with timestamps" ({ alignment: { characters, character_start_times_seconds,
// character_end_times_seconds } }, or those three fields at the top), forced alignment and speech to text
// ({ words: [{ text, start, end, type? }] }). One list of words: the pauses and sentences make the lines.
function fromJson(j: any): Word[][] {
  if (Array.isArray(j?.words)) {
    return [j.words.filter((w: any) => (w.type ?? "word") === "word" && String(w.text ?? "").trim())
      .map((w: any) => ({ w: String(w.text).trim(), t: r3(w.start), e: r3(w.end) }))];
  }
  const a = j?.alignment ?? j?.normalized_alignment ?? j;
  const ch = a?.characters, s = a?.character_start_times_seconds, e = a?.character_end_times_seconds;
  if (!Array.isArray(ch) || !Array.isArray(s) || !Array.isArray(e))
    throw new Error("Unknown JSON: expected ElevenLabs alignment (characters + character_start_times_seconds) or words [{ text, start, end }].");
  const words: Word[] = [];
  let cur: Word | null = null;
  ch.forEach((c: string, i: number) => {
    if (/^\s+$/.test(c)) { cur = null; return; }
    if (!cur) words.push((cur = { w: "", t: r3(s[i]), e: r3(e[i]) }));
    cur.w += c;
    cur.e = r3(e[i]);
  });
  return [words];
}

// Lines of at most `max` words. A sentence end or a pause of more than `gap` seconds always ends a line;
// a longer part between them is cut into lines of near equal size (7 words, max 3: 3 + 2 + 2, not 3 + 3 + 1).
function lines(groups: Word[][], max: number, gap = 0.5) {
  const out: { t: number; e: number; words: Word[] }[] = [];
  for (const g of groups) {
    let part: Word[] = [];
    g.forEach((w, i) => {
      part.push(w);
      const next = g[i + 1];
      if (next && !/[.!?…]["')\]]*$/.test(w.w) && next.t - w.e <= gap) return;
      const n = Math.ceil(part.length / max);
      for (let k = 0, at = 0; k < n; k++) {
        const len = Math.floor(part.length / n) + (k < part.length % n ? 1 : 0), words = part.slice(at, (at += len));
        out.push({ t: words[0].t, e: words.at(-1)!.e, words });
      }
      part = [];
    });
  }
  return out;
}

type Opts = { out?: string; words: number; add?: boolean; scene?: string; at: number; style: string };
export async function makeCaptions(project: string, input: string, o: Opts) {
  if (!existsSync(input)) throw new Error(`No file ${input}`);
  const text = readFileSync(input, "utf8").replace(/^﻿/, "");
  const ext = extname(input).toLowerCase();
  let groups: Word[][];
  if (ext === ".json") {
    let j;
    try { j = JSON.parse(text); } catch (e: any) { throw new Error(`${input} is not valid JSON: ${e.message}`); }
    groups = fromJson(j);
  } else if (ext === ".srt" || ext === ".vtt") groups = fromSubs(text);
  else throw new Error("Give a .srt, .vtt or ElevenLabs .json file.");
  const cap = { lines: lines(groups, Math.max(1, o.words)) };
  if (!cap.lines.length) throw new Error(`No words found in ${input}`);

  const rel = (o.out ?? `media/${basename(input, extname(input)).replace(/\.captions$/, "")}.captions.json`).replaceAll("\\", "/");
  if (rel.startsWith("..") || /^[a-z]:|^\//i.test(rel)) throw new Error("-o must be a path inside the project, e.g. media/vo.captions.json");
  // --add goes on a scene (global video tracks are under every scene, too low for captions); checked before any write
  const sdir = join(project, "scenes");
  const scenes = existsSync(sdir) ? readdirSync(sdir, { withFileTypes: true }).filter((d) => d.isDirectory() && SCENE.test(d.name)).map((d) => d.name).sort() : [];
  const slug = o.scene ?? scenes[0];
  if (o.add) {
    if (!slug || !scenes.includes(slug)) throw new Error(o.scene ? `No scene "${o.scene}". Scenes: ${scenes.join(", ") || "none"}` : "The project has no scene to add the clip to.");
    if (!existsSync(join(TEMPLATES, o.style, "index.html"))) throw new Error(`No template @${o.style} (templates/${o.style}/index.html)`);
  }
  // one caption line per text line: easy to read and to fix a word by hand
  const one = (l: { t: number; e: number; words: Word[] }) =>
    `{ "t": ${l.t}, "e": ${l.e}, "words": [${l.words.map((w) => `{ "w": ${JSON.stringify(w.w)}, "t": ${w.t}, "e": ${w.e} }`).join(", ")}] }`;
  await Bun.write(join(project, rel), `{ "lines": [\n${cap.lines.map((l) => "  " + one(l)).join(",\n")}\n] }\n`);
  const n = cap.lines.reduce((k, l) => k + l.words.length, 0), end = cap.lines.at(-1)!.e;
  console.log(`wrote ${rel}: ${n} words in ${cap.lines.length} lines, ${end.toFixed(2)} s`);
  if (!o.add) return console.log(`use it: a clip with src "@${o.style}" and props { "file": "${rel}" }, or run again with --add`);

  // --add: a clip on a new track on top of the scene
  const file = join(project, "scenes", slug, "timeline.json");
  const tl = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { tracks: [] };
  tl.tracks ??= [];
  let k = 1;
  while (tl.tracks.some((t: any) => t.id === `V${k}`)) k++;
  tl.tracks.unshift({ id: `V${k}`, name: "Captions", type: "video", clips: [{ src: `@${o.style}`, start: o.at, duration: r3(end + 0.6), props: { file: rel } }] });
  await Bun.write(file, JSON.stringify(tl, null, 2));
  console.log(`added @${o.style} at ${o.at} s on track V${k} of ${relative(project, file).replaceAll("\\", "/")}`);
}
