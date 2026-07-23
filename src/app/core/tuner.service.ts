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
const VOLUME_MIN = 0.005; // RMS threshold — lowered for quieter high-string signals on mobile mics
const CLARITY_MIN = 0.3;
const RECENT_MAX = 7; // rolling-median window
const SMOOTH_CENTS = 0.15; // weight of new sample (0..1); lower = smoother
const SMOOTH_FREQ = 0.12;
const IN_TUNE_CENTS = 5;
const FRAME_SKIP = 2; // emit reading to signal every N frames (throttle)
const TUNED_FRAMES_REQUIRED = 15; // consecutive in-tune readings (~500ms at 30 fps) before marking string as tuned

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

  // ---- Tuned string tracking ------------------------------------------
  private readonly _tunedSet = signal<Set<number>>(new Set());
  /** Set of string indices that have been held in-tune for a sustained period. */
  readonly tunedSet = this._tunedSet.asReadonly();
  private tunedCounters: number[] = [];

  /** Convenience: the currently-detected MIDI note, or null. */
  // readonly detectedMidi = computed(() => this._reading()?.noteLetter ? this._reading() : null);

  // ---- Audio internals ------------------------------------------------
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;

  // Smoothing buffers (not reactive — internal only)
  private smoothCents = 0;
  private smoothFreq = 0;
  private recentCents: number[] = [];
  private silentFrames = 0;
  private frameCount = 0;
  private lockedString: number | null = null;

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
      this.tunedCounters = [];
      this._tunedSet.set(new Set());
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
      // Minimal constraints — Android WebView rejects unknown keys
      // like echoCancellation / channelCount. We process raw audio
      // anyway, so we don't need those browser-level DSP controls.
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

    // Bandpass filter chain — removes rumble and high-frequency noise
    // outside the guitar fundamental range (~80–1400 Hz).
    this.highpass = this.audioCtx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 75;
    this.highpass.Q.value = 0.7;

    this.lowpass = this.audioCtx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 1400;
    this.lowpass.Q.value = 0.7;

    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    // Allocate with an explicit ArrayBuffer so the type narrows to
    // Float32Array<ArrayBuffer> (matches AnalyserNode's signature under TS 5.7+).
    this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.source.connect(this.highpass);
    this.highpass.connect(this.lowpass);
    this.lowpass.connect(this.analyser);
    // Intentionally NOT connecting analyser → destination (no monitor speaker).

    this.smoothCents = 0;
    this.smoothFreq = 0;
    this.recentCents = [];
    this.silentFrames = 0;
    this.lockedString = null;
    this.tunedCounters = new Array(this.tuning().strings.length).fill(0);
    this._tunedSet.set(new Set());

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
    this.highpass?.disconnect();
    this.highpass = null;
    this.lowpass?.disconnect();
    this.lowpass = null;
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
    this.frameCount = 0;
    this.lockedString = null;
    this.tunedCounters = [];
    this._tunedSet.set(new Set());
  }

  /** Toggle listening. */
  toggle(): void {
    if (this.isListening()) this.stop();
    else this.start();
  }

  private handleMicError(err: unknown): void {
    console.warn('[TunerService] mic error:', err);
    const name = (err as { name?: string })?.name ?? '';
    const msg = (err as { message?: string })?.message ?? '';
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        this._status.set('denied'); break;
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        this._status.set('unavailable'); break;
      case 'NotReadableError':
      case 'SecurityError':
      case 'AbortError':
        this._status.set('in-use'); break;
      case 'OverconstrainedError':
      case 'TypeError':
        // Constraints not supported — retry with bare { audio: true }
        this._status.set('error'); break;
      default:
        // On Android WebView, permission denial sometimes arrives as
        // a generic DOMException without a recognised name.
        if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('denied')) {
          this._status.set('denied');
        } else {
          this._status.set('error');
        }
    }
  }

  // ---- Detection loop -------------------------------------------------

  /** Bound arrow function so rAF preserves `this`. */
  private readonly tick = () => {
    if (!this.analyser || !this.buffer || !this.audioCtx) return;
    this.analyser.getFloatTimeDomainData(this.buffer);

    // Volume gate — reject quiet background noise before pitch detection
    let rms = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      rms += this.buffer[i] * this.buffer[i];
    }
    rms = Math.sqrt(rms / this.buffer.length);

    const { freq, clarity } = detectPitch(this.buffer, this.audioCtx.sampleRate);

    // Gate: silent / noisy / quiet frames
    if (freq <= 0 || clarity < CLARITY_MIN || rms < VOLUME_MIN) {
      this.silentFrames++;
      if (this.silentFrames > SILENCE_HOLD_FRAMES) {
        this.recentCents = [];
        this.smoothCents = 0;
        this.smoothFreq = 0;
        this.lockedString = null;
        this.tunedCounters = [];
        this._reading.set(null);
      }
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.silentFrames = 0;

    const a4 = this._a4();
    const strings = this.tuning().strings;

    // --- Lock check on raw frequency (before smoothing) -----------------
    // Only match on the locked string's FUNDAMENTAL — never fold harmonics.
    // Otherwise high E4 (329.6 Hz) looks like the 4th harmonic of low E2
    // and the lock refuses to switch.
    if (this.lockedString !== null) {
      const f0 = midiToFreq(strings[this.lockedString].midi, a4);
      if (Math.abs(12 * Math.log2(freq / f0)) > 3) {
        this.lockedString = null;
        this.recentCents = [];
        this.smoothCents = 0;
        this.smoothFreq = 0;
      }
    }

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

    this.frameCount++;
    if (this.frameCount % FRAME_SKIP === 0) {
      this._reading.set(this.buildReading(note, this.smoothFreq, this.smoothCents, a4));

      // ---- Tuned string tracking ------------------------------------
      const r = this._reading();
      if (r && r.matchedString !== null && r.matchedString < this.tunedCounters.length) {
        if (r.inTune) {
          this.tunedCounters[r.matchedString]++;
          if (this.tunedCounters[r.matchedString] >= TUNED_FRAMES_REQUIRED) {
            const next = new Set(this._tunedSet());
            next.add(r.matchedString);
            this._tunedSet.set(next);
          }
        } else {
          this.tunedCounters[r.matchedString] = 0;
          if (this._tunedSet().has(r.matchedString)) {
            const next = new Set(this._tunedSet());
            next.delete(r.matchedString);
            this._tunedSet.set(next);
          }
        }
      }
    }
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

    // Match to a string: pinned if manual, else honour locked string, else auto-detect.
    let matchedString: number | null = null;
    const strings = this.tuning().strings;
    const manual = this._manualString();
    if (manual !== null) {
      matchedString = manual;
    } else if (this.lockedString !== null) {
      matchedString = this.lockedString;
    }

    if (matchedString === null) {
      let best = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < strings.length; i++) {
        const d = Math.abs(strings[i].midi - note.midi);
        if (d < best) { best = d; bestIdx = i; }
      }
      if (best <= 3) {
        matchedString = bestIdx;
        this.lockedString = bestIdx;
      }
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
