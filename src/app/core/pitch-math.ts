/**
 * Note / frequency / cents conversion utilities.
 *
 * All calculations are relative to a configurable A4 reference (default 440 Hz)
 * so the calibration slider shifts the entire note lattice uniformly.
 */

import { NOTE_NAMES } from './tunings';

export interface NoteInfo {
  /** MIDI note number, e.g. 69 for A4. */
  midi: number;
  /** Index 0–11 into NOTE_NAMES. */
  noteIdx: number;
  /** Scientific octave, e.g. A4 → 4. */
  octave: number;
  /** Ideal (in-tune) frequency of this MIDI note, given the current A4. */
  idealFreq: number;
  /** Cents deviation from idealFreq (negative = flat, positive = sharp). */
  cents: number;
  /** Display letter, e.g. "A" or "F" (no accidental). */
  letter: string;
  /** Accidental glyph if the note is a sharp, e.g. "♯". Empty otherwise. */
  accidental: string;
}

/** MIDI → frequency, given the A4 reference in Hz. A4 = MIDI 69. */
export function midiToFreq(midi: number, a4: number): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Convert a raw frequency into the nearest musical note + cents deviation.
 * Returns null if the frequency is outside a plausible guitar range.
 */
export function freqToNote(freq: number, a4: number): NoteInfo | null {
  if (!isFinite(freq) || freq < 60 || freq > 1200) return null;

  const semitones = 12 * Math.log2(freq / a4);
  const midi = Math.round(semitones + 69);
  const noteIdx = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const idealFreq = midiToFreq(midi, a4);
  const cents = 1200 * Math.log2(freq / idealFreq);

  const name = NOTE_NAMES[noteIdx];
  const isSharp = name.length === 2;

  return {
    midi,
    noteIdx,
    octave,
    idealFreq,
    cents,
    letter: isSharp ? name[0] : name,
    accidental: isSharp ? '♯' : '',
  };
}
