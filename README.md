# composive

Minimal video editor: HTML scenes + `timeline.json`. An AI edits the files, the browser previews, FFmpeg exports.

```
bun install
bun bin/composive.ts dev example            # editor at http://localhost:9999, live-reloads on file change
bun bin/composive.ts export example -o out.mp4   # needs ffmpeg on PATH and Chrome (or CHROME_PATH)
bun bin/composive.ts export example -o hook.mp4 --scene 001-hook   # one scene, with the global tracks under it
bun bin/composive.ts export example --fast-perf   # 8 Chrome processes render at once (default 4, --low-perf = 1): faster, more CPU and RAM
```

Projects live in `projects/`; a bare name like `example` means `projects/example` (a path works too).
Without a project (`composive dev`), a menu lists `projects/` (last edited first): type to search,
`Up`/`Down` to move, `Enter` to open, `Esc` to cancel.
`example` is a small demo.

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
core/             state.js shared state and helpers, history.js undo stacks (one per scene),
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
ends (the end of its last clip), so a longer scene moves the scenes after it. Global tracks (music, a voice
over the whole video) are in video time and do not move with the scenes.

Editor: the top bar list switches the scene shown; `+ Scene` makes the next folder (`003-<name>`).
- A scene view shows its tracks on top and the global tracks below a blue line, all in video time (the
  ruler shows video time; the time outside the scene is dimmed). Both can be edited. A scene clip cannot start
  before its scene. `G` on a track header moves the track between this scene and the global tracks.
- `All scenes` shows the whole video: every scene's tracks read-only (named `001-hook/V1`), the global
  tracks editable. New tracks there are global.
- The Scenes tab lists the HTML clips of the scene shown. Undo history is kept per scene; it is cleared when
  the global tracks or the scene start changed while another scene was shown.

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

## timeline.json

`timeline.json` (global) and `scenes/<slug>/timeline.json` (a scene: only `tracks` and `markers`) use the same
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
