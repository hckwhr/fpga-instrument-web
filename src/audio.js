export const AUDIO_TARGET_SAMPLE_RATE = 22050;

export function notesToProject(notes, title = '音频转谱', durationSeconds = Infinity) {
  const clean = notes.filter(n => Number.isFinite(n.startTimeSeconds) &&
    Number.isFinite(n.durationSeconds) && n.durationSeconds > 0 &&
    Number.isFinite(n.pitchMidi) && n.pitchMidi >= 0 && n.pitchMidi <= 127 &&
    Number.isFinite(n.amplitude) && n.amplitude > 0)
    .map((n, order) => {
      const startMs = Math.max(0, Math.round(n.startTimeSeconds * 1000));
      const endMs = Math.round(Math.min(durationSeconds, n.startTimeSeconds + n.durationSeconds) * 1000);
      return { startMs, endMs, durationMs: endMs - startMs, note: Math.round(n.pitchMidi),
        velocity: Math.max(1, Math.min(127, Math.round(n.amplitude * 127))), channel: 0, track: 0, order };
    }).filter(n => n.durationMs > 0).sort((a, b) => a.startMs - b.startMs || a.note - b.note || a.order - b.order);
  return { format: 'audio-transcription', title, tracks: [{ title: '自动转谱（待试听）', notes: clean,
    warnings: ['自动识别可能漏音或多音；未分离乐器、人声和鼓点，未保留弯音。'] }] };
}

export async function transcribeAudioFile(file, { onProgress = () => {}, signal, durationLimit = 30, threshold = 0.35, minNoteMs = 120 } = {}) {
  if (/\.(ncm|qmc\w*|lrc)$/i.test(file?.name || '')) throw new Error('NCM 等专属格式或 LRC 歌词不能转谱，请选择普通 MP3/WAV/FLAC 音频。');
  if (!globalThis.AudioContext || !globalThis.Worker) throw new Error('请使用支持 Web Audio 和 Worker 的新版浏览器');
  if (!file?.size || file.size > 80 * 1024 * 1024) throw new Error('请选择非空且不超过 80 MB 的音频文件');
  if (![30, 0].includes(durationLimit) || ![80, 120, 180].includes(minNoteMs) || !Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.8) throw new Error('转谱参数无效');
  signal?.throwIfAborted();
  onProgress({ stage: 'decode', percent: 0 });
  const context = new AudioContext({ sampleRate: AUDIO_TARGET_SAMPLE_RATE });
  let decoded;
  try { decoded = await context.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('无法解码此音频：请选择可正常播放的 MP3/WAV/FLAC；不能只修改文件后缀。'); }
  finally { await context.close().catch(() => {}); }
  signal?.throwIfAborted();
  if (!durationLimit && decoded.duration > 600) throw new Error('整首转换限 10 分钟，请先裁剪或选择前 30 秒');
  const seconds = Math.min(durationLimit || decoded.duration, decoded.duration);
  if (seconds < 0.1) throw new Error('音频过短，无法识别音符');
  // Native decoding resamples with the browser's anti-alias filter.
  const length = Math.min(decoded.length, Math.floor(seconds * AUDIO_TARGET_SAMPLE_RATE));
  const samples = new Float32Array(length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < length; i++) samples[i] += channel[i] / decoded.numberOfChannels;
  }
  const originalSeconds = decoded.duration;
  decoded = null;
  const notes = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new DOMException('已取消', 'AbortError'));
    const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('模型长时间无响应，请重试或缩短音频')), 120000); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { resetTimeout(); onProgress(data); }
      else if (data.type === 'result') finish(null, data.notes);
      else if (data.type === 'error') finish(new Error(data.message));
    };
    worker.onerror = () => finish(new Error('转谱引擎加载失败，请确认网页和模型资源已完整下载'));
    signal?.addEventListener('abort', abort, { once: true });
    resetTimeout();
    worker.postMessage({ samples, threshold, minNoteMs }, [samples.buffer]);
  });
  signal?.throwIfAborted();
  const partial = originalSeconds > seconds + 0.01;
  const project = notesToProject(notes, `${file.name}${partial ? ' · 前 30 秒' : ''}`, seconds);
  project.audioDurationSeconds = seconds;
  project.partial = partial;
  return project;
}

// Rolling scheduling keeps stop responsive without allocating a whole song's oscillators.
export function createNotePreview() {
  let context, timer, stopCallback;
  const stop = () => {
    clearInterval(timer);
    if (context) void context.close().catch(() => {});
    context = null;
    const done = stopCallback; stopCallback = null; done?.();
  };
  return { stop, async play(events, onEnd = () => {}) {
    stop();
    if (!events.length) throw new Error('没有可试听的音符');
    if (events.length > 50000) throw new Error('音符过多，请简化或选择更短片段');
    context = new AudioContext();
    const active = context;
    try { await active.resume(); } catch (error) { stop(); throw error; }
    if (context !== active) return;
    stopCallback = onEnd;
    const compressor = active.createDynamicsCompressor();
    const master = active.createGain(); master.gain.value = 0.24;
    compressor.connect(master).connect(active.destination);
    const start = active.currentTime + 0.05;
    const end = events.reduce((max, e) => Math.max(max, e.startMs + e.durationMs), 0) / 1000;
    let index = 0;
    const tick = () => {
      while (index < events.length && start + events[index].startMs / 1000 < active.currentTime + 0.2) {
        const note = events[index++];
        const at = Math.max(active.currentTime, start + note.startMs / 1000);
        const until = at + Math.max(0.02, note.durationMs / 1000);
        const osc = active.createOscillator(), gain = active.createGain();
        osc.type = 'triangle'; osc.frequency.value = 440 * 2 ** ((note.note - 69) / 12);
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(note.velocity / 127 * 0.18, at + 0.008);
        gain.gain.linearRampToValueAtTime(note.velocity / 127 * 0.09, until);
        gain.gain.linearRampToValueAtTime(0, until + 0.06);
        osc.connect(gain).connect(compressor);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
        osc.start(at); osc.stop(until + 0.07);
      }
      if (active.currentTime > start + end + 0.2) stop();
    };
    timer = setInterval(tick, 50); tick();
  } };
}
