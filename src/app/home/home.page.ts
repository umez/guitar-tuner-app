import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonButton,
  IonIcon,
  IonRange,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { micOutline, micOffOutline, stopCircleOutline, settingsOutline } from 'ionicons/icons';

import { TunerService } from '../core/tuner.service';
import { TUNINGS } from '../core/tunings';
import { midiToFreq } from '../core/pitch-math';

/**
 * View-model for one string peg: merges the static tuning data with the live
 * reading-derived state so the template can render each peg declaratively.
 */
interface PegVM {
  index: number;
  name: string;
  targetFreq: number;
  selected: boolean;
  detected: boolean;
  inTune: boolean;
}

@Component({
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButtons,
    IonButton,
    IonIcon,
    IonRange,
  ],
})
export class HomePage implements OnDestroy {
  readonly tuner = inject(TunerService);
  readonly tunings = TUNINGS;

  constructor() {
    addIcons({ micOutline, micOffOutline, stopCircleOutline, settingsOutline });
  }

  // ---- Derived view models -------------------------------------------

  /** The needle rotation in degrees (-90° flat … +90° sharp; ±50¢ → ±90°). */
  readonly needleAngle = computed(() => {
    const r = this.tuner.reading();
    if (!r) return 0;

    return Math.max(-90, Math.min(90, r.cents * 1.8));
  });

  /** CSS class for the dial's color state. */
  readonly dialStateClass = computed(() => {
    const r = this.tuner.reading();
    if (!r) return 'state-idle';
    if (r.inTune) return 'state-green';
    if (Math.abs(r.cents) < 20) return 'state-amber';
    return 'state-red';
  });

  /** CSS class for the big note letter. */
  readonly noteLetterClass = computed(() => {
    const r = this.tuner.reading();
    if (!r) return 'dim';
    if (r.inTune) return 'in-tune';
    if (Math.abs(r.cents) < 20) return 'close';
    return '';
  });

  /** CSS class for the status pill. */
  readonly statusClass = computed(() => {
    const r = this.tuner.reading();
    if (!r) return '';
    if (r.inTune) return 'in-tune';
    if (Math.abs(r.cents) < 20) return 'close';
    return '';
  });

  /** Status pill text under the readout. */
  readonly statusText = computed(() => {
    const status = this.tuner.status();
    const r = this.tuner.reading();
    if (status !== 'listening') return this.idleStatusText(status);
    if (!r) return 'Play a string…';
    if (r.inTune) return 'In tune';
    console.log(r.cents);
    if (Math.abs(r.cents) < 20) return r.cents < 0 ? 'Slightly flat' : 'Slightly sharp';
    return r.cents < 0 ? 'Flat — tighten' : 'Sharp — loosen';
  });

  /** The pegs (per-string view models). */
  readonly pegs = computed<PegVM[]>(() => {
    const tuning = this.tuner.tuning();
    const a4 = this.tuner.a4();
    const reading = this.tuner.reading();
    const manual = this.tuner.manualString();
    return tuning.strings.map((s, i) => ({
      index: i,
      name: s.name,
      targetFreq: midiToFreq(s.midi, a4),
      selected: manual === i,
      detected: reading?.matchedString === i,
      inTune: reading?.matchedString === i && !!reading?.inTune,
    }));
  });

  /** Helpful message under the mic button. */
  readonly micMessage = computed(() => {
    switch (this.tuner.status()) {
      case 'idle': return 'Mic off. Tap the mic to start tuning.';
      case 'requesting': return 'Requesting microphone access…';
      case 'denied': return 'Microphone access was denied. Enable mic permission in your browser or device settings to tune.';
      case 'unavailable': return 'No microphone found. Connect one and try again.';
      case 'in-use': return 'Microphone is in use by another app. Close it and retry.';
      case 'error': return 'Something went wrong accessing the mic. Please try again.';
      case 'listening': return 'Listening — play any string.';
    }
  });

  readonly micMessageTone = computed<'hint' | 'error'>(() => {
    const s = this.tuner.status();
    return s === 'denied' || s === 'unavailable' || s === 'in-use' || s === 'error' ? 'error' : 'hint';
  });

  // Static SVG geometry — pre-computed once.
  readonly dialGeometry = buildDialGeometry();
  /** Tick mark descriptors, rendered with @for in the template. */
  readonly ticks = buildTicks();
  /** Center label position — "0" sits at the top of the arc (0¢ = polar 0° = top). */
  readonly dialCenterX = +(polar(CX, CY, R_INNER - 16, 0).x.toFixed(1));
  readonly dialCenterY = +(polar(CX, CY, R_INNER - 16, 0).y.toFixed(1));

