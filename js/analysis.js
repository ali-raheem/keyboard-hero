// Charting a player's own track: onsets, tempo and beats from decoded audio, then a
// chart built on that grid. DOM-free apart from decodeAudio, which takes an AudioContext.
import { DIFFS, clamp, hashSeed, mulberry32 } from './song.js';

/* =========================================================
   Music analysis: onsets, tempo and beats from a decoded track
   ========================================================= */
const FFT_N = 1024, HOP = 512;

function makeFFT(n) {
  const bits = Math.log2(n), rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  return function (re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

function decodeAudio(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

// Spectral-flux onset envelope in four frequency bands, then tempo, beats and onset peaks.
async function analyseAudio(buffer, onProgress) {
  const sr = buffer.sampleRate, len = buffer.length, chans = buffer.numberOfChannels;
  const mono = new Float32Array(len);
  for (let c = 0; c < chans; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / chans; }

  const fft = makeFFT(FFT_N);
  const win = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_N);
  const nFrames = Math.max(2, Math.floor((len - FFT_N) / HOP) + 1);
  const fr = sr / HOP, binHz = sr / FFT_N;
  const frameT = f => (f * HOP + FFT_N / 2) / sr;   // a frame's flux peaks when the hit sits at the window centre
  const edges = [0, 150, 500, 2000, 8000].map(h => Math.min(FFT_N / 2, Math.round(h / binHz)));
  const maxBin = edges[4];
  const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
  let prev = new Float32Array(maxBin), cur = new Float32Array(maxBin);
  const env = new Float32Array(nFrames), rms = new Float32Array(nFrames);
  const band = [0, 1, 2, 3].map(() => new Float32Array(nFrames));

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP; let e = 0;
    for (let i = 0; i < FFT_N; i++) { const v = mono[off + i] || 0; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    rms[f] = Math.sqrt(e / FFT_N);
    fft(re, im);
    for (let k = 0; k < maxBin; k++) cur[k] = Math.log1p(20 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
    let flux = 0;
    for (let b = 0; b < 4; b++) {
      let sum = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) { const d = cur[k] - prev[k]; if (d > 0) sum += d; }
      band[b][f] = sum; flux += sum;
    }
    env[f] = f === 0 ? 0 : flux;
    const tmp = prev; prev = cur; cur = tmp;
    if ((f & 1023) === 1023) { onProgress(f / nFrames); await new Promise(r => setTimeout(r, 0)); }
  }

  // Normalise the envelope to a robust maximum
  const sorted = Float32Array.from(env).sort();
  const p98 = sorted[Math.floor(sorted.length * 0.98)] || 1;
  for (let f = 0; f < nFrames; f++) env[f] /= p98;
  const bandMean = band.map(arr => { let m = 0; for (const v of arr) m += v; return m / nFrames; });

  const { period, bpm } = estimateTempo(env, fr);
  const beatFrames = trackBeats(env, period);
  const duration = len / sr;
  let beats = beatFrames.map(frameT);
  const iv = 60 / bpm;
  if (beats.length < 2) { beats = []; for (let t = 0; t < duration + iv; t += iv) beats.push(t); }
  while (beats[0] > 0) beats.unshift(beats[0] - iv);
  while (beats[beats.length - 1] < duration + iv) beats.push(beats[beats.length - 1] + iv);

  // Which beat of four is the downbeat: the phase with the strongest onsets
  const envAt = t => { const f = Math.round((t * sr - FFT_N / 2) / HOP); let m = 0; for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < nFrames) m = Math.max(m, env[k]); return m; };
  const phaseScore = [0, 0, 0, 0];
  beats.forEach((t, k) => { phaseScore[k % 4] += envAt(t); });
  const barPhase = phaseScore.indexOf(Math.max(...phaseScore));

  // Onset peaks: local maxima that rise clearly above their neighbourhood
  const onsets = [];
  const avgW = Math.round(0.1 * fr), delta = 0.07;
  for (let i = 1; i < nFrames - 1; i++) {
    const v = env[i]; if (v <= 0) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(nFrames - 1, i + 1); j++) if (env[j] > v) { isMax = false; break; }
    if (!isMax) continue;
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - avgW); j <= Math.min(nFrames - 1, i + avgW); j++) { sum += env[j]; cnt++; }
    const strength = v - sum / cnt;
    if (strength < delta) continue;
    const o = { f: i, t: frameT(i), strength, bands: [band[0][i], band[1][i], band[2][i], band[3][i]] };
    const last = onsets[onsets.length - 1];
    if (last && i - last.f < 3) { if (strength > last.strength) onsets[onsets.length - 1] = o; continue; }
    onsets.push(o);
  }
  onProgress(1);
  return { fr, bpm, beats, barPhase, onsets, bandMean, rms, duration };
}

