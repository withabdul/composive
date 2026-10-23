# composive

Minimal video editor: HTML scenes + `timeline.json`. An AI edits the files, the browser previews, FFmpeg exports.

```
bun install
bun bin/composive.ts dev example            # editor at http://localhost:9999, live-reloads on file change
bun bin/composive.ts export example -o out.mp4   # needs ffmpeg on PATH and Chrome (or CHROME_PATH)
bun bin/composive.ts export example -o hook.mp4 --scene 001-hook   # one scene, with the global tracks under it
bun bin/composive.ts export example --fast-perf   # 8 Chrome processes render at once (default 4, --low-perf = 1): faster, more CPU and RAM
bun bin/composive.ts check example                # find what breaks the editor or the export (--json for tools)
bun bin/composive.ts frame example --at 2         # one frame as PNG (in projects/example/preview/frames), as the export draws it
bun bin/composive.ts frame example --sheet 12     # 12 frames in one image, with time labels
```

Projects live in `projects/`; a bare name like `example` means `projects/example` (a path works too).
Without a project (`composive dev`), a menu lists `projects/` (last edited first): type to search,
`Up`/`Down` to move, `Enter` to open, `Esc` to cancel.
`example` is a small demo.

## Check a project

`composive check <project>` reads the files (no server, no browser) and lists problems by file. Exit code 1
when there is an error, so a script or an AI can run it after each edit. `--json` prints
`{ project, errors, warnings, issues: [{ level, file, at, msg }] }` (`at` = track and clip, e.g. `V1 clip 2 (c1)`).

- Errors (the editor or the export breaks): invalid JSON, a missing `src`, template or transition type, an
  unsupported file type, clips that overlap on a track, a bad `start` / `duration` / `offset` / `volume`, an
  audio file on a video track (or an HTML clip or image on an audio track), a scene track id that starts with
  `G`, two tracks with one id, a bad transition `ease` / `dir` / `color`, unsorted keys or a bad key `ease`,
  an HTML clip that never sets `window.seek`, `composive.clip` without `/lib/composive.js`, `timeline`
  without GSAP.
- Warnings (it plays, but likely not as meant): a clip longer than its media (ffprobe), a prop or key not in
  the clip's defaults (a typo), keys that mix numbers and colors, a transition cut short by the clip or scene
  length, a scene folder name that is skipped, an empty scene, a `link` with one clip, a `range` after the end;
  in HTML clips: timers or `requestAnimationFrame`, `gsap.to()` outside `tl`, `Math.random` / `Date.now`
  (each export worker loads the page on its own, so frames can differ), CSS `translate` / `scale` / `rotate`
  with GSAP, files loaded from the internet.

The HTML checks read the source text, so they can miss a problem or flag code that is fine.

## Look at frames

`composive frame <project>` draws frames with the export renderer (Chrome, no editor), so they are the frames
the export writes. It takes a few seconds; no `dev` server is needed.

- Files go to `<project>/preview/frames/` (not in git, not in Media, no live reload), named
  `<scene or video>-<time>s.png`, e.g. `video-2.5s.png`, `001-hook-1s.png`. `-o f.png` writes there instead
  (several times: `f-<time>s.png` next to it).
- `--at 1,2.5,4`: those times (default 0).
- `--sheet N` (1 to 48): N frames spread from the first to the last frame, in one image about 1600 px wide,
  each labeled with its time (and its scene, for the whole video), named `<scene or video>-sheet.png`.
- `--scene 001-hook`: that scene with the global tracks under it, times from the scene start (as in its
  `timeline.json`). Without it, times are video time.
- After the files it lists what went wrong in the page: a script error in a clip (with its file and line),
  a `seek` that throws (with its time), a file that does not load (404). `--json` prints
  `{ written, times, label, problems }`.

## Export from the editor

