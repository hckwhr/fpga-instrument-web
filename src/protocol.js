function crc16Ccitt(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function encodePreviewFrames(events, chunkSize = 16) {
  const frames = [`SONG,BEGIN,1,${events.length}`];
  for (let offset = 0; offset < events.length; offset += chunkSize) {
    const chunk = events.slice(offset, offset + chunkSize);
    const payload = chunk.map((event, index) => [offset + index, event.startMs, event.note, event.velocity, event.durationMs].join(",")).join(";");
    const crc = crc16Ccitt(new TextEncoder().encode(payload)).toString(16).padStart(4, "0").toUpperCase();
    frames.push(`SONG,DATA,${offset},${chunk.length},${payload},${crc}`);
  }
  frames.push(`SONG,END,${events.length}`);
  return frames.map((line) => `${line}\n`);
}

export function serializeCsv(events) {
  const lines = ["delta_ms,note,velocity,duration_ms,channel,track"];
  for (const event of events) lines.push([event.deltaMs, event.noteName, event.velocity, event.durationMs, event.channel, event.track].join(","));
  return `${lines.join("\n")}\n`;
}

export function serializeJsonl(events, metadata = {}) {
  return `${JSON.stringify({ type: "header", version: 1, ...metadata })}\n${events.map((event) => JSON.stringify({ type: "note", ...event })).join("\n")}\n`;
}