// Autocorrelation of the onset envelope with a log-normal prior around 120 bpm
function estimateTempo(env, fr) {
  const N = env.length;
  const minLag = Math.max(1, Math.floor(fr * 60 / 240)), maxLag = Math.min(N - 1, Math.ceil(fr * 60 / 50));
  let mean = 0; for (let i = 0; i < N; i++) mean += env[i]; mean /= N;
  const acs = new Float32Array(maxLag + 1);
  let bestLag = minLag, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < N; i++) sum += (env[i] - mean) * (env[i - lag] - mean);
    const bpm = 60 * fr / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120), 2));
    acs[lag] = sum / (N - lag) * prior;
    if (acs[lag] > best) { best = acs[lag]; bestLag = lag; }
  }
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = acs[bestLag - 1], b = acs[bestLag], c = acs[bestLag + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) lag = bestLag + 0.5 * (a - c) / denom;
  }
  return { period: lag, bpm: 60 * fr / lag };
}

// Dynamic-programming beat tracker (Ellis 2007): beats sit on strong onsets, spaced near the period
function trackBeats(env, period) {
  const N = env.length;
  let mean = 0, sq = 0;
  for (let i = 0; i < N; i++) mean += env[i]; mean /= N;
  for (let i = 0; i < N; i++) sq += (env[i] - mean) * (env[i] - mean);
  const std = Math.sqrt(sq / Math.max(1, N - 1)) || 1;
  const half = Math.max(1, Math.round(period));
  const w = new Float32Array(2 * half + 1);
  for (let i = -half; i <= half; i++) w[i + half] = Math.exp(-0.5 * Math.pow(i * 32 / period, 2));
  const local = new Float32Array(N);
  let maxLocal = 0;
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let j = -half; j <= half; j++) { const k = i + j; if (k >= 0 && k < N) sum += env[k] / std * w[j + half]; }
    local[i] = sum; if (sum > maxLocal) maxLocal = sum;
  }
  const tightness = 100;
  const pmin = Math.max(1, Math.round(period / 2)), pmax = Math.round(period * 2);
  const txwt = new Float32Array(pmax - pmin + 1);
  for (let d = pmin; d <= pmax; d++) txwt[d - pmin] = -tightness * Math.pow(Math.log(d / period), 2);
  const cum = new Float32Array(N), back = new Int32Array(N).fill(-1);
  let firstBeat = true;
  for (let i = 0; i < N; i++) {
    let best = -Infinity, bi = -1;
    for (let d = pmin; d <= pmax; d++) {
      const p = i - d;
      const sc = (p >= 0 ? cum[p] : 0) + txwt[d - pmin];
      if (sc > best) { best = sc; bi = p; }
    }
    cum[i] = local[i] + best;
    if (firstBeat && local[i] < 0.01 * maxLocal) back[i] = -1;
    else { back[i] = bi; firstBeat = false; }
  }
  const maxes = [];
  for (let i = 1; i < N - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxes.push(i);
  if (!maxes.length) return [];
  const vals = maxes.map(i => cum[i]).sort((a, b) => a - b);
  const median = vals[vals.length >> 1];
  let last = maxes[maxes.length - 1];
  for (let k = maxes.length - 1; k >= 0; k--) if (cum[maxes[k]] >= 0.5 * median) { last = maxes[k]; break; }
  const beats = [];
  for (let b = last; b >= 0; b = back[b]) beats.push(b);
  return beats.reverse();
}

const FILE_LEAD = 2.0;   // seconds of empty highway before the track starts