The `Export` button (top bar) asks what to export (the whole video, with the in/out range if set, or one scene
with the global tracks under it) and a file name. The server renders it into `<project>/exports/<name>.mp4`
(needs ffmpeg and Chrome, like the CLI). While it runs, the progress shows next to the button and the button
cancels it (the half-written file is deleted). One export at a time; `exports/` is not shown in Media.

## Import media

Files are copied into `<project>/media` and appended to the end of the matching track, sorted by file name.

- Editor: drop files or a folder on the window, or use the Files / Folder buttons in the sidebar Media tab.
  Each file shows its upload progress there; a failed or unsupported file stays listed with the reason (click to hide).
  The Media tab lists files as a grid (thumbnail, type, duration) with search and a type filter; `+` or double-click adds one.
- CLI: `bun bin/composive.ts import <folder> -p <project-dir>` (reads durations with `ffprobe`; works while `dev` runs).
  The CLI adds the files to the global tracks (the editor adds them to the scene shown).

Supported: mp4, webm, mov, mp3, wav, m4a, ogg, png, jpg, webp. Name clashes become `name-1.ext`.

## Code map (ui/)

```
app.js            startup, shortcuts, live reload
export.js         Export button: dialog, progress, cancel (renders on the server into exports/)
core/             state.js shared state and helpers, history.js undo stacks (one for the project),
                  edit.js every timeline change plus undo/redo and save,
                  project.js scenes <-> one timeline (shared with export)
canvas/           stage.js frame renderer shared with export, viewer.js transport and ui(),
                  gizmo.js selection box, move/scale/rotate and snap guides in the viewer
timeline/         timeline.js drawing and pointer tools, audio.js playback and meter
sidebar/          sidebar.js Scenes/Media tabs, import.js upload and drop
panel/            panel.js right panel (clip form)
index.html, render.html (export page), style.css
```

## Project layout

```
my-project/
  timeline.json                         # fps, size, range, global tracks (ids start with G: GA1 = music)
  scenes/001-hook/timeline.json         # this scene's tracks, times from 0
  scenes/001-hook/<clip>/index.html     # an HTML clip of this scene
  scenes/002-body/...
  media/voice.mp3, clip.mp4, ...        # any media, referenced by path relative to the project
```

A video is a row of scenes. A scene folder name must be `###-slug` (e.g. `001-hook`); other folders in
`scenes/` are skipped with a warning. The number sets the order. A scene starts where the scene before it
ends (the end of its last clip), so a longer scene moves the scenes after it. A scene with a transition
starts earlier, over the end of the scene before (see Scene transitions). Global tracks (music, a voice
over the whole video) are in video time and do not move with the scenes.

Editor: the top bar list switches the scene shown; `+ Scene` makes the next folder (`003-<name>`).
- A scene view shows its tracks on top and the global tracks below a blue line, all in video time (the
  ruler shows video time; the time outside the scene is dimmed). Both can be edited. A scene clip cannot start
  before its scene. `G` on a track header moves the track between this scene and the global tracks.
- `All scenes` shows the whole video: every scene's tracks read-only (named `001-hook/V1`), the global
  tracks editable. New tracks there are global.
- The Scenes tab lists the HTML clips of the scene shown. Undo history is one for the whole project (each step
  holds every timeline.json): an undo works in any view, also for a change made in another scene (the view
  stays; the toast names the other scenes that changed). Outside edits of a timeline.json (the AI) are undoable too.

## Clip contract

An HTML clip is an HTML page that draws itself as a pure function of time:

```html
<meta name="duration" content="4">   <!-- default length when added to the timeline -->
<script>
  window.seek = (t, duration) => { /* draw the frame at local time t (seconds) */ };
</script>
```

No timers or `requestAnimationFrame`: the editor and the exporter both call `seek` for every frame.
Use a transparent `body` background if the scene is an overlay.

### Runtime and GSAP

`/lib/composive.js` (from `lib/`) writes `window.seek` for you: it merges the `<meta name="props">` defaults with
the clip's props, draws the first frame on load, and fades the page. GSAP is served at `/lib/gsap/` (from
`node_modules/gsap/dist`, plugins too); preview and export both work offline. A clip that writes its own
`window.seek` still works.