  // ---- Actions -------------------------------------------------------

  onMicToggle(): void {
    this.tuner.toggle();
  }

  onTuningSelect(id: string): void {
    this.tuner.setTuning(id);
  }

  onPegTap(index: number): void {
    this.tuner.selectString(index);
  }

  onCalibChange(ev: CustomEvent): void {
    const v = (ev as CustomEvent<{ value?: number }>).detail?.value;
    if (typeof v === 'number') this.tuner.setA4(v);
  }

  resetCalib(): void {
    this.tuner.setA4(440);
  }

  trackPeg(_: number, p: PegVM): string {
    return `${p.index}-${p.name}`;
  }

  private idleStatusText(status: string): string {
    switch (status) {
      case 'denied': return 'Microphone blocked';
      case 'unavailable': return 'No microphone';
      case 'in-use': return 'Mic busy';
      case 'error': return 'Mic error';
      default: return 'Tap mic to start';
    }
  }

  ngOnDestroy(): void {
  this.tuner.stop();
}
}

/* ----------------------------------------------------------------
   Dial SVG geometry (constant — generated once).
   ---------------------------------------------------------------- */

interface DialGeom {
  body: string;
  zoneRedL: string;
  zoneAmberL: string;
  zoneGreen: string;
  zoneAmberR: string;
  zoneRedR: string;
}

interface TickVM {
  x1: number; y1: number; x2: number; y2: number; width: number;
}

const CX = 200;
const CY = 295;
const R_OUTER = 200;
const R_INNER = 150;

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Half-ring segment between two angles (sweep going clockwise on screen). */
function ringSegment(
  cx: number, cy: number, rOuter: number, rInner: number,
  startDeg: number, endDeg: number,
): string {
  const so = polar(cx, cy, rOuter, startDeg);
  const eo = polar(cx, cy, rOuter, endDeg);
  const si = polar(cx, cy, rInner, endDeg);
  const ei = polar(cx, cy, rInner, startDeg);
  const large = endDeg - startDeg <= 180 ? 0 : 1;
  return (
    `M ${so.x.toFixed(2)} ${so.y.toFixed(2)} ` +
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${eo.x.toFixed(2)} ${eo.y.toFixed(2)} ` +
    `L ${si.x.toFixed(2)} ${si.y.toFixed(2)} ` +
    `A ${rInner} ${rInner} 0 ${large} 0 ${ei.x.toFixed(2)} ${ei.y.toFixed(2)} Z`
  );
}

/** Tick mark positions at every 10 cents from -50 to +50. */
function buildTicks(): TickVM[] {
  const degPerCent = 90 / 50; // 1.8° per cent
  const out: TickVM[] = [];
  for (let c = -50; c <= 50; c += 10) {
    // polar() maps deg=0 → top, deg=90 → right, deg=-90 → left.
    // So cents → angle is simply c * 1.8: 0¢=top, -50¢=left, +50¢=right.
    const ang = c * degPerCent;
    const major = c === 0 || Math.abs(c) === 50;
    const mid = Math.abs(c) === 25;
    const rIn = major || mid ? R_INNER - 6 : R_INNER;
    const o = polar(CX, CY, R_OUTER, ang);
    const i = polar(CX, CY, rIn, ang);
    out.push({
      x1: +o.x.toFixed(1), y1: +o.y.toFixed(1),
      x2: +i.x.toFixed(1), y2: +i.y.toFixed(1),
      width: major ? 2.5 : mid ? 2 : 1.2,
    });
  }
  return out;
}

function buildDialGeometry(): DialGeom {
  const degPerCent = 90 / 50; // 1.8° per cent

  // polar() maps deg=0 → top. Cents → angle: c * 1.8.
  // 0¢ = top, -50¢ = left (-90°), +50¢ = right (+90°).
  const band = (c1: number, c2: number) => {
    const a1 = c1 * degPerCent;
    const a2 = c2 * degPerCent;
    return ringSegment(CX, CY, R_OUTER - 2, R_INNER + 2, Math.min(a1, a2), Math.max(a1, a2));
  };

  return {
    // Top semicircle: from left (-90°) through top (0°) to right (+90°).
    body: ringSegment(CX, CY, R_OUTER, R_INNER, -90, 90),
    zoneRedL: band(-50, -20),
    zoneAmberL: band(-20, -5),
    zoneGreen: band(-5, 5),
    zoneAmberR: band(5, 20),
    zoneRedR: band(20, 50),
  };
}
