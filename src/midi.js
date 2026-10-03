const textDecoder = new TextDecoder("latin1");

function fail(message) {
  throw new Error(`MIDI: ${message}`);
}

function u16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function vlq(bytes, cursor) {
  let value = 0;
  for (let count = 0; count < 4; count += 1) {
    if (cursor.offset >= bytes.length) fail("truncated variable-length value");
    const octet = bytes[cursor.offset++];
    value = (value << 7) | (octet & 0x7f);
    if ((octet & 0x80) === 0) return value;
  }
  fail("variable-length value exceeds four bytes");
}

function readBytes(bytes, cursor, length) {
  const end = cursor.offset + length;
  if (end > bytes.length) fail("truncated event data");
  const result = bytes.slice(cursor.offset, end);
  cursor.offset = end;
  return result;
}

function parseTrack(bytes, trackIndex) {
  const cursor = { offset: 0 };
  let tick = 0;
  let runningStatus = null;
  const active = new Map();
  const notes = [];
  const tempoEvents = [];
  const warnings = [];
  let title = "";
  let order = 0;

  const finishNote = (channel, note, endTick) => {
    const key = `${channel}:${note}`;
    const instances = active.get(key);
    if (!instances?.length) {
      warnings.push(`音符 ${midiNoteName(note)} 在 ${endTick} tick 收到无匹配的关闭事件`);
      return;
    }
    const instance = instances.shift();
    notes.push({ ...instance, endTick, track: trackIndex, order: order++ });
    if (!instances.length) active.delete(key);
  };

  while (cursor.offset < bytes.length) {
    tick += vlq(bytes, cursor);
    if (cursor.offset >= bytes.length) break;
    let status = bytes[cursor.offset++];
    if (status < 0x80) {
      if (runningStatus === null) fail(`running status missing at tick ${tick}`);
      cursor.offset -= 1;
      status = runningStatus;
    } else if (status < 0xf0) {
      runningStatus = status;
    }

    if (status === 0xff) {
      const type = bytes[cursor.offset++];
      const length = vlq(bytes, cursor);
      const data = readBytes(bytes, cursor, length);
      if (type === 0x2f) break;
      if (type === 0x03 && !title) title = textDecoder.decode(data).replace(/\0/g, "");
      if (type === 0x51 && data.length === 3) {
        tempoEvents.push({ tick, microsecondsPerQuarter: (data[0] << 16) | (data[1] << 8) | data[2] });
      }
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const length = vlq(bytes, cursor);
      readBytes(bytes, cursor, length);
      warnings.push(`忽略 SysEx 事件（${length} 字节）`);
      continue;
    }

    const command = status >> 4;
    const channel = status & 0x0f;
    const dataLength = command === 0xc || command === 0xd ? 1 : 2;
    const first = bytes[cursor.offset++];
    if (first === undefined) fail(`truncated channel event at tick ${tick}`);
    const second = dataLength === 2 ? bytes[cursor.offset++] : undefined;
    if (dataLength === 2 && second === undefined) fail(`truncated channel event at tick ${tick}`);
    if (command === 0x9 && second > 0) {
      const key = `${channel}:${first}`;
      if (!active.has(key)) active.set(key, []);
      active.get(key).push({ startTick: tick, note: first, velocity: second, channel });
    } else if (command === 0x8 || (command === 0x9 && second === 0)) {
      finishNote(channel, first, tick);
    }
  }

  for (const [key, instances] of active) {
    for (const instance of instances) {
      warnings.push(`音符 ${key} 没有关闭事件，按轨道末尾截断`);
      notes.push({ ...instance, endTick: tick, track: trackIndex, order: order++ });
    }
  }
  return { title, notes, tempoEvents, warnings, endTick: tick };
}

