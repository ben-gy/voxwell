/** Formatting helpers — pure and unit-tested. */

import type { OutputFormat } from './types';

export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let u = 0;
  let n = bytes;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  if (u === 0) return `${Math.round(n)} B`;
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
}

/** Clock time: "0:00.0", "1:05.3". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  const tenths = Math.floor((s * 10) % 10);
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
}

/** A signed semitone label: "+7 st", "0 st", "−5 st". */
export function formatSemitones(value: number): string {
  if (value === 0) return '0 st';
  return `${value > 0 ? '+' : '−'}${Math.abs(value)} st`;
}

export function extForFormat(format: OutputFormat): string {
  return format === 'mp3' ? 'mp3' : 'wav';
}

export function mimeForFormat(format: OutputFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
}

export function baseName(name: string): string {
  const noPath = name.split(/[\\/]/).pop() ?? name;
  const dot = noPath.lastIndexOf('.');
  return dot > 0 ? noPath.slice(0, dot) : noPath;
}

export function sanitizeStem(stem: string): string {
  const cleaned = stem
    .trim()
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'voice';
}

/** e.g. "note-monster.wav" — the preset is in the name so a folder of takes is readable. */
export function buildFilename(source: string, presetName: string, format: OutputFormat): string {
  const stem = sanitizeStem(baseName(source));
  const tag = sanitizeStem(presetName).toLowerCase();
  return `${stem}-${tag}.${extForFormat(format)}`;
}
