// Small shared helpers: hashing, base64, opaque ids and a deterministic clock.
//
// The entry never reads the wall clock or unseeded randomness for anything it sends: every
// timestamp it stamps on a commit, an issue or a pull request derives from one fixed epoch plus
// a counter, so two runs of the same trial produce the same bytes.

import { createHash } from 'node:crypto';

/** SHA-1 of `data`, lowercase hex. */
export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Standard base64 of UTF-8 text. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Standard base64 of bytes. */
export function b64encodeBytes(data: Buffer): string {
  return data.toString('base64');
}

/** Decode standard base64, tolerating the whitespace GitHub wraps it at. Returns null on bad input. */
export function b64decode(text: string): Buffer | null {
  try {
    return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return null;
  }
}

/** URL-safe base64 without padding, for opaque ids. */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** The fixed epoch every generated timestamp derives from (2025-01-01T00:00:00Z). */
export const EPOCH_SEC = 1_735_689_600;

/**
 * A deterministic clock: each call returns the epoch plus a fresh sequence number, so every
 * stamped object gets a distinct, reproducible time.
 */
export class Clock {
  private seq = 0;

  /** Next timestamp, Unix seconds. */
  nextSec(): number {
    this.seq += 1;
    return EPOCH_SEC + this.seq;
  }

  /** Next timestamp as an ISO string. */
  nextIso(): string {
    return new Date(this.nextSec() * 1000).toISOString();
  }
}

/** The token owner, fixed by the contest's seeded scenario. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The identity string a generated commit or tag carries. */
export function viewerIdentity(clock: Clock): string {
  return `${VIEWER.name} <${VIEWER.email}> ${clock.nextSec()} +0000`;
}