// Build a chart from the analysis: quantise onsets to the beat grid, thin by difficulty, pick lanes by band
function buildFileSong(an, diffKey) {
  const d = DIFFS[diffKey];
  const rnd = mulberry32(hashSeed(an.name + ':' + diffKey));
  const beats = an.beats, beat = 60 / an.bpm;

  const slots = new Map();
  let bi = 0;
  for (const o of an.onsets) {
    while (bi + 1 < beats.length - 1 && beats[bi + 1] <= o.t) bi++;
    const b0 = beats[bi], iv = beats[bi + 1] - b0;
    const q = Math.round((o.t - b0) / iv * 4);
    const key = bi * 4 + q;
    const cand = { t: b0 + q * iv / 4, q: q % 4, strength: o.strength, bands: o.bands, f: o.f };
    const ex = slots.get(key);
    if (!ex || cand.strength > ex.strength) slots.set(key, cand);
  }
  const cands = [...slots.values()].sort((a, b) => a.t - b.t);
  const strengths = cands.map(c => c.strength).sort((a, b) => a - b);
  const pct = p => strengths.length ? strengths[Math.min(strengths.length - 1, Math.floor(p * strengths.length))] : 0;
  const rules = {
    easy:   { pctl: 0.45, grid: [0],          gap: 1.0 },
    medium: { pctl: 0.30, grid: [0, 2],       gap: 0.5 },
    hard:   { pctl: 0.15, grid: [0, 1, 2, 3], gap: 0.25 },
    expert: { pctl: 0.05, grid: [0, 1, 2, 3], gap: 0.25 },
  }[diffKey];
  const thr = pct(rules.pctl), chordThr = pct(0.85);
  const minGap = Math.max(rules.gap * beat, 0.11);

  const notes = [];
  let prevLane = 0, lastT = -Infinity, repeat = 0;
  for (const c of cands) {
    if (!rules.grid.includes(c.q) || c.strength < thr || c.t - lastT < minGap - 1e-3) continue;
    // Lane = the band that jumped most compared with its usual level (kick low, cymbals high)
    const rel = c.bands.map((v, b) => v / (an.bandMean[b] + 1e-6));
    const order = [0, 1, 2, 3].sort((a, b) => rel[b] - rel[a]);
    let raw = order[0];
    if (raw === prevLane && (repeat >= 2 || rel[order[1]] > 0.7 * rel[order[0]])) raw = order[1];
    let lane = Math.round(raw * (d.lanes - 1) / 3);
    if (lane === prevLane && repeat >= 2) lane = clamp(lane + (lane < d.lanes - 1 ? 1 : -1), 0, d.lanes - 1);
    repeat = lane === prevLane ? repeat + 1 : 0;
    let frets = [lane];
    if (d.chord > 0 && c.strength >= chordThr && rnd() < 0.6) {
      let other = Math.round(order[1] * (d.lanes - 1) / 3);
      if (other === lane) other = lane + (lane < d.lanes - 1 ? 1 : -1);
      frets = [Math.min(lane, other), Math.max(lane, other)];
    }
    prevLane = lane; lastT = c.t;
    notes.push({ t: c.t + FILE_LEAD, frets, pitches: [], judged: false, hit: false, dur: 0, f: c.f });
  }

  // Sustains where the track keeps ringing through the gap
  const half = beat / 2;
  const rings = (f, dur) => {
    const a = f + 6, b = Math.min(an.rms.length - 1, f + Math.round(dur * an.fr));
    if (b <= a) return false;
    let peak = 0; for (let k = f; k < Math.min(f + 6, an.rms.length); k++) peak = Math.max(peak, an.rms[k]);
    let sum = 0; for (let k = a; k <= b; k++) sum += an.rms[k];
    return sum / (b - a + 1) >= 0.4 * peak;
  };
  let maxDur = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const next = i + 1 < notes.length ? notes[i + 1].t : n.t + 4.5 * beat;
    const room = Math.floor((next - n.t - half) / half + 1e-9) * half;   // epsilon: 7.9999… must count as 8 half-beats
    if (room >= beat && rnd() < d.sustain && rings(n.f, room)) n.dur = Math.min(room, 4 * beat);
    maxDur = Math.max(maxDur, n.dur);
  }

  return {
    file: true, name: an.name, bpm: Math.round(an.bpm), beat, countIn: 0, countInEnd: FILE_LEAD, lead: FILE_LEAD,
    notes, backing: [], duration: an.duration + FILE_LEAD + 1.0, maxDur,
    lookahead: d.lookahead, lanes: d.lanes,
    beats: beats.map(t => t + FILE_LEAD), barPhase: an.barPhase,
  };
}

export {
  FFT_N, HOP, makeFFT, decodeAudio, analyseAudio, estimateTempo, trackBeats, FILE_LEAD, buildFileSong,
};
