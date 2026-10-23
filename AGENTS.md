# composive: guide for AI agents

composive is a video editor made of files. A video is HTML clips and media placed on `timeline.json`
files. You edit the files; the editor in the browser shows them (it reloads on each change); FFmpeg exports.
You do not need the editor to check your work: use `check` and `frame` (below).

README.md has every detail. This file has what you need to make or change a video.

## Work loop

Do these steps for each change. Do not say a change is done before step 3.

1. Edit the files (`timeline.json`, `scenes/*/timeline.json`, clip HTML, caption files).
2. `bun bin/composive.ts check <project>`: fix every error. Read every warning. Use `--json` to parse it.
3. `bun bin/composive.ts frame <project> --sheet 12` (or `--at 1,2.5`, `--scene 001-hook`), then look at
   the image in `<project>/preview/frames/`. Fix what looks wrong. The output also lists page errors
   (a script error in a clip, a `seek` that throws, a file that does not load).
4. Export only when the user asks: `bun bin/composive.ts export <project> -o out.mp4` (slow: Chrome renders
   every frame).

`<project>` is a name in `projects/` (e.g. `example`) or a path. Do not start `composive dev` unless the user
asks; the user often has it open already.

## Commands

| command | does |
|---|---|
| `new <name> --preset youtube\|reels\|square\|portrait\|4k [--fps 30]` | empty project: scene `001-main`, music track `GA1`, `media/` |
| `check <project> [--json]` | errors and warnings by file; exit code 1 on an error |
| `frame <project> --at 1,2.5 \| --sheet N [--scene s] [-o f.png] [--json]` | PNG frames as the export draws them |
| `captions <file.srt\|.vtt\|.json> -p <project> [--add --style captions-tiktok --scene s --at 0] [--words N]` | caption file from subtitles or ElevenLabs alignment |
| `import <folder> -p <project>` | copy media into `media/`, append to the global tracks |
| `export <project> -o out.mp4 [--scene s] [--low-perf \| --fast-perf]` | the video (whole, or one scene with the global tracks) |

## Project files

```
<project>/
  timeline.json                    fps, width, height, range, markers, global tracks (ids start with G)
  scenes/001-hook/timeline.json    a scene: its tracks (times from 0), transition, out, markers
  scenes/001-hook/<clip>/index.html  an HTML clip of this scene
  media/                           video, audio, images, .captions.json, subtitle sources
  preview/frames/                  output of `frame` (not in git)
  exports/                         output of the editor's Export button
```

- A scene folder name must be `###-slug` (`001-hook`). The number sets the order. A scene starts where the
  scene before it ends (the end of its last clip). To add a scene: make the folder and its `timeline.json`.
- Global tracks (root `timeline.json`, ids `GA1`, `GV1`) are in video time and do not move with scenes.
  Use them for music or a voice over the whole video. A global video track is always under every scene,
  so captions, titles and logos go on scene tracks.
- A scene track id must not start with `G`.

## Tracks and clips

```json
{ "tracks": [
  { "id": "V2", "type": "video", "clips": [
    { "src": "@text", "start": 0.5, "duration": 3, "props": { "text": "Hello", "y": 0.3 } } ] },
  { "id": "V1", "type": "video", "clips": [
    { "src": "media/b-roll.mp4", "start": 0, "duration": 4, "offset": 2, "props": { "scale": 1.1 } } ] },
  { "id": "A1", "type": "audio", "voice": true, "clips": [
    { "src": "media/vo.mp3", "start": 0, "duration": 6.2, "volume": 1, "fadeIn": 0, "fadeOut": 0.3 } ] }
] }
```

- Track order is layer order: the first track is on top.
- One clip per spot on a track: clips on one track must not overlap (`check` finds it). Put a clip that plays
  at the same time on another track.
- `start`, `duration`, `offset` in seconds. `offset` skips the start of the source (for an HTML clip it is
  added to `t`). `duration` of a media clip must not pass the end of the file (`check` warns, with ffprobe).
- `src`: `media/...` (a file), `scenes/<slug>/<clip>/index.html` (an HTML clip), `@<template>`.
- Audio files go on `audio` tracks; video, images and HTML on `video` tracks. A video with sound: its
  sound is a second clip on an audio track with the same `link` id (the editor and `import` do this).
- Media props: `x`, `y` (center, 0..1 of the frame), `scale`, `sx`, `sy`, `rotation` (degrees), `opacity`.
- Keyframes: `"keys": { "x": [{ "t": 0, "v": 0.2 }, { "t": 2, "v": 0.8, "ease": "out" }] }`. `t` is
  clip-local (offset included), sorted. Numbers and `#rrggbb` blend. `ease`: `linear`, `in`, `out`,
  `inout`, `hold`. An audio clip can key `volume` the same way.
- Ducking: a track with `"duck": 0.25` (a gain) goes down while a clip of a `"voice": true` track plays.
  Give the voice track `voice: true` and the music track `duck`.

## Templates (`"src": "@slug"`, in `templates/`)

