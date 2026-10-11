// Seeded song generation, game constants and small helpers. DOM-free, so the tests
// run it under Node.

/* =========================================================
   Utilities
   ========================================================= */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return h >>> 0;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);

/* =========================================================
   Config
   ========================================================= */
const LANES = 4;
const KEYS = ['a', 's', 'd', 'f'];
const LANE_COLORS = ['#37d67a', '#ff5252', '#ffd23f', '#4aa3ff'];
const LANE_NAMES = ['A', 'S', 'D', 'F'];
const STRUM_KEYS = new Set([' ', 'Spacebar', 'Enter', 'ArrowUp', 'ArrowDown']);
const DIFFS = {
  easy:   { label: 'Easy',   lookahead: 2.0, lanes: 3, quarter: 0.85, eighth: 0.00, run: 0.00, chord: 0.00, triple: 0.00, sustain: 0.35 },
  medium: { label: 'Medium', lookahead: 1.7, lanes: 4, quarter: 0.90, eighth: 0.35, run: 0.00, chord: 0.12, triple: 0.00, sustain: 0.28 },
  hard:   { label: 'Hard',   lookahead: 1.5, lanes: 4, quarter: 0.95, eighth: 0.75, run: 0.15, chord: 0.20, triple: 0.03, sustain: 0.22 },
  expert: { label: 'Expert', lookahead: 1.3, lanes: 4, quarter: 1.00, eighth: 0.90, run: 0.40, chord: 0.25, triple: 0.08, sustain: 0.18 },
};
const WINDOW_PERFECT = 0.05;   // seconds either side
const WINDOW_GOOD = 0.12;
const NOTE_SCORE = 50;
const SUSTAIN_PER_BEAT = 25;   // per gem, per beat held, times multiplier
const ROCK_HIT = 0.018, ROCK_MISS = 0.045, ROCK_OVER = 0.02;
const SEED_WORDS = ['midnight', 'neon', 'velvet', 'thunder', 'copper', 'static', 'ember', 'chrome', 'sugar', 'ghost', 'diesel', 'lunar'];
const SEED_NOUNS = ['riff', 'anthem', 'shred', 'solo', 'groove', 'stomp', 'jam', 'encore', 'breakdown', 'chorus'];

/* =========================================================
   Song generation (seeded, procedural)
   ========================================================= */