```html
<script src="/lib/gsap/gsap.min.js"></script>   <!-- only if timeline is used -->
<script src="/lib/composive.js"></script>
<script>
  const el = document.getElementById("title");
  composive.clip({
    update: (p, t, duration) => { el.textContent = p.title; composive.place(el, p); }, // every frame
    timeline: (tl, p, duration) => tl.from(el, { y: 80, opacity: 0, duration: 1 }),   // set to time t each frame
    fadeIn: 0, fadeOut: 0.5,                                                         // seconds, whole page
  });
</script>
```

- Add every tween to `tl`. A tween made with `gsap.to()` outside `tl` runs in real time and breaks the export.
- The timeline is built again when the props or `duration` change, so the timeline can use props. A keyframed
  prop changes every frame and makes a rebuild every frame (slower): set text, colors and position in `update`.
- Never set the same style in `update` and in the timeline.
- `composive.place(el, p)` sets `left`/`top` from `p.x`, `p.y`. To center an element GSAP animates, use
  `gsap.set(el, { xPercent: -50, yPercent: -50 })` in `timeline` (without GSAP: CSS `transform: translate(-50%, -50%)`).
- Never use the CSS `translate`, `scale` or `rotate` properties on an element GSAP animates: GSAP moves them
  into its own transform and they are lost when the timeline is built again (the element jumps).
- Helpers: `composive.range(t, start, len)` (0..1 progress), `composive.ease.in|out|inout|linear`,
  `composive.clamp(v, a, b)`, `composive.props` (the defaults).
- `tl.timeScale()` has no effect (the runtime sets the time). Speed ramps:
  - one tween: a GSAP ease, `ease: "expo.inOut"`;
  - a custom speed curve: load `/lib/gsap/CustomEase.min.js`, then `CustomEase.create("ramp", "M0,0 C0.7,0 0.3,1 1,1")`
    and `ease: "ramp"`;
  - a whole sequence: `tl.add(composive.ramp(inner, 2.5, "power4.inOut"))` plays all of the timeline `inner`
    in 2.5 s along the ease (`inner` is a `gsap.timeline()` made inside `timeline`).

### Props (editable text, colors, position)

A scene can declare parameters with their defaults. The right panel builds a form from them
(string = text box, `#rrggbb` = color picker, number = number box, boolean = checkbox) and the values are stored
per clip in `clip.props`. They arrive as the third argument of `seek`, already merged with the defaults:

```html
<meta name="props" content='{"title":"Hello","color":"#ffffff","x":0.5,"y":0.5}'>
<script>window.seek = (t, duration, props) => { /* use props.title, props.x ... */ };</script>
```

If the defaults contain numeric `x` and `y` (fractions of the frame, 0..1), the scene content can be dragged
in the viewer; the drag writes `props.x` and `props.y`.

### Templates

`"src": "@<slug>"` is a scene from `templates/<slug>/index.html` (in the repo root, shared by all projects).
The clip points to the template, so a template edit changes every clip that uses it; text and colors go in props.
Each template folder is a preview card under "Templates" in the sidebar Scenes tab (label = the page `<title>`): click adds it at the
playhead, drag drops it on the timeline. It goes on the top video track, or on the bottom one with
`<meta name="track" content="bottom">` (a background). Add a folder to add a template; the editor reloads.

- `@text`: `text`, `size`, `color`, `weight`, `font`, `x`, `y`
- `@shape`: `color`, `w`, `h` (fractions of the frame), `round` (0 = rectangle, 1 = ellipse), `opacity`, `x`, `y`
- `@lower` (lower third): `title`, `sub`, `color`, `accent`, `size`, `x`, `y` (top-left corner)
- `@solid` (fills the frame): `color`, `opacity`

## Scene transitions

A scene can have a transition from the scene before it (`transition`) and one at its end (`out`), in its `timeline.json`:

