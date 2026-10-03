import { analyzeEvents, compileTracks, midiNoteName, parseMidi } from "./midi.js";
import { encodePreviewFrames, serializeCsv, serializeJsonl } from "./protocol.js";
import { Transport } from "./transport.js";
import { createNotePreview, transcribeAudioFile } from "./audio.js";

const $ = (selector) => document.querySelector(selector);
const state = { project: null, events: [], selectedTracks: [], audioFile: null, transcription: null };
const fileInput = $("#midi-file");
const audioInput = $("#audio-file");
const preview = createNotePreview();
let audioUrl;
const trackList = $("#track-list");
const status = $("#status");
const diagnostics = $("#diagnostics");
const roll = $("#piano-roll");
const transport = new Transport();
const serialSupported = !!navigator.serial && window.isSecureContext;
const logEntries = [];
function logLink(direction, text) {
  logEntries.push(`${new Date().toLocaleTimeString()} ${direction} ${text.slice(0, 1024)}`);
  if (logEntries.length > 100) logEntries.shift();
  $("#serial-log").textContent = logEntries.join('\n');
}
transport.onStatus(({ state, connected, message }) => {
  $("#connection-state").dataset.connected = String(connected);
  $("#connection-label").textContent = connected ? '串口已连接' : state === 'connecting' ? '正在连接' : '未连接硬件';
  $("#link-status").textContent = message;
  $("#connect").disabled = !serialSupported || state !== 'disconnected';
  $("#disconnect").disabled = !connected;
  $("#send").disabled = !connected;
  $("#baud-rate").disabled = state !== 'disconnected';
  logLink('状态', message);
});
transport.onData((text) => logLink('收到', text));
$("#connect").disabled = !serialSupported;
if (!serialSupported) $("#serial-help").textContent = '当前环境不能连接 HC-05。请在电脑 Chrome/Edge 的 HTTPS 或 localhost 页面使用；安卓浏览器不支持此 SPP 路线，需后续安卓 App。曲谱转换仍可使用。';
$("#connect").addEventListener('click', async () => {
  try { await transport.connect({ baudRate: Number($("#baud-rate").value) }); }
  catch (error) { if (error.name !== 'NotFoundError') $("#link-status").textContent = error.message; }
});
$("#disconnect").addEventListener('click', async () => {
  try { await transport.disconnect(); }
  catch (error) { $("#link-status").textContent = `断开失败：${error.message}`; }
});
$("#send-form").addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const text = $("#send-text").value;
    const size = await transport.sendText(text, { newline: $("#send-newline").checked });
    logLink('发送', text);
    $("#link-status").textContent = `已写入串口 ${size} 字节；尚未确认板端执行。`;
  } catch (error) { $("#link-status").textContent = error.message; }
});
$("#clear-log").addEventListener('click', () => { logEntries.length = 0; $("#serial-log").textContent = '记录已清空。'; });

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function loadProject(project, fileName, message) {
  preview.stop();
  state.project = project;
  state.selectedTracks = project.tracks.map((_, index) => index).filter((index) => project.tracks[index].notes.length);
  $("#song-title").textContent = project.title;
  $("#file-name").textContent = fileName;
  renderTracks();
  compileAndRender();
  setStatus(message, "ok");
}

