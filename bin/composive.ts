#!/usr/bin/env bun
import { resolve, join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

const PROJECTS = resolve(import.meta.dir, "..", "projects");
const args = Bun.argv.slice(2);
const cmd = args.shift();
const dirArg = args[0] && !args[0].startsWith("-") ? args.shift() : undefined; // "composive dev --port 8000" has no project
const rest = args;

// A bare name ("example") means projects/<name> in this repo when that folder exists; anything else is a path.
// No name: pick from projects/, so the editor never opens a random folder as a project.
async function project(a?: string) {
  if (!a) return join(PROJECTS, await pickProject());
  const named = join(PROJECTS, a);
  return /^[\w.-]+$/.test(a) && a !== "." && a !== ".." && existsSync(named) ? named : resolve(a);
}

const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${(s / 60) | 0} min ago` : s < 86400 ? `${(s / 3600) | 0} h ago` : `${(s / 86400) | 0} days ago`;
};

// projects/ folders, last edited first
function listProjects() {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const tl = join(PROJECTS, d.name, "timeline.json");
      return { name: d.name, at: statSync(existsSync(tl) ? tl : join(PROJECTS, d.name)).mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

async function pickProject() {
  const items = listProjects();
  if (!items.length) {
    console.log(`No projects in ${PROJECTS}. Give a path: composive ${cmd} <path>`);
    process.exit(1);
  }
  const name = process.stdin.isTTY ? await menu(items) : askLine(items);
  if (!name) { console.log("No project chosen."); process.exit(1); }
  return name;
}

const match = (items: { name: string }[], q: string) => items.filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));

// Terminal menu: type to search, Up/Down to move, Enter to open, Esc or Ctrl+C to cancel.
function menu(items: { name: string; at: number }[]): Promise<string | undefined> {
  const { stdin, stdout } = process, ROWS = 10, dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  let q = "", i = 0, lines = 0;
  const draw = () => {
    const list = match(items, q);
    i = Math.max(0, Math.min(i, list.length - 1));
    const top = Math.max(0, Math.min(i - ROWS + 1, list.length - ROWS)); // keep the selection in view
    const rows = list.slice(top, top + ROWS).map((x, k) =>
      (top + k === i ? "\x1b[36m❯ " + x.name.padEnd(30) + "\x1b[0m" : "  " + x.name.padEnd(30)) + dim(ago(x.at)));
    const out = [
      `Project: ${q}` + dim("  (type to search, ↑/↓ move, Enter open, Esc cancel)"),
      ...(rows.length ? rows : [dim("  no match")]),
      dim(`  ${list.length} of ${items.length}`),
    ];
    // go back to the first line of the last draw, rewrite, clear what is left below
    stdout.write((lines ? `\x1b[${lines}A\r` : "") + out.map((l) => "\x1b[2K" + l).join("\n") + "\n\x1b[J");
    lines = out.length;
  };
  return new Promise((res) => {
    const done = (v?: string) => {
      stdin.off("data", on);
      stdin.setRawMode(false);
      stdin.pause();
      res(v);
    };
    const on = (buf: Buffer) => {
      const k = buf.toString("utf8");
      if (k === "\x03" || k === "\x1b") return done();
      if (k === "\r" || k === "\n") { const x = match(items, q)[i]; return x ? done(x.name) : undefined; }
      if (k === "\x1b[A") i--;
      else if (k === "\x1b[B") i++;
      else if (k === "\x7f" || k === "\b") { q = q.slice(0, -1); i = 0; }
      else if (!k.startsWith("\x1b") && k >= " ") { q += k.replace(/[\r\n]/g, ""); i = 0; }
      draw();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", on);
    draw();
  });
}

// Without a terminal (piped input): numbered list of the 10 latest; a number opens one, text searches.
function askLine(items: { name: string; at: number }[]) {
  let list = items;
  for (;;) {
    list.slice(0, 10).forEach((x, k) => console.log(`  ${k + 1}) ${x.name.padEnd(30)}${ago(x.at)}`));
    if (list.length > 10) console.log(`  … ${list.length - 10} more. Type part of a name to search.`);
    const a = prompt("Project (number or name):")?.trim();
    if (!a) return undefined; // empty line or end of input
    if (/^\d+$/.test(a) && list[Number(a) - 1]) return list[Number(a) - 1].name;
    const hit = match(items, a);
    if (hit.length === 1 || hit.some((x) => x.name === a)) return (hit.find((x) => x.name === a) ?? hit[0]).name;
    if (!hit.length) console.log(`No project matches "${a}".`);
    else list = hit;
  }
}

const flag = (name: string, def?: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : def;
};

if (cmd === "dev") {
  const { serve } = await import("../src/server.ts");
  const dir = await project(dirArg);
  const s = serve(dir, Number(flag("--port", "9999")));
  console.log(`composive: http://localhost:${s.port}  (${dir})`);
} else if (cmd === "export") {
  const { exportVideo } = await import("../src/export.ts");
  await exportVideo(await project(dirArg), resolve(flag("-o", "out.mp4")!), flag("--scene"),
    { perf: rest.includes("--low-perf") ? "low" : rest.includes("--fast-perf") ? "fast" : "normal" });
  process.exit(); // serve() keeps a ping timer and file watchers alive
} else if (cmd === "frame") {
  const { frames } = await import("../src/frame.ts");
  const sheet = flag("--sheet"), at = flag("--at");
  try {
    const o = flag("-o");
    const r = await frames(await project(dirArg), o ? resolve(o) : undefined, {
      scene: flag("--scene"), sheet: sheet ? Math.max(1, Math.min(48, Number(sheet) | 0)) : undefined,
      at: at ? at.split(",").map(Number) : undefined,
    });
    if (rest.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
      for (const f of r.written) console.log(`wrote ${f}`);
      for (const p of r.problems) console.log(`\x1b[33mwarn\x1b[0m  ${p}`);
    }
  } catch (e: any) { console.error(e.message ?? e); process.exit(1); }
  process.exit(); // serve() keeps a ping timer and file watchers alive
} else if (cmd === "new" && dirArg) {
  const { newProject } = await import("../src/new.ts");
  // a bare name is projects/<name>, anything else a path
  const dir = /^[\w.-]+$/.test(dirArg) && dirArg !== "." && dirArg !== ".." ? join(PROJECTS, dirArg) : resolve(dirArg);
  try { newProject(dir, flag("--preset", "youtube")!, Number(flag("--fps", "30"))); }
  catch (e: any) { console.error(e.message ?? e); process.exit(1); }
} else if (cmd === "captions" && dirArg) {
  const { makeCaptions } = await import("../src/captions.ts");
  const style = flag("--style", "captions")!.replace(/^@/, "");
  try {
    await makeCaptions(await project(flag("-p")), resolve(dirArg), {
      out: flag("-o"), words: Number(flag("--words", style === "captions-tiktok" ? "3" : "10")), add: rest.includes("--add"),
      scene: flag("--scene"), at: Number(flag("--at", "0")), style,
    });
  } catch (e: any) { console.error(e.message ?? e); process.exit(1); }
} else if (cmd === "check") {
  const { runCheck } = await import("../src/check.ts");
  process.exit(await runCheck(await project(dirArg), rest.includes("--json")));
} else if (cmd === "import" && dirArg) {
  const { importFolder } = await import("../src/import.ts");
  await importFolder(await project(flag("-p")), resolve(dirArg));
} else {
  console.log("usage:\n  composive new <name> [--preset youtube|reels|square|portrait|4k] [--fps 30]\n  composive dev [project] [--port 9999]\n  composive export [project] [-o out.mp4] [--scene 001-hook] [--low-perf | --fast-perf]\n  composive check [project] [--json]\n  composive frame [project] [--at 1,2.5 | --sheet 12] [--scene 001-hook] [-o f.png] [--json]\n  composive import <folder> [-p project]\n  composive captions <file.srt|.vtt|.json> [-p project] [-o media/x.captions.json] [--words 10] [--add [--style captions|captions-tiktok] [--scene 001-hook] [--at 0]]\n" +
    "project = a name in projects/ (e.g. example) or a path; leave it out to pick from a menu");
  process.exit(1);
}