```json
{ "transition": { "type": "push", "duration": 0.5, "ease": "inout", "dir": "left" }, "tracks": [...] }
```

The scene then starts `duration` seconds before the scene before it ends (the two overlap), so the video gets
shorter by that much. During the overlap both scenes play: the scene before keeps running to its end and the
next one runs from its start. `ease`: `linear`, `in`, `out`, `inout` (default). The duration is limited to the
length of both scenes.

- `transition` on the first scene, or with `"only": true`: no overlap, it plays over the start of this scene
  alone (e.g. a fade in from black at the start of the video).
- `out`: plays over the end of this scene alone (its in style, backwards; e.g. a fade out to black at the end).
  Not used when the next scene has a `transition` that is not `only` (one transition per seam).
- "All scenes" and the export of the whole video show the full transition. A scene view (and `export --scene`)
  has only that scene, so it shows its half over black (the next scene coming in, or this one going out).
- The scene after is on top of the scene before. Global tracks stay under both and do not move.
- Audio clips of the next scene start earlier too, as the scene does.
- One motion per seam. A scene that animates its own exit (content flies out, fades out) and a transition at
  the same time look wrong. With a transition after a scene, let its content hold to the end; with a
  transition into a scene, start its content animation after the transition shows it (from about
  `duration / 2`; with `cover`, `dip` and `flash` the next scene shows from the middle). A scene that already
  ends with its own exit motion needs at most a short `flash`, or no transition.

Types are files in `transitions/` (repo root, shared by all projects, served at `/tr/`): `fade`, `push`, `slide`,
`wipe`, `iris`, `zoom`, `blur`, `dip` (through a color, default black), `flash` (a short bright burn, default white),
`cover` (a color panel crosses the frame). `push`, `slide`, `wipe` and `cover` take `dir`: `left`, `right`, `up`,
`down` (where it moves); `dip`, `flash` and `cover` take `color` (`#rrggbb`). Add a file to add a type; the editor reloads:

```js
// transitions/<type>.js. p = eased progress 0..1, x = the scene's transition object (dir and any other field).
export const dirs = ["left", "right"];            // optional: the editor shows a direction menu
export const color = "#000000";                   // optional: the editor shows a color picker (this is the default)
export default (p, x) => ({
  a: { transform: `scale(${1 + p})` },            // CSS of the scene before (keys as in element.style)
  b: { opacity: p },                              // CSS of the next scene
  over: { background: x.color ?? color, opacity: 1 - Math.abs(2 * p - 1) }, // optional: a layer over both
});
```

The style is set on a box that holds all layers of one scene; outside the overlap it is removed.

## Clip transitions

A clip on a video track can have `in` and `out` (same object as a scene transition):

```json
{ "src": "media/b.mp4", "start": 4, "duration": 3, "in": { "type": "wipe", "duration": 0.6, "dir": "left" } }
```

- `in` at a cut (the clip before on the same track ends where this one starts): the transition between the
  two clips. It is centered on the cut and the clips do not move: the clip before plays on for half the
  duration and this clip starts half the duration early. A video uses its source frames there. An HTML clip
  before it plays on past its end (its `seek` gets t > duration); an HTML clip after it holds its first frame.
  A clip that fades itself out at its end shows nothing there, so leave the fade to the transition.
- `in` with no clip before it, or with `"only": true`: plays over the first `duration` seconds of this clip
  alone, over the tracks under it (at a cut: the clip before ends with a hard cut, or with its own `out`).
- `out`: plays over the last seconds of the clip alone (the `in` style, backwards). Not used when the next
  clip's `in` uses the same cut (an `in` that is not `only`). Split keeps `in` on the left part and `out` on the right part.

## Transitions in the editor

- The Scenes bar under the ruler shows a block per scene (double-click: open it) and the scene transitions on
  the seams. Clip transitions show over the clips of their track.
