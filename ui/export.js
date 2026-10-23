// Export button in the top bar: a dialog picks what (the whole video or one scene) and the file name,
// the server renders it into <project>/exports/. While it runs the button cancels it and the
// progress shows next to it. A reload picks up an export that still runs.
import { $, S, el, toast } from "./core/state.js";
import { saved } from "./core/edit.js";

const btn = $("#exportBtn"), info = $("#exportInfo");
let running = false, timer = 0;

const stamp = (d = new Date(), p = (n) => String(n).padStart(2, "0")) => // local time, e.g. 20261023-1530
  `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;

function setInfo(text, err = false, title = "") {
  info.textContent = text;
  info.title = title || text;
  info.classList.toggle("err", err);
}

function setRunning(on) {
  running = on;
  btn.textContent = on ? "Cancel" : "Export";
  btn.title = on ? "Stop the export (the half-written file is deleted)" : "Export a video to exports/";
}

async function poll() {
  clearTimeout(timer);
  let j;
  try { j = await (await fetch("/api/export")).json(); } catch { j = null; }
  if (!j || j.state === "idle") return setRunning(false);
  if (j.state === "running") {
    setRunning(true);
    setInfo(j.n ? `Exporting ${j.i}/${j.n} (${Math.floor((j.i / j.n) * 100)}%)` : "Exporting: starting...");
    timer = setTimeout(poll, 500);
    return;
  }
  setRunning(false);
  if (j.state === "done") setInfo(`Saved ${j.file}`);
  else if (j.state === "cancelled") setInfo("Export cancelled");
  else { setInfo("Export failed", true, j.error); toast("Export failed: " + j.error.slice(-300)); } // ffmpeg errors are long; the end says why
}

// the dialog: resolves { scene, name, perf } or null on Cancel / Esc / a click outside
function pick() {
  return new Promise((done) => {
    const d = el("dialog", "modal"), box = el("div"), btns = el("div", "mbtns");
    const what = el("select"), name = el("input"), perf = el("select");
    perf.append(new Option("Low: 1 Chrome, least CPU and RAM, slowest", "low"), new Option("Normal: 4 Chromes", "normal"), new Option("Fast: 8 Chromes, most CPU and RAM", "fast"));
    perf.value = "normal";
    what.append(new Option("Whole video (in/out range, if set)", ""));
    for (const s of S.project.scenes) what.append(new Option(`Scene ${s.slug}`, s.slug));
    what.value = S.scene;
    name.value = `${what.value || "video"}-${stamp()}`;
    let edited = false;
    name.oninput = () => (edited = true);
    what.onchange = () => { if (!edited) name.value = `${what.value || "video"}-${stamp()}`; };
    const l1 = el("label", "", "What"), l2 = el("label", "", "File name (in exports/, .mp4)"), l3 = el("label", "", "Speed");
    l1.append(what); l2.append(name); l3.append(perf);
    const no = el("button", "", "Cancel"), yes = el("button", "on", "Export");
    btns.append(no, yes);
    box.append(el("h3", "", "Export video"), l1, l2, l3, btns);
    d.append(box);
    document.body.append(d);
    const close = (v) => { d.close(); d.remove(); done(v); };
    no.onclick = () => close(null);
    yes.onclick = () => name.value.trim() && close({ scene: what.value, name: name.value.trim(), perf: perf.value });
    d.oncancel = (e) => { e.preventDefault(); close(null); }; // Esc
    d.onclick = (e) => { if (e.target === d) close(null); };
    d.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") yes.click(); }; // app shortcuts must not run behind it
    d.showModal();
    name.select();
  });
}

btn.onclick = async () => {
  btn.blur();
  if (running) { await fetch("/api/export", { method: "DELETE" }); return poll(); }
  const p = await pick();
  if (!p) return;
  await saved(); // the server renders what is on disk
  const res = await fetch(`/api/export?scene=${encodeURIComponent(p.scene)}&name=${encodeURIComponent(p.name)}&perf=${p.perf}`, { method: "POST" });
  if (!res.ok) return toast("Could not start the export: " + (await res.text()));
  setInfo("Exporting: starting...");
  poll();
};

poll();
