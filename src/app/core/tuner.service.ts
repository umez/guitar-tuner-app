import { Injectable, computed, signal } from '@angular/core';
import { TUNINGS, DEFAULT_TUNING_ID, DEFAULT_A4, type Tuning } from './tunings';
import { freqToNote, midiToFreq, type NoteInfo } from './pitch-math';
import { detectPitch } from './pitch-detection';

/**
 * Shape of a single rendered tuning reading — what the UI binds to.
 * Pre-computed here so the template stays declarative.
 */
export interface TunerReading {
  noteLetter: string;
  noteAccidental: string;
  octave: number;
  freq: number;
  idealFreq: number;
  cents: number;
  /** -1 (flat) | 0 (in tune) | 1 (sharp) — drives color theming. */
  state: -1 | 0 | 1;
  /** True when within ±5 cents — used for the green "locked" highlight. */
  inTune: boolean;
  /** Index of the matched string in the active tuning, or null. */
  matchedString: number | null;
}

/** States the microphone can be in. */
export type MicStatus =
  | 'idle'
  | 'requesting'
  | 'listening'
  | 'denied'
  | 'unavailable'
  | 'in-use'
  | 'error';

const SILENCE_HOLD_FRAMES = 8; // hold the last reading briefly during quiet gaps
const CLARITY_MIN = 0.5;
const RECENT_MAX = 7; // rolling-median window
const SMOOTH_CENTS = 0.45; // weight of new sample (0..1); lower = smoother
const SMOOTH_FREQ = 0.4;
const IN_TUNE_CENTS = 5;

/**
 * Owns the Web Audio pipeline and exposes reactive state via signals.
 *
 * The detection loop runs in an `ngZone`-free context (rAF + raw signals) so
 * frequent per-frame updates never trigger Angular change detection; the UI
 * reads the signals through an `effect`, decoupling render rate from detection.
 */
@Injectable({ providedIn: 'root' })
export class TunerService {
  // ---- Configuration --------------------------------------------------
  private readonly _a4 = signal(DEFAULT_A4);
  /** Reference pitch A4 in Hz (435–445 calibration). */
  readonly a4 = this._a4.asReadonly();

  private readonly _tuningId = signal(DEFAULT_TUNING_ID);
  /** Active tuning id. */
  readonly tuningId = this._tuningId.asReadonly();

  /** Active tuning object (derived). */
  readonly tuning = computed<Tuning>(() => {
    const id = this._tuningId();
    return TUNINGS.find((t) => t.id === id) ?? TUNINGS[0];
  });

  /** Index of the manually-selected string, or null for auto-detect. */
  private readonly _manualString = signal<number | null>(null);
  readonly manualString = this._manualString.asReadonly();

  // ---- Live state -----------------------------------------------------
  private readonly _reading = signal<TunerReading | null>(null);
  /** Current reading, or null when no reliable pitch is detected. */
  readonly reading = this._reading.asReadonly();

  private readonly _status = signal<MicStatus>('idle');
  /** Current mic status, for the permission / error UI. */
  readonly status = this._status.asReadonly();

  readonly isListening = computed(() => this._status() === 'listening');

  /** Convenience: the currently-detected MIDI note, or null. */
  readonly detectedMidi = computed(() => this._reading()?.noteLetter ? this._reading() : null);

  // ---- Audio internals ------------------------------------------------
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;

  // Smoothing buffers (not reactive — internal only)
  private smoothCents = 0;
  private smoothFreq = 0;
  private recentCents: number[] = [];
  private silentFrames = 0;

  // ---- Configuration setters -----------------------------------------

  /** Set calibration A4 (clamped to 435–445). */
  setA4(hz: number): void {
    this._a4.set(Math.max(435, Math.min(445, Math.round(hz))));
  }

  /** Switch the active tuning preset. */
  setTuning(id: string): void {
    if (TUNINGS.some((t) => t.id === id)) {
      this._tuningId.set(id);
      this._manualString.set(null);
    }
  }

  /**
   * Manually pin detection to a specific string, or release with null.
   * Useful when ambient noise or strong overtones confuse auto-detection.
   */
  selectString(index: number | null): void {
    const strings = this.tuning().strings;
    if (index === null || (index >= 0 && index < strings.length)) {
      this._manualString.set(index === this._manualString() ? null : index);
    }
  }

  // ---- Mic lifecycle --------------------------------------------------

