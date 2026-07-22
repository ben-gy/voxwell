import { describe, expect, it } from 'vitest';
import {
  baseName,
  buildFilename,
  extForFormat,
  formatBytes,
  formatClock,
  formatSemitones,
  mimeForFormat,
  sanitizeStem,
} from '../src/format';

describe('formatBytes', () => {
  it('formats each magnitude readably', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(150 * 1024)).toBe('150 KB');
  });

  it('is safe with nonsense input', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
  });
});

describe('formatClock', () => {
  it('formats minutes, seconds and tenths', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(65.3)).toBe('1:05.3');
    expect(formatClock(9.99)).toBe('0:09.9');
  });

  it('clamps negatives and nonsense to zero', () => {
    expect(formatClock(-4)).toBe('0:00.0');
    expect(formatClock(NaN)).toBe('0:00.0');
  });
});

describe('formatSemitones', () => {
  it('signs the value and uses a real minus sign', () => {
    expect(formatSemitones(0)).toBe('0 st');
    expect(formatSemitones(7)).toBe('+7 st');
    expect(formatSemitones(-5)).toBe('−5 st');
  });
});

describe('filenames', () => {
  it('maps formats to extensions and MIME types', () => {
    expect(extForFormat('wav')).toBe('wav');
    expect(extForFormat('mp3')).toBe('mp3');
    expect(mimeForFormat('wav')).toBe('audio/wav');
    expect(mimeForFormat('mp3')).toBe('audio/mpeg');
  });

  it('strips paths and extensions', () => {
    expect(baseName('/tmp/some/voice note.m4a')).toBe('voice note');
    expect(baseName('clip.tar.gz')).toBe('clip.tar');
    expect(baseName('noext')).toBe('noext');
  });

  it('sanitises a stem into something a filesystem will accept', () => {
    expect(sanitizeStem('  hello  world ')).toBe('hello-world');
    expect(sanitizeStem('naughty/../name')).toBe('naughty..name');
    expect(sanitizeStem('emoji 🎤 here')).toBe('emoji-here');
    expect(sanitizeStem('***')).toBe('voice');
    expect(sanitizeStem('')).toBe('voice');
  });

  it('names the export after the source and the preset', () => {
    expect(buildFilename('voice note.m4a', 'Monster', 'wav')).toBe('voice-note-monster.wav');
    expect(buildFilename('voice', 'Radio', 'mp3')).toBe('voice-radio.mp3');
  });
});