- Drag a card from Transitions (sidebar, Scenes tab; hover plays a preview) onto the timeline. On a cut between
  two clips or a seam in the Scenes bar (8 px around it): the transition between the two. On the left half of a
  clip or scene block: `in`, of that one alone (`only`) when there is one before it. On the right half: `out`.
  The line shows where it goes. The panel's "only this clip / scene" box switches an `in` between the two kinds.
- Click a transition block to select it: the right panel sets type, duration, easing and direction. Drag the
  block to change its duration. `Delete`, right-click or the panel's Delete removes it. A click on a Transitions
  card gives the selected transition that type.

## timeline.json

`timeline.json` (global) and `scenes/<slug>/timeline.json` (a scene: `tracks`, `markers` and `transition`) use the same
track and clip format:

```json
{ "fps": 30, "width": 1920, "height": 1080,
  "tracks": [
    { "id": "GA1", "type": "audio", "clips": [{ "src": "media/vo.mp3", "start": 0, "duration": 5, "offset": 0, "fadeIn": 0.5, "fadeOut": 1, "volume": 1 }] }
  ] }
```
```json
{ "tracks": [
    { "id": "V1", "type": "video", "clips": [{ "src": "scenes/001-hook/title/index.html", "start": 1, "duration": 3 }] }
  ] }
```