  /** Request mic access and begin the detection loop. */
  async start(): Promise<void> {
    if (this._status() === 'listening' || this._status() === 'requesting') return;

    if (!navigator.mediaDevices?.getUserMedia) {
      this._status.set('unavailable');
      return;
    }

    this._status.set('requesting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.handleMicError(err);
      return;
    }

    // Some browsers create the context in a suspended state.
    const Ctor: typeof AudioContext =
      window.AudioContext || (window as any).webkitAudioContext;
    this.audioCtx = new Ctor();
    if (this.audioCtx.state === 'suspended') {
      try { await this.audioCtx.resume(); } catch { /* ignore */ }
    }

    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    // Allocate with an explicit ArrayBuffer so the type narrows to
    // Float32Array<ArrayBuffer> (matches AnalyserNode's signature under TS 5.7+).
    this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.source.connect(this.analyser);
    // Intentionally NOT connecting analyser → destination (no monitor speaker).

    this.smoothCents = 0;
    this.smoothFreq = 0;
    this.recentCents = [];
    this.silentFrames = 0;

    this._status.set('listening');
    this.rafId = requestAnimationFrame(this.tick);
  }

  /** Stop listening and release ALL audio resources. */
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.buffer = null;

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }

    this._reading.set(null);
    this._status.set('idle');
    this.smoothCents = 0;
    this.smoothFreq = 0;
    this.recentCents = [];
  }

  /** Toggle listening. */
  toggle(): void {
    if (this.isListening()) this.stop();
    else this.start();
  }

  private handleMicError(err: unknown): void {
    const name = (err as { name?: string })?.name ?? '';
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        this._status.set('denied'); break;
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        this._status.set('unavailable'); break;
      case 'NotReadableError':
      case 'SecurityError':
        this._status.set('in-use'); break;
      default:
        this._status.set('error');
    }
  }

  // ---- Detection loop -------------------------------------------------

  /** Bound arrow function so rAF preserves `this`. */
  private readonly tick = () => {
    if (!this.analyser || !this.buffer || !this.audioCtx) return;
    this.analyser.getFloatTimeDomainData(this.buffer);

    const { freq, clarity } = detectPitch(this.buffer, this.audioCtx.sampleRate);

    // Gate: silent / noisy frames
    if (freq <= 0 || clarity < CLARITY_MIN) {
      this.silentFrames++;
      if (this.silentFrames > SILENCE_HOLD_FRAMES) {
        this.recentCents = [];
        this.smoothCents = 0;
        this.smoothFreq = 0;
        this._reading.set(null);
      }
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.silentFrames = 0;

    const a4 = this._a4();
    const note = freqToNote(freq, a4);
    if (!note) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }

    // Rolling median of recent cents (robust against transient outliers)
    this.recentCents.push(note.cents);
    if (this.recentCents.length > RECENT_MAX) this.recentCents.shift();
    const med = this.median(this.recentCents);

    // Exponential smoothing → needle motion feels alive, not jittery
    this.smoothCents = this.smoothCents * (1 - SMOOTH_CENTS) + med * SMOOTH_CENTS;
    this.smoothFreq = this.smoothFreq * (1 - SMOOTH_FREQ) + freq * SMOOTH_FREQ;

    this._reading.set(this.buildReading(note, this.smoothFreq, this.smoothCents, a4));
    this.rafId = requestAnimationFrame(this.tick);
  };

  private buildReading(
    note: NoteInfo,
    freq: number,
    cents: number,
    a4: number,
  ): TunerReading {
    const abs = Math.abs(cents);
    const inTune = abs < IN_TUNE_CENTS;
    const state: -1 | 0 | 1 = inTune ? 0 : cents < 0 ? -1 : 1;

    // Match to a string: pinned if manual, else nearest by MIDI within ±3 semis.
    let matchedString: number | null = null;
    const strings = this.tuning().strings;
    const manual = this._manualString();
    if (manual !== null) {
      matchedString = manual;
    } else {
      let best = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < strings.length; i++) {
        const d = Math.abs(strings[i].midi - note.midi);
        if (d < best) { best = d; bestIdx = i; }
      }
      matchedString = best <= 3 ? bestIdx : null;
    }

    // When a string is manually pinned, idealFreq is that string's target.
    const idealFreq =
      manual !== null ? midiToFreq(strings[manual].midi, a4) : note.idealFreq;

    return {
      noteLetter: note.letter,
      noteAccidental: note.accidental,
      octave: note.octave,
      freq,
      idealFreq,
      cents,
      state,
      inTune,
      matchedString,
    };
  }

  private median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}
