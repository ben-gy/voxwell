import { describe, expect, it } from 'vitest';
import { encodeWav, toPcm16 } from '../src/wav';

const ascii = (view: DataView, offset: number, length: number) =>
  Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');

describe('toPcm16', () => {
  it('maps the full-scale range without wrapping', () => {
    const pcm = toPcm16(new Float32Array([0, 1, -1, 0.5, -0.5]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(32767);
    expect(pcm[2]).toBe(-32768);
    expect(pcm[3]).toBe(16384);
    expect(pcm[4]).toBe(-16384);
  });

  it('clamps out-of-range samples instead of wrapping them', () => {
    const pcm = toPcm16(new Float32Array([4, -4, 1.0001, -1.0001]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(32767);
    expect(pcm[3]).toBe(-32768);
  });

  it('turns NaN and Infinity into silence rather than noise', () => {
    const pcm = toPcm16(new Float32Array([NaN, Infinity, -Infinity]));
    expect(Array.from(pcm)).toEqual([0, 0, 0]);
  });

  it('handles an empty buffer', () => {
    expect(toPcm16(new Float32Array(0)).length).toBe(0);
  });
});

describe('encodeWav', () => {
  it('writes a valid mono 16-bit header', () => {
    const buffer = encodeWav(new Float32Array(100), 48000);
    const view = new DataView(buffer);
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(96000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe('data');
  });

  it('sizes the file and both length fields correctly', () => {
    const buffer = encodeWav(new Float32Array(1000), 44100);
    const view = new DataView(buffer);
    expect(buffer.byteLength).toBe(44 + 2000);
    expect(view.getUint32(4, true)).toBe(36 + 2000);
    expect(view.getUint32(40, true)).toBe(2000);
  });

  it('round-trips sample values through the data chunk', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const buffer = encodeWav(samples, 8000);
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16384);
    expect(view.getInt16(48, true)).toBe(-16384);
    expect(view.getInt16(50, true)).toBe(32767);
  });

  it('produces a header-only file for zero samples', () => {
    const buffer = encodeWav(new Float32Array(0), 48000);
    expect(buffer.byteLength).toBe(44);
    expect(new DataView(buffer).getUint32(40, true)).toBe(0);
  });

  it('handles a one-second buffer at 48 kHz', () => {
    const buffer = encodeWav(new Float32Array(48000), 48000);
    expect(buffer.byteLength).toBe(44 + 96000);
  });
});
