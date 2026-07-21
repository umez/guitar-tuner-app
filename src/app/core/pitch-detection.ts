/**
 * Pitch detection via normalized autocorrelation (a simplified YIN estimator).
 *
 * Why not FFT peak-picking? Guitar waveforms are harmonic-rich: the fundamental
 * is often *not* the loudest spectral component, so a naive "find the peak FFT
 * bin" returns an octave (or fifth) error. Autocorrelation finds the waveform's
 * true repetition period regardless of harmonic balance, which is what we want.
 *
 * Pipeline:
 *   1. RMS gate — drop near-silent frames.
 *   2. YIN difference function d(τ) over a plausible period range.
 *   3. Cumulative mean normalized difference d'(τ).
 *   4. Absolute threshold — first dip below 0.10 is the period; fall back to the
 *      global minimum (with a stricter confidence cutoff) if none qualifies.
 *   5. Parabolic interpolation around the dip for sub-sample precision.
 */

export interface PitchResult {
  /** Detected frequency in Hz, or -1 if none could be estimated. */
  freq: number;
  /** 0–1 confidence. Higher = cleaner periodic signal. */
  clarity: number;
}

const RMS_THRESHOLD = 0.008;
/** YIN absolute threshold. Lower = stricter (fewer false positives). */
const YIN_THRESHOLD = 0.10;
/** If no dip clears the threshold, require the global min below this to report. */
const FALLBACK_MAX = 0.30;

/** Plausible guitar fundamental range (low B on a 5-string bass up to flutey highs). */
const MIN_FREQ = 60;
const MAX_FREQ = 1320;

export function detectPitch(buf: Float32Array, sampleRate: number): PitchResult {
  const size = buf.length;

  // --- 1) RMS gate -------------------------------------------------------
  let sumSq = 0;
  for (let i = 0; i < size; i++) sumSq += buf[i] * buf[i];
  const rms = Math.sqrt(sumSq / size);
  if (rms < RMS_THRESHOLD) return { freq: -1, clarity: 0 };

  const minPeriod = Math.floor(sampleRate / MAX_FREQ);
  const maxPeriod = Math.min(Math.floor(sampleRate / MIN_FREQ), (size / 2) | 0);
  if (maxPeriod <= minPeriod) return { freq: -1, clarity: 0 };

  // --- 2) YIN difference function ---------------------------------------
  const yin = new Float32Array(maxPeriod);
  yin[0] = 1;
  for (let tau = 1; tau < maxPeriod; tau++) {
    let sum = 0;
    for (let i = 0; i < maxPeriod; i++) {
      const delta = buf[i] - buf[i + tau];
      sum += delta * delta;
    }
    yin[tau] = sum;
  }

  // --- 3) Cumulative mean normalized difference -------------------------
  let running = 0;
  for (let tau = 1; tau < maxPeriod; tau++) {
    running += yin[tau];
    yin[tau] = running > 0 ? (yin[tau] * tau) / running : 1;
  }

  // --- 4) Absolute threshold (with local-minimum descent) ---------------
  let tauEstimate = -1;
  for (let tau = minPeriod; tau < maxPeriod; tau++) {
    if (yin[tau] < YIN_THRESHOLD) {
      // Walk down to the local minimum of this dip.
      while (tau + 1 < maxPeriod && yin[tau + 1] < yin[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  let clarity: number;
  if (tauEstimate === -1) {
    // Fallback: global minimum in range. Only trust it if reasonably low.
    let minVal = Infinity;
    let minTau = minPeriod;
    for (let tau = minPeriod; tau < maxPeriod; tau++) {
      if (yin[tau] < minVal) {
        minVal = yin[tau];
        minTau = tau;
      }
    }
    if (minVal > FALLBACK_MAX) return { freq: -1, clarity: 0 };
    tauEstimate = minTau;
    clarity = Math.max(0, 1 - minVal);
  } else {
    clarity = 1 - yin[tauEstimate];
  }

  // --- 5) Parabolic interpolation ---------------------------------------
  let betterTau = tauEstimate;
  if (tauEstimate > 0 && tauEstimate + 1 < maxPeriod) {
    const s0 = yin[tauEstimate - 1];
    const s1 = yin[tauEstimate];
    const s2 = yin[tauEstimate + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tauEstimate + (s2 - s0) / denom;
  }

  const freq = sampleRate / betterTau;
  if (!isFinite(freq) || freq < MIN_FREQ || freq > MAX_FREQ) {
    return { freq: -1, clarity: 0 };
  }
  return { freq, clarity };
}