function download(name, content, type = "text/plain;charset=utf-8") {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderTracks() {
  trackList.replaceChildren();
  state.project.tracks.forEach((track, index) => {
    const label = document.createElement("label");
    label.className = "track-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedTracks.includes(index);
    checkbox.addEventListener("change", () => {
      state.selectedTracks = [...trackList.querySelectorAll("input:checked")].map((input) => Number(input.value));
      compileAndRender();
    });
    checkbox.value = String(index);
    const notes = track.notes.length ? `${track.notes.length} 音符 · ${formatDuration(track.notes.reduce((max, note) => Math.max(max, note.endMs), 0))}` : "无音符";
    label.append(checkbox, document.createTextNode(`轨道 ${index + 1}${track.title ? ` · ${track.title}` : ""}`));
    const meta = document.createElement("small");
    meta.textContent = notes;
    label.append(meta);
    trackList.append(label);
  });
}

function renderDiagnostics(events) {
  const info = analyzeEvents(events);
  $("#note-count").textContent = info.count.toLocaleString();
  $("#duration").textContent = formatDuration(info.durationMs);
  $("#polyphony").textContent = `${info.maxPolyphony} / 32`;
  diagnostics.replaceChildren();
  if (info.over32) {
    const warning = document.createElement("p");
    warning.className = "warning";
    warning.textContent = `峰值同时发声 ${info.maxPolyphony}，超过当前 FPGA 的 32 声部预算；导出仍保留全部音符，上传前必须选择简化策略。`;
    diagnostics.append(warning);
  }
  const warnings = state.project?.tracks.flatMap((track) => track.warnings || []) || [];
  if (warnings.length) {
    const warning = document.createElement("p");
    warning.className = "warning";
    warning.textContent = `曲谱有 ${warnings.length} 条提示：${warnings.slice(0, 2).join("；")}`;
    diagnostics.append(warning);
  }
}

function drawRoll(events) {
  const context = roll.getContext("2d");
  const width = roll.width = roll.clientWidth * devicePixelRatio;
  const height = roll.height = roll.clientHeight * devicePixelRatio;
  context.scale(devicePixelRatio, devicePixelRatio);
  const viewWidth = roll.clientWidth;
  const viewHeight = roll.clientHeight;
  context.fillStyle = "#101827";
  context.fillRect(0, 0, viewWidth, viewHeight);
  if (!events.length) return;
  const minNote = Math.max(0, events.reduce((min, event) => Math.min(min, event.note), 127) - 2);
  const maxNote = Math.min(127, events.reduce((max, event) => Math.max(max, event.note), 0) + 2);
  const duration = Math.max(1, analyzeEvents(events).durationMs);
  const rowHeight = Math.max(4, viewHeight / (maxNote - minNote + 1));
  for (let note = minNote; note <= maxNote; note += 1) {
    if (note % 2 === 0) { context.fillStyle = "#162235"; context.fillRect(0, (maxNote - note) * rowHeight, viewWidth, rowHeight); }
  }
  for (const event of events) {
    const x = (event.startMs / duration) * viewWidth;
    const widthPx = Math.max(2, (event.durationMs / duration) * viewWidth);
    const y = (maxNote - event.note) * rowHeight;
    context.fillStyle = `hsl(${(event.note * 7) % 360} 78% 62%)`;
    context.fillRect(x, y + 1, widthPx, Math.max(2, rowHeight - 2));
  }
  context.fillStyle = "#94a3b8";
  context.font = "12px system-ui";
  context.fillText(`${midiNoteName(minNote)} — ${midiNoteName(maxNote)}`, 12, viewHeight - 10);
}

function compileAndRender() {
  preview.stop();
  const speed = Number($("#speed").value) / 100;
  const velocityScale = Number($("#velocity").value) / 100;
  state.events = state.project ? compileTracks(state.project, state.selectedTracks, { speed, velocityScale }) : [];
  $("#speed-value").textContent = `${Math.round(speed * 100)}%`;
  $("#velocity-value").textContent = `${Math.round(velocityScale * 100)}%`;
  renderDiagnostics(state.events);
  drawRoll(state.events);
  for (const id of ['#preview-notes', '#export-csv', '#export-jsonl', '#export-protocol']) $(id).disabled = !state.events.length;
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    loadProject(parseMidi(await file.arrayBuffer()), file.name, `已解析 ${file.name}，请选择要演奏的音轨。`);
  } catch (error) {
    state.project = null; state.events = [];
    trackList.replaceChildren(); compileAndRender(); setStatus(error.message, "error");
  }
});

audioInput.addEventListener("change", () => {
  const file = audioInput.files?.[0];
  if (!file) return;
  preview.stop();
  state.audioFile = file;
  $("#audio-file-name").textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  $("#audio-progress").textContent = "可先播放原音频，再点击开始转谱。";
  $("#transcribe-audio").disabled = false;
  const source = $("#source-audio");
  source.pause();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(file);
  source.src = audioUrl;
  source.hidden = false;
});

