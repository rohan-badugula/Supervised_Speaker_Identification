const elements = {
  audio: document.querySelector("#audio"),
  sourceName: document.querySelector("#source-name"),
  currentTime: document.querySelector("#current-time"),
  duration: document.querySelector("#duration"),
  timeline: document.querySelector("#timeline"),
  timelineProgress: document.querySelector("#timeline-progress"),
  timelineSegments: document.querySelector("#timeline-segments"),
  inValue: document.querySelector("#in-value"),
  outValue: document.querySelector("#out-value"),
  markIn: document.querySelector("#mark-in"),
  markOut: document.querySelector("#mark-out"),
  form: document.querySelector("#label-form"),
  speaker: document.querySelector("#speaker-input"),
  speakerList: document.querySelector("#speaker-list"),
  flag: document.querySelector("#flag-input"),
  notes: document.querySelector("#notes-input"),
  list: document.querySelector("#segment-list"),
  summary: document.querySelector("#speaker-summary"),
  count: document.querySelector("#segment-count"),
  saveButton: document.querySelector("#save-button"),
  exportButton: document.querySelector("#export-button"),
  saveState: document.querySelector("#save-state"),
  toast: document.querySelector("#toast"),
};

const state = {
  annotations: [],
  inPoint: null,
  outPoint: null,
  clipEnd: null,
  dirty: false,
  ffmpegAvailable: false,
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00.000";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${remainder}`;
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${error ? " error" : ""}`;
  window.setTimeout(() => elements.toast.classList.remove("visible"), 3200);
}

function setSaveState(label, mode = "") {
  elements.saveState.querySelector("span").textContent = label;
  elements.saveState.className = `save-state ${mode}`.trim();
}

function markDirty() {
  state.dirty = true;
  setSaveState("UNSAVED CHANGES", "dirty");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function loadProject() {
  try {
    const project = await requestJson("/api/project");
    elements.sourceName.textContent = project.source;
    state.annotations = project.annotations || [];
    state.ffmpegAvailable = project.ffmpegAvailable;
    elements.exportButton.title = state.ffmpegAvailable ? "" : "FFmpeg must be installed before exporting clips.";
    render();
    setSaveState("ALL CHANGES SAVED", "saved");
  } catch (error) {
    setSaveState("LOAD FAILED", "error");
    showToast(error.message, true);
  }
}

function annotationColor(name) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 62% 52%)`;
}

function renderTimeline() {
  elements.timelineSegments.replaceChildren();
  const duration = elements.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  for (const annotation of state.annotations) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `timeline-segment ${annotation.flag}${annotation.included ? "" : " excluded"}`;
    item.style.left = `${(annotation.start / duration) * 100}%`;
    item.style.width = `${Math.max(0.15, ((annotation.end - annotation.start) / duration) * 100)}%`;
    item.style.setProperty("--speaker-color", annotationColor(annotation.speaker));
    item.title = `${annotation.speaker}: ${formatTime(annotation.start)}–${formatTime(annotation.end)}`;
    item.addEventListener("click", () => playSegment(annotation));
    elements.timelineSegments.append(item);
  }
}

function renderSummary() {
  const totals = new Map();
  for (const item of state.annotations) {
    if (item.included && item.flag === "clean") {
      totals.set(item.speaker, (totals.get(item.speaker) || 0) + item.end - item.start);
    }
  }
  elements.summary.replaceChildren();
  for (const [speaker, seconds] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = document.createElement("div");
    row.innerHTML = `<i style="background:${annotationColor(speaker)}"></i><span>${escapeHtml(speaker)}</span><strong>${seconds.toFixed(1)}s</strong>`;
    elements.summary.append(row);
  }
}

function escapeHtml(value) {
  const holder = document.createElement("span");
  holder.textContent = value;
  return holder.innerHTML;
}

function renderList() {
  elements.list.replaceChildren();
  if (!state.annotations.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<span>NO SEGMENTS YET</span><p>Play the recording and mark a clean speaker region.</p>";
    elements.list.append(empty);
    return;
  }

  state.annotations.forEach((annotation, index) => {
    const row = document.createElement("article");
    row.className = `segment-row${annotation.included ? "" : " excluded"}`;
    row.innerHTML = `
      <div class="segment-accent" style="background:${annotationColor(annotation.speaker)}"></div>
      <div class="segment-main">
        <div class="segment-title"><strong>${escapeHtml(annotation.speaker)}</strong><span class="flag ${annotation.flag}">${annotation.flag}</span></div>
        <div class="segment-time">${formatTime(annotation.start)} <i>→</i> ${formatTime(annotation.end)} <b>${(annotation.end - annotation.start).toFixed(1)}s</b></div>
        ${annotation.notes ? `<p>${escapeHtml(annotation.notes)}</p>` : ""}
      </div>
      <div class="segment-actions">
        <button type="button" data-action="play">PLAY</button>
        <label><input type="checkbox" data-action="include" ${annotation.included ? "checked" : ""}/> USE</label>
        <button type="button" data-action="delete">DELETE</button>
      </div>`;
    row.querySelector('[data-action="play"]').addEventListener("click", () => playSegment(annotation));
    row.querySelector('[data-action="include"]').addEventListener("change", (event) => {
      annotation.included = event.target.checked;
      markDirty();
      render();
    });
    row.querySelector('[data-action="delete"]').addEventListener("click", () => {
      state.annotations.splice(index, 1);
      markDirty();
      render();
    });
    elements.list.append(row);
  });
}

