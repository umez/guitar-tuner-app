/**
 * Tuning presets and note/frequency math.
 *
 * Strings are listed low → high (6th/thickest → 1st/thinnest), matching the
 * left-to-right order of the on-screen pegs.
 */

export interface StringDef {
  /** Display name, e.g. "E", "Eb", "F#". */
  name: string;
  /** MIDI note number — used so calibration (A4) shifts every note correctly. */
  midi: number;
}

export interface Tuning {
  /** Internal id, used as the lookup key. */
  id: string;
  /** Human-readable name shown in the chip. */
  name: string;
  strings: StringDef[];
}

export const TUNINGS: Tuning[] = [
  {
    id: 'standard',
    name: 'Standard',
    strings: [
      { name: 'E', midi: 40 }, { name: 'A', midi: 45 }, { name: 'D', midi: 50 },
      { name: 'G', midi: 55 }, { name: 'B', midi: 59 }, { name: 'E', midi: 64 },
    ],
  },
  {
    id: 'drop_d',
    name: 'Drop D',
    strings: [
      { name: 'D', midi: 38 }, { name: 'A', midi: 45 }, { name: 'D', midi: 50 },
      { name: 'G', midi: 55 }, { name: 'B', midi: 59 }, { name: 'E', midi: 64 },
    ],
  },
  {
    id: 'half_step',
    name: 'Half Step Down',
    strings: [
      { name: 'Eb', midi: 39 }, { name: 'Ab', midi: 44 }, { name: 'Db', midi: 49 },
      { name: 'Gb', midi: 54 }, { name: 'Bb', midi: 58 }, { name: 'Eb', midi: 63 },
    ],
  },
  {
    id: 'drop_c',
    name: 'Drop C',
    strings: [
      { name: 'C', midi: 36 }, { name: 'G', midi: 43 }, { name: 'C', midi: 48 },
      { name: 'F', midi: 53 }, { name: 'A', midi: 57 }, { name: 'D', midi: 62 },
    ],
  },
  {
    id: 'open_g',
    name: 'Open G',
    strings: [
      { name: 'D', midi: 38 }, { name: 'G', midi: 43 }, { name: 'D', midi: 50 },
      { name: 'G', midi: 55 }, { name: 'B', midi: 59 }, { name: 'D', midi: 62 },
    ],
  },
  {
    id: 'open_d',
    name: 'Open D',
    strings: [
      { name: 'D', midi: 38 }, { name: 'A', midi: 45 }, { name: 'D', midi: 50 },
      { name: 'F#', midi: 54 }, { name: 'A', midi: 57 }, { name: 'D', midi: 62 },
    ],
  },
  {
    id: 'dadgad',
    name: 'DADGAD',
    strings: [
      { name: 'D', midi: 38 }, { name: 'A', midi: 45 }, { name: 'D', midi: 50 },
      { name: 'G', midi: 55 }, { name: 'A', midi: 57 }, { name: 'D', midi: 62 },
    ],
  },
];

export const DEFAULT_TUNING_ID = 'standard';

/** Note names using sharps (canonical for guitar). */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Default reference pitch (A4 in Hz). */
export const DEFAULT_A4 = 440;