function buildTempoMap(events, division) {
  const changes = [{ tick: 0, microsecondsPerQuarter: 500000 }, ...events]
    .sort((a, b) => a.tick - b.tick)
    .filter((event, index, list) => index === list.length - 1 || event.tick !== list[index + 1].tick);
  const segments = [];
  let previousTick = 0;
  let elapsedMs = 0;
  let tempo = changes[0].microsecondsPerQuarter;
  for (const change of changes) {
    elapsedMs += ((change.tick - previousTick) * tempo) / division / 1000;
    segments.push({ tick: change.tick, startMs: elapsedMs, microsecondsPerQuarter: change.microsecondsPerQuarter });
    previousTick = change.tick;
    tempo = change.microsecondsPerQuarter;
  }
  return (tick) => {
    let selected = segments[0];
    for (const segment of segments) {
      if (segment.tick > tick) break;
      selected = segment;
    }
    return selected.startMs + ((tick - selected.tick) * selected.microsecondsPerQuarter) / division / 1000;
  };
}

export function midiNoteName(note) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  if (!Number.isInteger(note) || note < 0 || note > 127) return "?";
  return `${names[note % 12]}${Math.floor(note / 12) - 1}`;
}

export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 14 || textDecoder.decode(bytes.slice(0, 4)) !== "MThd") fail("missing MThd header");
  const headerLength = u32(bytes, 4);
  if (headerLength < 6 || 8 + headerLength > bytes.length) fail("invalid header length");
  const format = u16(bytes, 8);
  const trackCount = u16(bytes, 10);
  const division = u16(bytes, 12);
  if (![0, 1].includes(format)) fail(`仅支持 MIDI 格式 0/1，当前为 ${format}`);
  if (division & 0x8000) fail("暂不支持 SMPTE 时间格式，请导出 PPQN MIDI");
  if (!division) fail("PPQN division 不能为 0");
  let offset = 8 + headerLength;
  const tracks = [];
  for (let index = 0; index < trackCount; index += 1) {
    if (textDecoder.decode(bytes.slice(offset, offset + 4)) !== "MTrk") fail(`第 ${index + 1} 个轨道缺少 MTrk`);
    const length = u32(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) fail(`第 ${index + 1} 个轨道超出文件长度`);
    tracks.push(parseTrack(bytes.slice(start, end), index));
    offset = end;
  }
  const tempoMap = buildTempoMap(tracks.flatMap((track) => track.tempoEvents), division);
  for (const track of tracks) {
    for (const note of track.notes) {
      note.startMs = tempoMap(note.startTick);
      note.endMs = tempoMap(note.endTick);
      note.durationMs = Math.max(1, note.endMs - note.startMs);
    }
  }
  const title = tracks.find((track) => track.title)?.title || "未命名 MIDI";
  return { format, division, title, tracks, tempoMap };
}

export function compileTracks(project, selectedTracks, { speed = 1, velocityScale = 1 } = {}) {
  if (!(speed > 0)) fail("速度必须大于 0");
  const selected = [...new Set(selectedTracks)].sort((a, b) => a - b);
  const events = selected.flatMap((trackIndex) => project.tracks[trackIndex]?.notes || [])
    .map((note, index) => ({
      id: index,
      startMs: Math.max(0, Math.round(note.startMs / speed)),
      durationMs: Math.max(1, Math.round(note.durationMs / speed)),
      note: note.note,
      noteName: midiNoteName(note.note),
      velocity: Math.max(1, Math.min(127, Math.round(note.velocity * velocityScale))),
      channel: note.channel,
      track: note.track,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.note - b.note || a.track - b.track || a.id - b.id);
  let previousStart = 0;
  for (const event of events) {
    event.deltaMs = event.startMs - previousStart;
    previousStart = event.startMs;
  }
  return events;
}

export function analyzeEvents(events) {
  let maxPolyphony = 0;
  let peakAtMs = 0;
  const changes = events.flatMap((event) => [
    { at: event.startMs, delta: 1 },
    { at: event.startMs + event.durationMs, delta: -1 },
  ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  for (const change of changes) {
    active += change.delta;
    if (active > maxPolyphony) { maxPolyphony = active; peakAtMs = change.at; }
  }
  return {
    count: events.length,
    durationMs: events.reduce((max, event) => Math.max(max, event.startMs + event.durationMs), 0),
    maxPolyphony,
    peakAtMs,
    over32: maxPolyphony > 32,
  };
}