function renderSpeakerSuggestions() {
  const names = [...new Set(state.annotations.map((item) => item.speaker))].sort();
  elements.speakerList.innerHTML = names.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
}

function render() {
  elements.count.textContent = String(state.annotations.length);
  renderTimeline();
  renderSummary();
  renderList();
  renderSpeakerSuggestions();
}

function playSegment(annotation) {
  state.clipEnd = annotation.end;
  elements.audio.currentTime = annotation.start;
  elements.audio.play();
}

function updateMarkDisplays() {
  elements.inValue.textContent = state.inPoint === null ? "—" : formatTime(state.inPoint);
  elements.outValue.textContent = state.outPoint === null ? "—" : formatTime(state.outPoint);
}

function markIn() {
  state.inPoint = elements.audio.currentTime;
  if (state.outPoint !== null && state.outPoint <= state.inPoint) state.outPoint = null;
  updateMarkDisplays();
}

function markOut() {
  state.outPoint = elements.audio.currentTime;
  if (state.inPoint !== null && state.outPoint <= state.inPoint) {
    showToast("The out point must be after the in point.", true);
    state.outPoint = null;
  }
  updateMarkDisplays();
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const speaker = elements.speaker.value.trim();
  if (state.inPoint === null || state.outPoint === null) {
    showToast("Mark both an in point and an out point first.", true);
    return;
  }
  if (!speaker) {
    showToast("Enter the speaker name or seat.", true);
    return;
  }
  const flag = elements.flag.value;
  state.annotations.push({
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    start: Number(state.inPoint.toFixed(3)),
    end: Number(state.outPoint.toFixed(3)),
    speaker,
    flag,
    included: flag === "clean",
    notes: elements.notes.value.trim(),
  });
  state.annotations.sort((a, b) => a.start - b.start);
  state.inPoint = null;
  state.outPoint = null;
  elements.notes.value = "";
  updateMarkDisplays();
  markDirty();
  render();
});

async function saveAnnotations(showConfirmation = true) {
  try {
    setSaveState("SAVING…");
    const result = await requestJson("/api/annotations", {
      method: "POST",
      body: JSON.stringify(state.annotations),
    });
    state.dirty = false;
    setSaveState("ALL CHANGES SAVED", "saved");
    if (showConfirmation) showToast(`${result.saved} labels saved`);
  } catch (error) {
    setSaveState("SAVE FAILED", "error");
    showToast(error.message, true);
  }
}

elements.saveButton.addEventListener("click", () => saveAnnotations());
elements.exportButton.addEventListener("click", async () => {
  if (!state.ffmpegAvailable) {
    showToast("Install FFmpeg first: brew install ffmpeg", true);
    return;
  }
  try {
    elements.exportButton.disabled = true;
    elements.exportButton.textContent = "EXPORTING…";
    const result = await requestJson("/api/export", {
      method: "POST",
      body: JSON.stringify(state.annotations),
    });
    state.dirty = false;
    setSaveState("ALL CHANGES SAVED", "saved");
    showToast(`${result.exported} clean enrollment clips exported`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.exportButton.disabled = false;
    elements.exportButton.textContent = "EXPORT CLEAN CLIPS";
  }
});

elements.audio.addEventListener("loadedmetadata", () => {
  elements.duration.textContent = formatTime(elements.audio.duration);
  renderTimeline();
});
elements.audio.addEventListener("timeupdate", () => {
  elements.currentTime.textContent = formatTime(elements.audio.currentTime);
  if (Number.isFinite(elements.audio.duration)) {
    elements.timelineProgress.style.width = `${(elements.audio.currentTime / elements.audio.duration) * 100}%`;
  }
  if (state.clipEnd !== null && elements.audio.currentTime >= state.clipEnd) {
    elements.audio.pause();
    state.clipEnd = null;
  }
});
elements.timeline.addEventListener("click", (event) => {
  if (event.target.closest(".timeline-segment") || !Number.isFinite(elements.audio.duration)) return;
  const rect = elements.timeline.getBoundingClientRect();
  elements.audio.currentTime = ((event.clientX - rect.left) / rect.width) * elements.audio.duration;
});
elements.markIn.addEventListener("click", markIn);
elements.markOut.addEventListener("click", markOut);
document.querySelectorAll("[data-seek]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.audio.currentTime = Math.max(0, Math.min(elements.audio.duration || Infinity, elements.audio.currentTime + Number(button.dataset.seek)));
  });
});
window.addEventListener("keydown", (event) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.code === "Space") {
    event.preventDefault();
    elements.audio.paused ? elements.audio.play() : elements.audio.pause();
  } else if (event.key.toLowerCase() === "i") markIn();
  else if (event.key.toLowerCase() === "o") markOut();
  else if (event.key === "ArrowLeft") elements.audio.currentTime = Math.max(0, elements.audio.currentTime - 1);
  else if (event.key === "ArrowRight") elements.audio.currentTime = Math.min(elements.audio.duration || Infinity, elements.audio.currentTime + 1);
});
window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
});

loadProject();