$("#transcribe-audio").addEventListener("click", async () => {
  if (!state.audioFile || state.transcription) return;
  state.transcription = new AbortController();
  const file = state.audioFile;
  preview.stop(); $("#source-audio").pause();
  state.project = null; state.selectedTracks = []; trackList.replaceChildren(); compileAndRender();
  $("#file-name").textContent = '正在转谱'; $("#song-title").textContent = file.name;
  for (const id of ['#audio-file', '#midi-file', '#audio-scope', '#audio-threshold', '#audio-min-note']) $(id).disabled = true;
  $("#transcribe-audio").disabled = true;
  $("#cancel-transcription").disabled = false;
  try {
    const project = await transcribeAudioFile(file, {
      signal: state.transcription.signal,
      durationLimit: Number($('#audio-scope').value),
      threshold: Number($('#audio-threshold').value),
      minNoteMs: Number($('#audio-min-note').value),
      onProgress: ({ stage, percent }) => { $("#audio-progress").textContent = `${{ decode: '解码音频', load: '加载本地转谱模型', model: '识别音符' }[stage]}：${Math.round(percent * 100)}%`; },
    });
    loadProject(project, file.name, project.tracks[0].notes.length ? '转谱完成，请对比原音频和音符试听；浏览器音色不代表 FPGA 实际音色。' : '未识别到音符，可降低识别门槛或更换旋律清晰的音频。');
    $("#audio-progress").textContent = `${project.partial ? '前 30 秒' : '全段'}识别完成：${project.tracks[0].notes.length} 个音符。`;
  } catch (error) {
    setStatus(error.name === "AbortError" ? "已取消音频转谱。" : `音频转谱失败：${error.message}`, error.name === "AbortError" ? "info" : "error");
    $("#audio-progress").textContent = error.name === "AbortError" ? "已取消。" : error.message;
    $('#file-name').textContent = '尚无转谱结果';
  } finally {
    state.transcription = null;
    for (const id of ['#audio-file', '#midi-file', '#audio-scope', '#audio-threshold', '#audio-min-note']) $(id).disabled = false;
    $("#transcribe-audio").disabled = !state.audioFile;
    $("#cancel-transcription").disabled = true;
  }
});
$("#cancel-transcription").addEventListener("click", () => state.transcription?.abort());

$('#preview-notes').addEventListener('click', async () => {
  $('#source-audio').pause();
  if (analyzeEvents(state.events).over32) { setStatus('超过 32 声部，请简化曲谱后试听。', 'error'); return; }
  $('#preview-notes').disabled = true; $('#stop-preview').disabled = false;
  const done = () => { $('#preview-notes').disabled = !state.events.length; $('#stop-preview').disabled = true; };
  try { await preview.play(state.events, done); }
  catch (error) { done(); setStatus(error.message, 'error'); }
});
$('#stop-preview').addEventListener('click', () => preview.stop());
$('#source-audio').addEventListener('play', () => preview.stop());

$("#select-all").addEventListener("click", () => { trackList.querySelectorAll("input").forEach((input) => { input.checked = true; }); state.selectedTracks = state.project?.tracks.map((_, index) => index) || []; compileAndRender(); });
$("#clear-all").addEventListener("click", () => { trackList.querySelectorAll("input").forEach((input) => { input.checked = false; }); state.selectedTracks = []; compileAndRender(); });
$("#speed").addEventListener("input", compileAndRender);
$("#velocity").addEventListener("input", compileAndRender);
$("#export-csv").addEventListener("click", () => state.events.length && download("fpga-song-events.csv", serializeCsv(state.events), "text/csv;charset=utf-8"));
$("#export-jsonl").addEventListener("click", () => state.events.length && download("fpga-song-events.jsonl", serializeJsonl(state.events, { title: state.project?.title || "song", count: state.events.length }), "application/x-ndjson;charset=utf-8"));
$("#export-protocol").addEventListener("click", () => state.events.length && download("fpga-song-upload-preview.txt", encodePreviewFrames(state.events).join("")));

compileAndRender();
setStatus("未加载曲谱。导出文件不会自动发送到设备。", "info");
window.addEventListener('resize', () => drawRoll(state.events));
