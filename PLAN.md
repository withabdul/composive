# composive plan

Work goes one step at a time. After each step: a manual test guide, then the user tests in the browser.

Decisions already made:
- Audio of a video file: split out automatically into its own audio clip. The pair is linked, with a link/unlink toggle.
- Arrow keys: in the canvas they move the selected clip, in the timeline they step frames (done).
- Keyframes: later, after the other steps.
- Video/image transform must show in the export too (done: preview and export share `stage.js`).

## Done

- [x] Step 1, canvas: video/image props `x`, `y`, `scale`, `rotation`, `opacity`; selection box with scale and
      rotate handles; snap guides to the frame center and edges (`Alt` = no snap); click empty space or `Esc`
      to deselect; arrow-key nudge.
- [x] Sidebar: Scenes / Media tabs, media grid (thumbnail, type, duration), search, type filter, lazy scene thumbnails.
- [x] Upload bug: the server now streams the upload to disk; the UI shows progress and errors per file.

- [x] Folders: `ui/` split by feature (`core/`, `canvas/`, `timeline/`, `sidebar/`, `panel/`).

- [x] Step 2, timeline: magnetic snap (playhead, clip edges), no overlap on a track, trim limits (next clip,
      source end for audio and video), shortcuts (`Ctrl+C/X/V/D/A`, `Home`/`End`, `Shift+Left/Right`,
      `Up`/`Down`, `J`/`K`/`L`, `\`), multi-select (`Shift`+click, box select, group move), ripple delete
      (`Shift+Delete`), in/out export range (`I`/`O`, `Alt+X`), filmstrip on video clips.

- [x] Timeline modes: Magnet `M` (ripple delete and ripple trim; `Shift` = the other way) and
      Overwrite `W` (a clip moved, trimmed or pasted onto another cuts it).

- [x] Performance: the timeline draws only what is on screen (ruler, clips, canvases) and caches canvases;
      a 15 min project (`projects/video-ai-15min`) drags at about 1-2 ms per pointer move.

- [x] Step 3, tracks and audio of video: add (`+ Video` / `+ Audio`), delete, reorder (drag the header),
      rename (double-click); mute, solo, hide, lock (preview and export); a video with sound gets a linked
      audio clip (editor and CLI import); linked clips select, move, trim, split, delete together (`Alt` = one
      only); `Ctrl+L` link/unlink; export mixes the sound of video files.

- [x] Step 4, sidebar: drag to the timeline, automatic new track, presets (`@text`, `@shape`, `@lower`,
      `@solid`; click or drag), cards and tiles cached between redraws, "remove empty tracks" button.
- [x] Step 5, right panel: drag a number label to change it, Track section (name, mute, solo, hide, lock),
      edit several selected clips at once.

- [x] Leftovers: panel start/duration edits follow the overlap rule (when the edit is done); paste and
      duplicate go to a new track like a drop; playback stops at the out marker; Magnet closes the gap a
      clip leaves when it moves to another track; Magnet and Overwrite are kept after reload; a linked pair
      moves across tracks (each clip over tracks of its own type); the server says if a video has sound
      (`/api/probe`, ffprobe); a held arrow key is one undo step; the scene selection box skips hidden
      elements; several selected clips with different values show "mixed".

- [x] Markers: `M` add, `Shift+M` / `Ctrl+Shift+M` next / previous, drag, name and color (double-click),
      delete (`Alt`+click, right-click); clips snap to them. Magnet moved to `N`.
- [x] Fix: a seek while the project still loads its audio no longer throws (stage gets the timeline first).

- [x] Keyframes: `clip.keys` (clip-local time), numbers and colors blend, easing linear / in / out / in-out /
      hold; panel ◆ per prop and easing menu; auto-key from panel, label drag, canvas and arrow keys;
      ◆ marks on timeline clips (click, drag, delete); `Shift+K` / `Ctrl+Shift+K`; preview and export share
      `propsAt()` in stage.js.

- [x] Scenes: `scenes/###-slug/` with its own `timeline.json` and HTML clips (`<clip>/index.html`); the top bar
      switches scenes, `+ Scene` makes one; global tracks (`G` ids) in the root `timeline.json` under every scene;
      "All scenes" view; undo per scene; `export --scene`. `example` moved, `video-ai-15min` removed.

## Now

- [ ] Scenes: test in the browser (switch, edit global from a scene, undo per scene, `+ Scene`, export both ways).
- [ ] Nothing else planned. Ideas: keyframes for audio volume; a graph (curve) editor; keyframes on several clips at once.

## Timeline leftovers

- [ ] Magnet within one track does not reorder clips (no insert edit); a move there is free, as with Magnet off.
- [ ] A video's sound is still decoded whole in the browser for the waveform and playback; huge files load slowly.

## Step 4: sidebar

- [x] Drag a scene or media tile onto the timeline, at a given track and time.
- [x] Automatic new track: a drop (from the sidebar or a clip drag) onto a used spot with Overwrite off
      makes a new track next to it (above for video, below for audio), instead of the nearest free spot.
- [x] Empty tracks: "remove empty tracks" button in the timeline toolbar.
- [x] More presets next to `+ Text`: color solid, shape, lower third.
- [x] Cache media metadata so a sidebar redraw does not reload every video/audio.

## Step 5: right panel

- [x] Drag a field label left/right to change the number.
- [x] Track section: name, mute, solo, lock, hide.
- [x] Link/unlink action for linked clips (done in step 3).
- [x] Edit several selected clips at once.
- [x] Panel leftover: several clips with different values show "mixed".

## Keyframe leftovers

- [ ] With several clips selected the panel has no ◆ (edits still auto-key each animated clip).
- [ ] Text and checkbox props cannot be keyed (they would only switch at a key).
