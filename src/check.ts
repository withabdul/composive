// composive check: finds what would break the editor or the export before anyone opens them.
// Reads the files directly (no server) and uses the same rules as the editor: SCENE, layout(), clipTransitions().
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MEDIA, MEDIA_PROPS, EASES, kind, clipTransitions } from "../ui/canvas/stage.js";
import { SCENE, layout, end } from "../ui/core/project.js";

const ROOT = resolve(import.meta.dir, "..");
const TEMPLATES = join(ROOT, "templates"), TRANSITIONS = join(ROOT, "transitions");
const HEX = /^#[0-9a-f]{6}$/i;
const TR_EASES = EASES.filter((e) => e !== "hold");
const num = (v: any) => typeof v === "number" && Number.isFinite(v);

export type Issue = { level: "error" | "warn"; file: string; at?: string; msg: string };

export async function check(dir: string) {
  const root = resolve(dir), issues: Issue[] = [];
  const err = (file: string, msg: string, at?: string) => issues.push({ level: "error", file, at, msg });
  const warn = (file: string, msg: string, at?: string) => issues.push({ level: "warn", file, at, msg });
  const json = async (rel: string) => {
    try { return JSON.parse(await Bun.file(join(root, rel)).text()); }
    catch (e: any) { err(rel, `invalid JSON: ${e.message}`); }
  };

  if (!existsSync(root)) return { root, issues: [{ level: "error", file: ".", msg: `no folder ${root}` }] as Issue[] };
  if (!existsSync(join(root, "timeline.json"))) warn("timeline.json", "missing: the editor starts an empty 1920x1080 project");
  const global = existsSync(join(root, "timeline.json")) ? await json("timeline.json") : { tracks: [] };

  // transition types: transitions/<type>.js, with optional `dirs` and `color`
  const types = new Map<string, any>();
  for (const f of existsSync(TRANSITIONS) ? readdirSync(TRANSITIONS).filter((f) => f.endsWith(".js")) : []) {
    try { types.set(f.slice(0, -3), await import(pathToFileURL(join(TRANSITIONS, f)).href)); }
    catch (e: any) { err(`transitions/${f}`, `does not load: ${e.message}`); }
  }

  const scenes: { slug: string; timeline: any }[] = [];
  const sdir = join(root, "scenes");
  for (const e of existsSync(sdir) ? readdirSync(sdir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : []) {
    if (!e.isDirectory()) continue;
    if (!SCENE.test(e.name)) { warn(`scenes/${e.name}`, "skipped: a scene folder name must be ###-slug, e.g. 001-hook"); continue; }
    const rel = `scenes/${e.name}/timeline.json`;
    if (!existsSync(join(root, rel))) { warn(rel, "missing: the scene is empty"); scenes.push({ slug: e.name, timeline: { tracks: [] } }); continue; }
    const tl = await json(rel);
    if (tl) scenes.push({ slug: e.name, timeline: tl });
  }
  const nums = scenes.map((s) => s.slug.slice(0, 3));
  for (const [i, n] of nums.entries()) if (nums.indexOf(n) < i) warn(`scenes/${scenes[i].slug}`, `same number as scenes/${scenes[nums.indexOf(n)].slug}: the order is by name`);
  if (!global) return { root, issues };

  for (const k of ["fps", "width", "height"]) if (global[k] !== undefined && !(num(global[k]) && global[k] > 0)) err("timeline.json", `${k} must be a number > 0`);
  for (const k of ["width", "height"]) if (num(global[k]) && global[k] % 2) err("timeline.json", `${k} must be even: the H.264 export (yuv420p) fails on an odd size`);

  // HTML clips: each file once (defaults for the props check, plus the lint below)
  const pages = new Map<string, { file: string; defaults: any } | null>();
  const page = async (src: string) => {
    if (pages.has(src)) return pages.get(src);
    const file = src[0] === "@" ? `templates/${src.slice(1)}/index.html` : src;
    const abs = src[0] === "@" ? join(TEMPLATES, src.slice(1), "index.html") : join(root, src);
    let r = null;
    if (existsSync(abs)) r = { file, defaults: lintHtml(file, await Bun.file(abs).text(), err, warn) };
    pages.set(src, r);
    return r;
  };

  // length of a media file in seconds (ffprobe), null if unknown
  const lens = new Map<string, number | null>();
  let probe = true;
  const mediaLen = (src: string) => {
    if (!probe || kind(src) === "image") return null;
    if (!lens.has(src)) {
      try {
        const r = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(root, src)]);
        lens.set(src, Number(r.stdout.toString().trim()) || null);
      } catch { probe = false; warn(".", "ffprobe not found: clip lengths are not checked against their media"); return null; }
    }
    return lens.get(src)!;
  };

  const transition = (file: string, at: string, name: string, x: any) => {
    if (x === undefined || x === null) return;
    if (typeof x !== "object" || !x.type) return err(file, `${name} needs a type`, at);
    const t = types.get(x.type);
    if (!t) return err(file, `${name}: no transition type "${x.type}" (types: ${[...types.keys()].join(", ")})`, at);
    if (x.duration !== undefined && !(num(x.duration) && x.duration > 0)) err(file, `${name}.duration must be a number > 0`, at);
    if (x.ease !== undefined && !TR_EASES.includes(x.ease)) err(file, `${name}.ease must be one of ${TR_EASES.join(", ")}`, at);
    if (x.dir !== undefined && !t.dirs?.includes(x.dir)) err(file, `${name}.dir: "${x.type}" takes ${t.dirs?.join(", ") ?? "no dir"}`, at);
    if (x.color !== undefined && (!t.color || !HEX.test(x.color))) err(file, `${name}.color: ${t.color ? "must be #rrggbb" : `"${x.type}" takes no color`}`, at);
  };

  // a caption clip's file (props.file): { lines: [{ t, e, words: [{ w, t, e }] }] }, each file read once
  const capFiles = new Map<string, string | null>();
  const captionFile = async (file: string, at: string, rel: any) => {
    if (!rel) return warn(file, "caption clip without props.file: it shows a hint, no captions (composive captions makes the file)", at);
    if (!capFiles.has(rel)) {
      let why: string | null = null;
      try {
        const cap = JSON.parse(await Bun.file(join(root, rel)).text());
        const bad = !Array.isArray(cap?.lines) ? "no lines list"
          : cap.lines.findIndex((l: any) => !num(l?.t) || !num(l?.e) || !Array.isArray(l?.words) || l.words.some((w: any) => typeof w?.w !== "string" || !num(w?.t) || !num(w?.e)));
        if (bad === "no lines list") why = bad;
        else if (bad >= 0) why = `line ${bad + 1} needs t, e and words [{ w, t, e }]`;
      } catch (e: any) { why = existsSync(join(root, rel)) ? `not valid JSON: ${e.message}` : "not found"; }
      capFiles.set(rel, why);
    }
    const why = capFiles.get(rel);
    if (why) err(file, `props.file ${rel}: ${why}`, at);
  };

  const links = new Map<string, string[]>();
  const tracks = async (file: string, tl: any, scene: boolean) => {
    if (!Array.isArray(tl.tracks)) return tl.tracks === undefined ? undefined : err(file, "tracks must be a list");
    const ids = new Set<string>();
    for (const [ti, tr] of tl.tracks.entries()) {
      const tat = tr?.id ?? `track ${ti + 1}`;
      if (typeof tr?.id !== "string" || !tr.id) { err(file, "track needs an id (e.g. V1, A1)", tat); continue; }
      if (ids.has(tr.id)) err(file, "two tracks with this id", tat);
      ids.add(tr.id);
      if (scene && tr.id.startsWith("G")) err(file, 'a scene track id must not start with "G" (G = global): the editor saves it into the global timeline', tat);
      const type = tr.type ?? "video";
      if (type !== "video" && type !== "audio") { err(file, `type must be "video" or "audio"`, tat); continue; }
      if (tr.clips !== undefined && !Array.isArray(tr.clips)) { err(file, "clips must be a list", tat); continue; }
      const clips = tr.clips ?? [];
      for (const [ci, c] of clips.entries()) await clip(file, `${tat} clip ${ci + 1}${c?.id ? ` (${c.id})` : ""}`, c, type, scene);
      const ok = clips.filter((c: any) => num(c?.start) && num(c?.duration));
      const sorted = [...ok].sort((p: any, q: any) => p.start - q.start);
      for (let i = 1; i < sorted.length; i++) {
        const p = sorted[i - 1], q = sorted[i];
        if (q.start < p.start + p.duration - 1e-6) err(file, `clips overlap at ${q.start}s (${p.id ?? p.src} ends at ${+(p.start + p.duration).toFixed(3)}s): one clip per spot on a track`, tr.id);
      }
      if (type === "video") for (const x of clipTransitions({ clips: sorted }))
        if (x.b - x.a < (x.x.duration ?? 0.6) - 1e-6) warn(file, `${x.to ? "in" : "out"} transition "${x.x.type}" is cut to ${+(x.b - x.a).toFixed(3)}s by the clip length`, `${tr.id} ${(x.to ?? x.from).id ?? (x.to ?? x.from).src}`);
    }
  };

  const clip = async (file: string, at: string, c: any, type: string, scene: boolean) => {
    if (!c || typeof c !== "object") return err(file, "clip must be an object", at);
    if (typeof c.src !== "string" || !c.src) return err(file, "clip needs a src", at);
    if (c.link !== undefined) links.set(c.link, [...(links.get(c.link) ?? []), `${file} ${at}`]);
    if (!num(c.start) || c.start < 0) err(file, "start must be a number >= 0", at);
    if (!num(c.duration) || c.duration <= 0) err(file, "duration must be a number > 0", at);
    if (c.offset !== undefined && !(num(c.offset) && c.offset >= 0)) err(file, "offset must be a number >= 0", at);
    const k = kind(c.src), off = num(c.offset) ? c.offset : 0;
    let defaults: any = null;
    if (k === "scene") {
      const p = await page(c.src);
      if (!p) return err(file, c.src[0] === "@" ? `no template ${c.src} (templates/${c.src.slice(1)}/index.html)` : `src not found: ${c.src}`, at);
      defaults = p.defaults;
      if (/^@captions\b/.test(c.src)) await captionFile(file, at, c.props?.file);
    } else {
      if (!MEDIA.test(c.src)) return err(file, `unsupported file type: ${c.src}`, at);
      if (!existsSync(join(root, c.src))) return err(file, `src not found: ${c.src}`, at);
      if (type === "video" && k !== "audio") defaults = MEDIA_PROPS;
      const len = mediaLen(c.src);
      if (len && num(c.duration) && off + c.duration > len + 0.05)
        warn(file, `runs ${+(off + c.duration - len).toFixed(3)}s past the end of ${c.src} (${+len.toFixed(3)}s long)`, at);
    }
    if (type === "audio" && (k === "scene" || k === "image")) err(file, `an audio track cannot play ${k === "scene" ? "an HTML clip" : "an image"}`, at);
    if (type === "video" && k === "audio") err(file, "a video track cannot show an audio file: put it on an audio track", at);
    if (type === "audio") {
      if (c.volume !== undefined && !(num(c.volume) && c.volume >= 0)) err(file, "volume must be a number >= 0", at);
      for (const f of ["fadeIn", "fadeOut"]) if (c[f] !== undefined && !(num(c[f]) && c[f] >= 0)) err(file, `${f} must be a number >= 0`, at);
      if ((c.fadeIn ?? 0) + (c.fadeOut ?? 0) > c.duration) warn(file, "fadeIn + fadeOut is longer than the clip", at);
      if (c.in || c.out) warn(file, "in / out transitions on an audio clip do nothing (use fadeIn / fadeOut)", at);
    } else {
      transition(file, at, "in", c.in);
      transition(file, at, "out", c.out);
    }
    if (c.props !== undefined && (typeof c.props !== "object" || Array.isArray(c.props))) err(file, "props must be an object", at);
    // a prop name the clip does not declare is never used: most often a typo
    const known = (p: string) => !defaults || Object.keys(defaults).length === 0 || p in defaults;
    for (const p of Object.keys(c.props ?? {})) if (!known(p)) warn(file, `prop "${p}" is not in the clip's defaults (${Object.keys(defaults).join(", ")})`, at);
    if (c.keys !== undefined) {
      if (typeof c.keys !== "object" || Array.isArray(c.keys)) return err(file, "keys must be an object { prop: [keys] }", at);
      for (const [p, ks] of Object.entries<any>(c.keys)) {
        if (!Array.isArray(ks)) { err(file, `keys.${p} must be a list`, at); continue; }
        if (!known(p)) warn(file, `keys.${p}: "${p}" is not in the clip's defaults`, at);
        ks.forEach((key: any, i: number) => {
          if (!num(key?.t)) err(file, `keys.${p}[${i}].t must be a number (clip-local seconds, offset included)`, at);
          if (key?.v === undefined) err(file, `keys.${p}[${i}] needs a value v`, at);
          if (key?.ease !== undefined && !EASES.includes(key.ease)) err(file, `keys.${p}[${i}].ease must be one of ${EASES.join(", ")}`, at);
          if (i && num(key?.t) && num(ks[i - 1]?.t) && key.t < ks[i - 1].t) err(file, `keys.${p} must be sorted by t`, at);
        });
        const types = new Set(ks.map((key: any) => (HEX.test(key?.v) ? "color" : typeof key?.v)));
        if (types.size > 1) warn(file, `keys.${p} mixes value types (${[...types].join(", ")}): they do not blend`, at);
      }
    }
  };

  await tracks("timeline.json", global, false);
  for (const s of scenes) {
    const file = `scenes/${s.slug}/timeline.json`;
    await tracks(file, s.timeline, true);
    transition(file, "scene", "transition", s.timeline.transition);
    transition(file, "scene", "out", s.timeline.out);
  }
  for (const [id, at] of links) if (at.length < 2) warn(at[0].split(" ")[0], `link "${id}" has only this clip`, at[0].split(" ").slice(1).join(" "));

  // scene transitions longer than layout() lets them be
  const ok = scenes.filter((s) => Array.isArray(s.timeline.tracks ?? []));
  const L = layout({ scenes: ok.map((s) => ({ ...s, timeline: { ...s.timeline, tracks: (s.timeline.tracks ?? []).map((t: any) => ({ ...t, clips: (t.clips ?? []).filter((c: any) => num(c?.start) && num(c?.duration)) })) } })) });
  L.forEach((w, i) => {
    const s = ok[i], file = `scenes/${s.slug}/timeline.json`, x = s.timeline.transition;
    if (end(s.timeline) === 0) warn(file, "the scene has no clips: it takes no time");
    if (x?.type && w.x && w.x.duration < (x.duration ?? 0.6) - 1e-6) warn(file, `transition is cut to ${w.x.duration}s by the scene lengths`, "scene");
    if (x?.type && i && !x.only && !w.x) warn(file, "transition has no room: the scene before takes all of it", "scene");
  });

  const r = global.range, total = L.at(-1)?.b ?? 0;
  if (r) {
    if (!num(r.in) || !num(r.out) || r.in >= r.out) err("timeline.json", "range needs numbers in < out");
    else if (r.in >= Math.max(total, end(global))) warn("timeline.json", `range starts at ${r.in}s, after the end of the video (${Math.max(total, end(global))}s): the export is empty`);
  }
  return { root, issues };
}