- Track order is layer order: the first track is on top.
- `offset`: seconds skipped at the start of the source. For a scene it is added to `t` passed to `seek`.
- `total`: set by split, so a scene keeps receiving its original `duration` after being cut.
- Clip `id` is optional; the editor adds one.
- `keys`: keyframes, `{ "x": [{ "t": 0, "v": 0.2 }, { "t": 2, "v": 0.8, "ease": "out" }] }`. `t` is clip-local time
  (the time a scene's `seek` gets, `offset` included), so keys stay on the content when the clip moves, is trimmed
  or split. Numbers and `#rrggbb` colors blend between keys; `ease` (from that key to the next): `linear`
  (default), `in`, `out`, `inout`, `hold`. Before the first key and after the last, their value holds.
- Video and image clips have `props` too: `x`, `y` (center, fractions of the frame, default 0.5), `scale` (1),
  `sx`, `sy` (stretch width / height on top of scale, 1), `rotation` (degrees, 0), `opacity` (0..1, 1).
  Preview and export both apply them.

## Editor

Tools: View `V` (select, move, trim edges, drag fade handles), Pan `H`, Cut `X` (click a clip to delete it),
Split `S` (click a clip to split at that point). `Ctrl+wheel` zooms, `\` zooms to fit.

Timeline:
- Click the ruler to seek. Click an empty track area to seek and deselect; drag there to box-select.
  `Shift`+click adds or removes a clip; dragging one selected clip moves the whole selection.
  Up or down, the selection moves by the same number of tracks as the held clip (a linked sound moves over
  audio tracks); it stops at the first or last track and does not go onto a locked track.
- Moves and trims snap to the playhead and to clip edges (yellow line); hold `Alt` to snap to frames only.
- Overwrite `W` (toolbar toggle), off: clips never overlap on a track. A clip moved (or dropped from the
  sidebar) onto a used spot goes to a new track next to it (above for video, below for audio); trims stop at
  the next clip; paste and duplicate go to the nearest free spot. On: a clip moved, trimmed, dropped or pasted
  onto another cuts the covered part (trim, split, or remove). Trims always stop at the end of the source file.
- Drag a scene card or a media tile from the sidebar onto the timeline: it lands on that track at that time
  (below the last track: on a new track).
- Markers: `M` adds one at the playhead (stored as `timeline.markers`), `Shift+M` / `Ctrl+Shift+M` go to the
  next / previous one (`Up` / `Down` stop at markers too). On the ruler: click a marker to go there, drag to
  move it (it snaps), double-click for its name and color, `Alt`+click or right-click to delete. Clips snap to markers.
- Magnet `N` (toolbar toggle), on: delete and edge trims close the gap (ripple), the clips after follow; a
  clip moved to another track leaves no gap behind. Off: gaps stay. Hold `Shift` to do the other way.
  Magnet and Overwrite stay as set after a reload.
- Paste, duplicate and panel edits of `start` / `duration` follow the same rule as a drop.
- `Space` play/pause, `J` play backward (no sound), `K` pause, `L` play. `Left`/`Right` step a frame
  (`Shift` = 1 s), `Up`/`Down` jump to the previous/next clip edge, `Home`/`End` go to start/end.
- `Delete` removes the selection (gap stays, or closes with Magnet on); `Shift+Delete` does the other way.
- `Ctrl+C` / `Ctrl+X` / `Ctrl+V` copy, cut, paste at the playhead; `Ctrl+D` duplicates after the selection;
  `Ctrl+A` selects all.
- Tracks: `+ Video` / `+ Audio` (top-left corner) add one. The track header shows the name (double-click
  to rename), `M` mute and `S` solo (audio), eye = hide (video), lock = no edits, `×` deletes the track
  with its clips; drag a header up or down to reorder. Hide, mute and solo apply to preview and export.
- A video with sound gets its sound as a linked clip on an audio track (name underlined). Linked clips select,
  move, trim, split and delete together; hold `Alt` to act on one only. `Ctrl+L` links the selection or
  unlinks it. In `timeline.json` linked clips share a `link` id; a clip on an audio track always plays as
  audio, also when its `src` is a video file.
- `I` / `O` set the export range in / out at the playhead (blue band in the ruler, stored in video time as `range` in the global `timeline.json`);
  `Alt+X` clears it. The export renders only that range, and playback started before the out marker stops there.
`Ctrl+Z` undo, `Ctrl+Shift+Z` or `Ctrl+Y` redo (100 steps; one drag is one step; an outside edit of `timeline.json` is undoable too).

Keyframes: in the right panel, `◆` next to a number or color prop adds a keyframe at the playhead (filled =
a key here, yellow outline = the prop is animated; click a filled one to remove it). Once a prop has keys, a
change at the playhead (panel field, label drag, canvas move/scale/rotate, arrow keys) sets or adds the key
there. On a key, a menu sets its easing. On the timeline, `◆` marks show key times on the clip: click to go
there, drag to move them, `Alt`+click or right-click to delete. `Shift+K` / `Ctrl+Shift+K` go to the next /
previous keyframe of the selected clips (or of all clips).

Right panel: drag a number field's label left or right to change it (`Shift` faster, `Alt` finer). With
several clips selected, an edit applies to all of them (`start` moves them all by the same amount); props show
when every selected clip has them. The Track section renames the main clip's track and sets mute, solo, hide
and lock. The trash button in the timeline toolbar removes empty tracks.

Canvas: click a clip in the viewer to select it (a blue box shows it), drag to move. Corner handles scale, side
handles stretch the width or height (shape `w`/`h`, video/image `sx`/`sy`), and the round handle rotates
(`Shift` = 15° steps). A resize keeps the opposite corner or side in place: hold `Alt` to resize from the
center, `Shift` on a side handle to keep the ratio. Double-click text in a scene (`@text`, the `@lower`
title and sub, or any scene text that shows a string prop as is) to edit it on the canvas: `Enter` or a click
outside saves, `Shift+Enter` adds a line, `Esc` cancels. Moves snap to the frame center and edges (pink guide); hold `Alt` to
not snap. Click empty space or press `Esc` to deselect. After a click in the viewer, the arrow keys move the
selected clip 1 px (`Shift` = 10 px); after a click in the timeline they step frames.

## Known limits

- The server checks if a video has sound (`ffprobe`); its sound is then decoded whole in the browser for the
  waveform and playback, so very large videos load slowly.
- Export renders PNG frames through Chrome, so it is slow for long timelines.
- Undo history lives in the browser tab and is lost on reload; keep `timeline.json` in git.
- Global video tracks (e.g. a logo) are always below the scene tracks (under them in the frame).
- Solo on one audio track mutes every other audio track of the whole video, also in other scenes.
