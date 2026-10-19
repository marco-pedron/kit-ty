// Speech input of the AI (dictating the split sentence): a WAV file, PCM signed 16-bit, mono,
// 16 kHz, at most 30 s. QVAC hands an in-memory buffer to Whisper as raw samples, with no
// decoding (`audio_format: 's16le'`), so the header is read and stripped here. Anything else is
// refused with a message the UI can show; the browser converts what it records.

export const SPEECH_SAMPLE_RATE = 16_000;
export const MAX_SPEECH_SECONDS = 30;

export type WavPcm =
  { ok: true; pcm: Uint8Array; durationMs: number } | { ok: false; error: string };

const BYTES_PER_SAMPLE = 2;
const tag = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

export function wavToPcm16(wav: Uint8Array): WavPcm {
  const fail = (error: string): WavPcm => ({ ok: false, error });
  if (wav.length < 12 || tag(wav, 0) !== 'RIFF' || tag(wav, 8) !== 'WAVE')
    return fail('the recording is not a WAV file');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let fmt = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = tag(wav, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16) return fail('the WAV format chunk is too short');
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const rate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || bits !== 16) return fail('the recording must be 16-bit PCM');
      if (channels !== 1) return fail(`the recording must be mono, it has ${channels} channels`);
      if (rate !== SPEECH_SAMPLE_RATE)
        return fail(`the recording must be ${SPEECH_SAMPLE_RATE} Hz, it is ${rate} Hz`);
      fmt = true;
    } else if (id === 'data') {
      if (!fmt) return fail('the WAV data comes before its format');
      // a recorder that streams may leave the size unset: take what is there
      const end = Math.min(body + size, wav.length);
      const bytes = end - body - ((end - body) % BYTES_PER_SAMPLE);
      if (bytes === 0) return fail('the recording is empty');
      const durationMs = Math.round((bytes / BYTES_PER_SAMPLE / SPEECH_SAMPLE_RATE) * 1000);
      if (durationMs > MAX_SPEECH_SECONDS * 1000)
        return fail(`the recording is longer than ${MAX_SPEECH_SECONDS} s`);
      return { ok: true, pcm: wav.subarray(body, body + bytes), durationMs };
    }
    at = body + size + (size % 2); // chunks are padded to an even size
  }
  return fail(fmt ? 'the WAV file has no audio data' : 'the WAV file has no format chunk');
}
