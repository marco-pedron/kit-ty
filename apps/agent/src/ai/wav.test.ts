import { describe, expect, it } from 'vitest';
import { wavToPcm16 } from './wav.js';

// A WAV built by hand: header fields, optional extra chunk before the data, then the samples.
function wav(o: {
  format?: number;
  channels?: number;
  rate?: number;
  bits?: number;
  samples?: number;
  extra?: boolean;
  dataSize?: number;
}): Uint8Array {
  const samples = o.samples ?? 1600;
  const data = samples * 2;
  const extra = o.extra ? 8 + 3 + 1 : 0; // a 3-byte chunk, padded to 4
  const b = new Uint8Array(12 + 24 + extra + 8 + data);
  const v = new DataView(b.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, b.length - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, o.format ?? 1, true);
  v.setUint16(22, o.channels ?? 1, true);
  v.setUint32(24, o.rate ?? 16_000, true);
  v.setUint16(34, o.bits ?? 16, true);
  let at = 36;
  if (o.extra) {
    put(at, 'LIST');
    v.setUint32(at + 4, 3, true);
    at += 12;
  }
  put(at, 'data');
  v.setUint32(at + 4, o.dataSize ?? data, true);
  for (let i = 0; i < data; i++) b[at + 8 + i] = i % 251;
  return b;
}

describe('wavToPcm16', () => {
  it('strips the header of a 16 kHz mono PCM16 WAV', () => {
    const r = wavToPcm16(wav({ samples: 1600 }));
    expect(r).toMatchObject({ ok: true, durationMs: 100 });
    if (r.ok) {
      expect(r.pcm.length).toBe(3200);
      expect(r.pcm[0]).toBe(0);
      expect(r.pcm[1]).toBe(1);
    }
  });

  it('skips other chunks, padded to an even size', () => {
    expect(wavToPcm16(wav({ extra: true }))).toMatchObject({ ok: true, durationMs: 100 });
  });

  it('takes the samples there are when the data size is unset', () => {
    const r = wavToPcm16(wav({ samples: 800, dataSize: 0xffffffff }));
    expect(r).toMatchObject({ ok: true, durationMs: 50 });
  });

  it.each([
    [{ rate: 44_100 }, /16000 Hz, it is 44100 Hz/],
    [{ channels: 2 }, /mono/],
    [{ bits: 8 }, /16-bit PCM/],
    [{ format: 3, bits: 16 }, /16-bit PCM/],
    [{ samples: 0 }, /empty/],
    [{ samples: 16_000 * 31 }, /longer than 30 s/],
  ])('refuses %o', (o, error) => {
    const r = wavToPcm16(wav(o));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });

  it('refuses what is not a WAV file', () => {
    expect(wavToPcm16(new TextEncoder().encode('OggS not a wav file'))).toMatchObject({
      ok: false,
      error: 'the recording is not a WAV file',
    });
  });
});