// The page's props defaults, plus warnings for what breaks the export: a clip must draw itself as a
// pure function of the time passed to seek (each export worker loads the page on its own).
function lintHtml(file: string, html: string, err: Function, warn: Function) {
  let defaults = {};
  const meta = html.match(/<meta\s+name=["']props["']\s+content=(['"])([\s\S]*?)\1/i);
  if (meta) {
    try { defaults = JSON.parse(meta[2]); }
    catch (e: any) { err(file, `<meta name="props"> is not valid JSON: ${e.message}`); }
  }
  const code = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  const uses = (re: RegExp) => re.test(code);
  const loads = (s: string) => new RegExp(`<script[^>]+src=["'][^"']*${s}["']`, "i").test(html);
  const runtime = uses(/composive\.clip\s*\(/);
  if (!runtime && !uses(/window\.seek\s*=|function\s+seek\s*\(/)) err(file, "never sets window.seek (or calls composive.clip): the clip does not draw");
  if (runtime && !loads("/lib/composive\\.js")) err(file, 'calls composive.clip without <script src="/lib/composive.js">');
  if (runtime && uses(/\btimeline\s*[:(]/) && !loads("/lib/gsap/gsap\\.min\\.js")) err(file, 'uses timeline without <script src="/lib/gsap/gsap.min.js"> before composive.js');
  for (const [re, what] of [[/requestAnimationFrame\s*\(/, "requestAnimationFrame"], [/setInterval\s*\(/, "setInterval"], [/setTimeout\s*\(/, "setTimeout"]] as const)
    if (uses(re)) warn(file, `uses ${what}: the export calls seek for each frame and does not wait for timers; draw from t only`);
  if (uses(/gsap\.(to|from|fromTo)\s*\(/)) warn(file, "gsap.to / from / fromTo run in real time: add every tween to the timeline tl (tl.to(...))");
  if (uses(/Math\.random\s*\(|Date\.now\s*\(|performance\.now\s*\(/))
    warn(file, "Math.random / Date.now: each export worker loads the page on its own, so frames can differ (flicker); use fixed values or a seeded random");
  if (uses(/\.(play|pause)\s*\(\s*\)/) && uses(/gsap/)) warn(file, "tl.play() / pause(): the runtime sets the time, the timeline must not play");
  // GSAP cannot animate a pseudo-element (::after), so a rule for one is safe
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const risky = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel, body]) => !/::?(before|after)\b|::/.test(sel) && /(^|[;\s])(translate|scale|rotate)\s*:/.test(body));
  if (/gsap/.test(code) && risky.length)
    warn(file, `CSS translate / scale / rotate properties (${risky.map((m) => m[1].trim()).join(", ")}) are lost when GSAP animates that element (use transform, or gsap.set)`);
  if (/(src|href)=["']https?:\/\//i.test(html) || /url\(\s*["']?https?:\/\//i.test(html) || /@import\s+["']?https?:/i.test(html))
    warn(file, "loads files from the internet: the export is slower and fails offline; copy them into the project");
  return defaults;
}

// CLI: human text, or --json for tools. Exit code 1 when there is an error.
export async function runCheck(dir: string, asJson: boolean) {
  const { root, issues: found } = await check(dir);
  // grouped by file, the global timeline first, errors before warnings (the sort keeps the order inside a group)
  const rank = (f: string) => (f === "timeline.json" ? "" : f);
  const issues = found.sort((p, q) => rank(p.file).localeCompare(rank(q.file)) || (p.level === q.level ? 0 : p.level === "error" ? -1 : 1));
  const errors = issues.filter((i) => i.level === "error").length, warnings = issues.length - errors;
  if (asJson) console.log(JSON.stringify({ project: root, errors, warnings, issues }, null, 2));
  else {
    console.log(root);
    for (const i of issues) console.log(`  ${i.level === "error" ? "\x1b[31merror\x1b[0m" : "\x1b[33mwarn \x1b[0m"}  ${i.file}${i.at ? `  [${i.at}]` : ""}  ${i.msg}`);
    console.log(issues.length ? `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}` : "ok: no problems found");
  }
  return errors ? 1 : 0;
}