| template | props |
|---|---|
| `@text` | `text`, `size`, `color`, `weight`, `font`, `x`, `y` (center) |
| `@shape` | `color`, `w`, `h` (fractions of the frame), `round` (0 = rectangle, 1 = ellipse), `opacity`, `x`, `y`, `scale`, `rotation` |
| `@lower` (lower third) | `title`, `sub`, `color`, `accent`, `size`, `x`, `y` (top-left corner) |
| `@solid` (fills the frame) | `color`, `opacity` |
| `@captions` (classic subtitles) | `file`, `size`, `color`, `bg`, `bgOpacity`, `weight`, `font`, `width`, `x`, `y` |
| `@captions-tiktok` (word highlight) | `file`, `size`, `color`, `highlight`, `stroke`, `upper`, `pop`, `font`, `width`, `x`, `y` |

A prop name that the template does not have is not used (`check` warns: it is most often a typo). Editing a
file in `templates/` changes every project that uses it; for a different look, copy the folder to a new slug.

## HTML clips

An HTML clip draws itself as a pure function of time. The editor and the exporter call `seek` for each
frame, in any order, and several export workers load the page on their own.

```html
<!doctype html>
<meta charset="utf-8">
<meta name="duration" content="4">
<meta name="props" content='{"title":"Hello","color":"#ffffff","x":0.5,"y":0.5}'>
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  #t { position: absolute; font: 800 96px system-ui, sans-serif; }
</style>
<div id="t"></div>
<script src="/lib/gsap/gsap.min.js"></script>
<script src="/lib/composive.js"></script>
<script>
  const el = document.getElementById("t");
  composive.clip({
    update: (p) => { el.textContent = p.title; el.style.color = p.color; composive.place(el, p); },
    timeline: (tl, p, duration) => {
      gsap.set(el, { xPercent: -50, yPercent: -50 });
      tl.from(el, { y: 80, opacity: 0, duration: 0.8, ease: "power3.out" });
    },
    fadeOut: 0.4,
  });
</script>
```

Rules (most are `check` warnings):

- No `requestAnimationFrame`, `setTimeout`, `setInterval`, CSS animations or transitions: draw from `t` only.
- Add every tween to `tl`. `gsap.to()` / `gsap.from()` outside `tl` run in real time and break the export.
- No `Math.random()` or `Date.now()` at draw time: frames from different workers would differ. Use fixed
  values or a seeded random.
- Set text, colors and position in `update`; animate in `timeline`. Never set one style in both.
- Do not use the CSS `translate`, `scale` or `rotate` properties on an element GSAP animates; center it
  with `gsap.set(el, { xPercent: -50, yPercent: -50 })`.
- Use a transparent `body` for an overlay. Load files from the project or `/lib/`, not from the internet
  (the export is offline and slower with it).
- Without the runtime, a clip sets `window.seek = (t, duration, props) => { ... }` itself (it may be async).

## Transitions

Types (`transitions/`): `fade`, `push`, `slide`, `wipe`, `iris`, `zoom`, `blur`, `dip`, `flash`, `cover`.
`push`, `slide`, `wipe`, `cover` take `dir` (`left`, `right`, `up`, `down`); `dip`, `flash`, `cover` take
`color`.

- Scene: in `scenes/<slug>/timeline.json`, `"transition": { "type": "push", "duration": 0.6, "dir": "left" }`
  (from the scene before; the scene starts that much earlier) and `"out": { "type": "fade", "duration": 0.5 }`.
  On the first scene, or with `"only": true`, `transition` plays over the start of this scene alone.
- Clip: `"in"` / `"out"` on a clip of a video track, same object. An `in` where the clip before ends is the
  transition between the two clips.
- One motion per seam: if a clip animates its own exit, do not also put a transition there.

## Sizes and safe zones

Size and fps are in the root `timeline.json` (`width`, `height` must be even). Positions are fractions of the
frame, so they keep their place when the size changes; HTML clips made for 16:9 can need changes for 9:16.
For Reels / TikTok / Shorts (1080x1920), the app UI covers the top and the bottom of the frame: keep text
and faces about between `y` 0.15 and 0.75 and `x` 0.06 and 0.94.

## Captions

1. Get word times: SRT / VTT, or ElevenLabs JSON (TTS "with timestamps", forced alignment, speech to text).
2. `bun bin/composive.ts captions media/vo-alignment.json -p <project> --add --style captions-tiktok --scene 001-hook --at <voice start>`.
   It writes `media/<name>.captions.json` and adds a clip on a new top track of that scene.
3. Caption times are from the start of the caption clip: start the caption clip where the voice clip starts.
4. Fix a wrong word in the `.captions.json` file (one caption line per text line), then `check` and `frame`.

## Do not

- Do not edit `ui/`, `src/`, `lib/` or `templates/` when the task is to make or change a video, unless the
  user asks for it.
- Do not write into `exports/` or `preview/` by hand, or keep files there that the project needs.
- Do not leave `check` errors. Explain a warning you keep.
