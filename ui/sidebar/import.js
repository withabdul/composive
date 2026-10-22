// Browser import: drop files or a folder on the window, or use the sidebar buttons.
// Each file is uploaded into <project>/media, then appended to the timeline in name order.
import { $, el, MEDIA } from "../core/state.js";
import { addClip } from "../core/edit.js";
import { showTab } from "./sidebar.js";

// One status row per file in the Media tab; returns a setter for its text and state.
function status(name) {
  const row = el("div", "up"), msg = el("b");
  row.append(el("span", "", name), msg);
  row.title = "Click to hide";
  row.onclick = () => row.remove();
  $("#uploads").append(row);
  return (text, state) => {
    msg.textContent = text;
    row.className = "up " + (state || "");
    if (state === "ok") setTimeout(() => row.remove(), 2500);
  };
}

// XHR, not fetch: fetch has no upload progress
const upload = (f, set) => new Promise((resolve, reject) => {
  const x = new XMLHttpRequest();
  x.open("POST", "/api/upload?name=" + encodeURIComponent(f.name));
  x.upload.onprogress = (e) => e.lengthComputable && set(Math.round((e.loaded / e.total) * 100) + "%");
  x.onload = () => (x.status === 200 ? resolve(JSON.parse(x.responseText).path) : reject(new Error(x.responseText || "HTTP " + x.status)));
  x.onerror = () => reject(new Error("network error"));
  x.send(f);
});

async function importFiles(files) {
  showTab("media");
  const all = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const f of all) {
    const set = status(f.name);
    if (!MEDIA.test(f.name)) { set("not supported", "bad"); continue; }
    try {
      set("0%");
      await addClip(await upload(f, set));
      set("done", "ok");
    } catch (e) {
      set(e.message, "bad");
    }
  }
}

const readAll = (reader) => new Promise((resolve, reject) => {
  const out = [];
  const next = () => reader.readEntries((batch) => {
    if (!batch.length) return resolve(out);
    out.push(...batch);
    next();
  }, reject);
  next();
});

async function walk(entry) {
  if (entry.isFile) return [await new Promise((res, rej) => entry.file(res, rej))];
  return (await Promise.all((await readAll(entry.createReader())).map(walk))).flat();
}

const hasFiles = (e) => e.dataTransfer?.types.includes("Files");

addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.add("drop");
});
addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("drop");
});
addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.remove("drop");
  // entries must be read synchronously; the drag data is gone after the first await
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter(Boolean);
  importFiles((await Promise.all(entries.map(walk))).flat());
});

for (const id of ["#impFiles", "#impFolder"]) {
  $(id).onchange = (e) => {
    importFiles(e.target.files);
    e.target.value = "";
  };
}