function generateSong(seed, diffKey) {
  const d = DIFFS[diffKey];
  const rnd = mulberry32(hashSeed(seed.trim().toLowerCase() + ':' + diffKey));
  const bpm = 104 + Math.floor(rnd() * 44);          // 104–147
  const beat = 60 / bpm;
  const countIn = 1, bars = 32;
  const progressions = [
    [45, 45, 41, 43, 45, 45, 48, 43],   // Am Am F G Am Am C G
    [45, 43, 41, 43, 45, 43, 48, 50],
    [45, 48, 43, 41, 45, 48, 50, 43],
    [45, 45, 50, 48, 43, 43, 41, 43],
  ];
  const prog = progressions[Math.floor(rnd() * progressions.length)];
  const laneTone = [0, 3, 7, 10];                     // minor-7 arpeggio, one tone per lane

  const notes = [], backing = [];
  let prevLane = Math.floor(rnd() * d.lanes);
  let dir = 1;

  for (let bar = 0; bar < countIn + bars; bar++) {
    const barT = bar * 4 * beat;
    const root = prog[bar % prog.length];
    const isLast = bar === countIn + bars - 1;

    // Drums (count-in bar gets hats only)
    for (let e = 0; e < 8; e++) backing.push({ t: barT + e * beat / 2, kind: 'hat', accent: e % 2 === 0 });
    if (bar < countIn) continue;
    backing.push({ t: barT, kind: 'kick' }, { t: barT + 2 * beat, kind: 'kick' });
    backing.push({ t: barT + beat, kind: 'snare' }, { t: barT + 3 * beat, kind: 'snare' });
    if (rnd() < 0.35) backing.push({ t: barT + 2.5 * beat, kind: 'kick' });
    if (isLast) backing.push({ t: barT + 4 * beat, kind: 'crash' });

    // Bass line: root, root, fifth, root (eighths on the last beat)
    const bassPat = [0, 0, 7, 0];
    for (let b = 0; b < 4; b++) {
      backing.push({ t: barT + b * beat, kind: 'bass', midi: root - 12 + bassPat[b], dur: beat * 0.85 });
      if (b === 3 && rnd() < 0.5) backing.push({ t: barT + 3.5 * beat, kind: 'bass', midi: root - 12 + (rnd() < 0.5 ? 10 : 12), dur: beat * 0.4 });
    }

    // Chart: last bar is a single held-out chord on beat 1
    if (isLast) {
      const frets = d.lanes >= 4 ? [0, 2] : [0, 1];
      notes.push({ t: barT, frets, pitches: frets.map(l => root + 12 + laneTone[l]), judged: false, hit: false, dur: 0, forceSustain: 4 * beat });
      continue;
    }

    const restBar = (bar - countIn) % 16 === 15 && rnd() < 0.6;   // a breather every so often
    if (restBar) {
      const lane = prevLane;
      notes.push({ t: barT, frets: [lane], pitches: [root + 12 + laneTone[lane]], judged: false, hit: false, dur: 0, forceSustain: 2 * beat });
      continue;
    }

    // Decide slots (16 sixteenths per bar)
    const slots = new Array(16).fill(false);
    for (let b = 0; b < 4; b++) {
      if (rnd() < d.run) { for (let s = 0; s < 4; s++) slots[b * 4 + s] = 'run'; continue; }
      if (rnd() < d.quarter) slots[b * 4] = true;
      if (rnd() < d.eighth) slots[b * 4 + 2] = true;
    }

    for (let s = 0; s < 16; s++) {
      if (!slots[s]) continue;
      const t = barT + s * beat / 4;
      let frets;
      if (slots[s] === 'run') {
        if (s % 4 === 0) { dir = rnd() < 0.5 ? 1 : -1; if (prevLane === 0) dir = 1; if (prevLane === d.lanes - 1) dir = -1; }
        else { prevLane = clamp(prevLane + dir, 0, d.lanes - 1); if (prevLane === 0 || prevLane === d.lanes - 1) dir = -dir; }
        frets = [prevLane];
      } else {
        const r = rnd();
        let lane;
        if (r < 0.22) lane = prevLane;
        else if (r < 0.55) lane = prevLane + 1;
        else if (r < 0.85) lane = prevLane - 1;
        else lane = Math.floor(rnd() * d.lanes);
        lane = clamp(lane, 0, d.lanes - 1);
        if (lane === prevLane && r >= 0.22) lane = clamp(prevLane + (prevLane === 0 ? 1 : -1), 0, d.lanes - 1);
        prevLane = lane;
        frets = [lane];
        const cr = rnd();
        if (cr < d.triple && d.lanes >= 4) {
          const base = Math.floor(rnd() * (d.lanes - 2));
          frets = [base, base + 1, base + 2];
        } else if (cr < d.triple + d.chord) {
          const gap = rnd() < 0.7 ? 1 : 2;
          const other = lane + gap < d.lanes ? lane + gap : lane - gap;
          if (other >= 0 && other !== lane) frets = [Math.min(lane, other), Math.max(lane, other)];
        }
      }
      notes.push({ t, frets, pitches: frets.map(l => root + 12 + laneTone[l]), judged: false, hit: false, dur: 0 });
    }
  }
  // Sustains: a tail fills the gap before the next gem, leaving half a beat to reset
  const half = beat / 2;
  let maxDur = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const next = i + 1 < notes.length ? notes[i + 1].t : n.t + 4.5 * beat;
    const room = Math.floor((next - n.t - half) / half + 1e-9) * half;   // epsilon: 7.9999… must count as 8 half-beats
    if (n.forceSustain) n.dur = Math.max(0, Math.min(n.forceSustain, room));
    else if (room >= beat && rnd() < d.sustain) n.dur = room;
    maxDur = Math.max(maxDur, n.dur);
  }
  backing.sort((a, b) => a.t - b.t);
  const duration = (countIn + bars) * 4 * beat + 1.2;
  return { bpm, beat, countIn, countInEnd: countIn * 4 * beat, bars, notes, backing, duration, maxDur, lookahead: d.lookahead, lanes: d.lanes };
}


function fmtTime(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ':' + String(s).padStart(2, '0'); }

export {
  mulberry32, hashSeed, clamp, midiToHz, LANES, KEYS, LANE_COLORS, LANE_NAMES, STRUM_KEYS, DIFFS, WINDOW_PERFECT, WINDOW_GOOD, NOTE_SCORE, SUSTAIN_PER_BEAT, ROCK_HIT, ROCK_MISS, ROCK_OVER, SEED_WORDS, SEED_NOUNS, generateSong, fmtTime,
};
