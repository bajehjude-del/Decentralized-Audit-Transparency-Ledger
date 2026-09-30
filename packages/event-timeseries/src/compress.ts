/**
 * Lossless columnar compression for contract event series (#430)
 *
 * Timestamps are stored as delta-of-delta zigzag varints, which stay tiny for
 * regularly spaced events. Values are stored as a tag byte followed by either
 * nothing (the value repeats the previous one), a zigzag varint of the integer
 * delta from the previous value, or the raw 8-byte double. The format is
 * lossless and round-trips exactly.
 */

import type { TimeSeriesEvent } from "./types.ts";
import { TimeSeriesError } from "./types.ts";

const TAG_RUN = 0;
const TAG_DELTA_INT = 1;
const TAG_FLOAT = 2;

export interface CompressionStats {
  bytesIn: number;
  bytesOut: number;
  ratio: number;
}

export interface EncodedSeries {
  bytes: Uint8Array;
  count: number;
  stats: CompressionStats;
}

function pushVarint(body: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    body.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  body.push(v);
}

function zigzag(value: number): number {
  return (value << 1) ^ (value >> 31);
}

function unzigzag(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

function pushFloat(body: number[], value: number): void {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  for (const byte of new Uint8Array(buffer)) body.push(byte);
}

function popFloat(bytes: Uint8Array, index: { value: number }): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getFloat64(index.value, true);
  index.value += 8;
  return value;
}

function readVarint(bytes: Uint8Array, index: { value: number }): number {
  let result = 0;
  let shift = 0;
  while (index.value < bytes.length) {
    const byte = bytes[index.value];
    index.value += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
  throw new TimeSeriesError("invalid-argument", "truncated varint in compressed series");
}

/** Compresses a series; input order is preserved. */
export function compressSeries(events: readonly TimeSeriesEvent[]): EncodedSeries {
  const ordered = events.slice().sort((a, b) => a.timestamp - b.timestamp);
  const body: number[] = [];
  pushVarint(body, ordered.length);

  let prevTimestamp = 0;
  let prevDelta = 0;
  let prevValue = 0;

  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i];
    const delta = event.timestamp - prevTimestamp;
    pushVarint(body, zigzag(delta - prevDelta));
    prevDelta = delta;
    prevTimestamp = event.timestamp;

    if (i > 0 && event.value === prevValue) {
      body.push(TAG_RUN);
    } else {
      const deltaValue = event.value - prevValue;
      if (Number.isInteger(deltaValue) && deltaValue >= -2147483648 && deltaValue <= 2147483647) {
        body.push(TAG_DELTA_INT);
        pushVarint(body, zigzag(deltaValue));
      } else {
        body.push(TAG_FLOAT);
        pushFloat(body, event.value);
      }
    }
    prevValue = event.value;
  }

  const bytes = new Uint8Array(body);
  const bytesIn = ordered.length * 16;
  return {
    bytes,
    count: ordered.length,
    stats: { bytesIn, bytesOut: bytes.length, ratio: bytesIn / bytes.length },
  };
}

/** Inflates a series compressed by `compressSeries`. */
export function decompressSeries(encoded: Uint8Array, stream = ""): TimeSeriesEvent[] {
  const index = { value: 0 };
  const count = readVarint(encoded, index);
  const events: TimeSeriesEvent[] = [];

  let timestamp = 0;
  let prevDelta = 0;
  let prevValue = 0;

  for (let i = 0; i < count; i++) {
    const delta = unzigzag(readVarint(encoded, index)) + prevDelta;
    timestamp += delta;
    prevDelta = delta;

    const tag = encoded[index.value];
    index.value += 1;
    let value: number;
    if (tag === TAG_RUN) {
      value = prevValue;
    } else if (tag === TAG_DELTA_INT) {
      value = prevValue + unzigzag(readVarint(encoded, index));
    } else if (tag === TAG_FLOAT) {
      value = popFloat(encoded, index);
    } else {
      throw new TimeSeriesError("invalid-argument", `unknown value tag ${tag}`);
    }
    prevValue = value;
    events.push({ timestamp, stream, value });
  }
  return events;
}