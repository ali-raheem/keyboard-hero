// Audio engine, game loop, rendering and menu wiring.
import {
  clamp, midiToHz, LANES, KEYS, LANE_COLORS, LANE_NAMES, STRUM_KEYS, DIFFS, WINDOW_PERFECT, WINDOW_GOOD, NOTE_SCORE, SUSTAIN_PER_BEAT, ROCK_HIT, ROCK_MISS, ROCK_OVER, SEED_WORDS, SEED_NOUNS, generateSong, fmtTime,
} from './song.js';
import { analyseAudio, buildFileSong, decodeAudio } from './analysis.js';
import { VERSION, BUILT } from './version.js';

const $ = id => document.getElementById(id);

/* =========================================================
   Audio engine (Web Audio synth, no assets)
   ========================================================= */
const audio = {
  ctx: null,
  init() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain(); this.master.gain.value = 0.55; this.master.connect(ctx.destination);

    // Guitar chain: soft clip -> lowpass -> gain
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512), k = 30;
    for (let i = 0; i < 512; i++) { const x = i / 255.5 - 1; curve[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
    this.shaper.curve = curve; this.shaper.oversample = '2x';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.8;
    this.gtrGain = ctx.createGain(); this.gtrGain.gain.value = 0.22;
    this.shaper.connect(lp); lp.connect(this.gtrGain); this.gtrGain.connect(this.master);

    this.songGain = ctx.createGain(); this.songGain.gain.value = 1; this.songGain.connect(this.master);
    this.fileSrc = null;
    this.drumGain = ctx.createGain(); this.drumGain.gain.value = 0.7; this.drumGain.connect(this.master);
    this.bassGain = ctx.createGain(); this.bassGain.gain.value = 0.35; this.bassGain.connect(this.master);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  },
  now() { return this.ctx.currentTime; },
  noiseSrc(when, dur) {
    const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.start(when); s.stop(when + dur + 0.05); return s;
  },
  guitar(midis, when, sustain) {
    const ctx = this.ctx;
    const gains = [];
    const stopAt = when + (sustain > 0 ? sustain + 1.0 : 0.8);
    let lfoGain = null;
    if (sustain > 0) {
      // Slow vibrato that swells in while the note is held
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
      lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(0, when); lfoGain.gain.linearRampToValueAtTime(9, when + 0.4);
      lfo.connect(lfoGain); lfo.start(when); lfo.stop(stopAt);
    }
    for (const m of midis) {
      const g = ctx.createGain();
      const peak = 0.9 / Math.sqrt(midis.length);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(peak, when + 0.006);
      if (sustain > 0) {
        g.gain.exponentialRampToValueAtTime(peak * 0.5, when + 0.25);
        g.gain.setValueAtTime(peak * 0.5, when + sustain);
        g.gain.exponentialRampToValueAtTime(0.0001, when + sustain + 0.3);
      } else {
        g.gain.exponentialRampToValueAtTime(0.25, when + 0.18);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.75);
      }
      g.connect(this.shaper); gains.push(g);
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = midiToHz(m); o.detune.value = det;
        if (lfoGain) lfoGain.connect(o.detune);
        o.connect(g); o.start(when); o.stop(stopAt);
      }
      const sub = ctx.createOscillator(); sub.type = 'square'; sub.frequency.value = midiToHz(m - 12);
      if (lfoGain) lfoGain.connect(sub.detune);
      const sg = ctx.createGain(); sg.gain.value = 0.35; sub.connect(sg); sg.connect(g); sub.start(when); sub.stop(stopAt);
    }
    return {
      release() {
        const t = ctx.currentTime;
        for (const g of gains) {
          if (g.gain.cancelAndHoldAtTime) g.gain.cancelAndHoldAtTime(t);
          else { const v = g.gain.value; g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(v, 0.0001), t); }
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        }
      },
    };
  },
  playFile(buffer, when) {
    this.stopFile();
    const src = this.ctx.createBufferSource(); src.buffer = buffer;
    src.connect(this.songGain); src.start(when); this.fileSrc = src;
  },
  stopFile() {
    if (this.fileSrc) { try { this.fileSrc.stop(); } catch (e) { /* already stopped */ } this.fileSrc = null; }
    if (this.songGain) { const g = this.songGain.gain; g.cancelScheduledValues(0); g.value = 1; }
  },
  // Dip the track for a moment, the single-stem stand-in for muting the guitar
  duck() {
    const t = this.ctx.currentTime, g = this.songGain.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.25, t + 0.03); g.linearRampToValueAtTime(1, t + 0.45);
  },
  // Quiet pick noise for hits on a real track
  pick(when) {
    const ctx = this.ctx;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3500;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.16, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
    this.noiseSrc(when, 0.04).connect(hp); hp.connect(g); g.connect(this.master);
  },
  clank(when) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 2;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
    this.noiseSrc(when, 0.12).connect(bp); bp.connect(g); g.connect(this.master);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, when); o.frequency.exponentialRampToValueAtTime(70, when + 0.15);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.25, when); og.gain.exponentialRampToValueAtTime(0.0001, when + 0.15);
    o.connect(og); og.connect(this.master); o.start(when); o.stop(when + 0.16);
  },
  kick(when) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(160, when); o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    const g = ctx.createGain(); g.gain.setValueAtTime(1.0, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
    o.connect(g); g.connect(this.drumGain); o.start(when); o.stop(when + 0.3);
  },
  snare(when) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.6, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
    this.noiseSrc(when, 0.2).connect(bp); bp.connect(g); g.connect(this.drumGain);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(220, when); o.frequency.exponentialRampToValueAtTime(120, when + 0.08);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.5, when); og.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
    o.connect(og); og.connect(this.drumGain); o.start(when); o.stop(when + 0.12);
  },
  hat(when, accent) {
    const ctx = this.ctx;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = ctx.createGain(); g.gain.setValueAtTime(accent ? 0.28 : 0.16, when); g.gain.exponentialRampToValueAtTime(0.0001, when + (accent ? 0.06 : 0.035));
    this.noiseSrc(when, 0.07).connect(hp); hp.connect(g); g.connect(this.drumGain);
  },
  crash(when) {
    const ctx = this.ctx;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4000;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 1.4);
    this.noiseSrc(when, 1.5).connect(hp); hp.connect(g); g.connect(this.drumGain);
  },
  bass(when, midi, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = midiToHz(midi);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, when); lp.frequency.exponentialRampToValueAtTime(250, when + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(1, when + 0.01);
    g.gain.setValueAtTime(1, when + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(lp); lp.connect(g); g.connect(this.bassGain); o.start(when); o.stop(when + dur + 0.02);
  },
  playBacking(ev, when) {
    switch (ev.kind) {
      case 'kick': return this.kick(when);
      case 'snare': return this.snare(when);
      case 'hat': return this.hat(when, ev.accent);
      case 'crash': return this.crash(when);
      case 'bass': return this.bass(when, ev.midi, ev.dur);
    }
  },
};

/* =========================================================
   Game state
   ========================================================= */
const S = {
  screen: 'menu',
  diff: 'medium',
  seed: 'midnight riff',
  source: 'generated',        // 'generated' | 'file'
  file: null,                 // analysis of the loaded track (with .buffer and .name)
  fileReady: false,
  offset: 0,                  // ms; positive judges notes later to absorb audio latency
  errSum: 0, errN: 0,         // signed timing error of hits, for calibration
  song: null,
  songStart: 0,
  nextNote: 0,
  backingIdx: 0,
  held: [false, false, false, false],
  score: 0, combo: 0, maxCombo: 0, mult: 1,
  rock: 0.5,
  hits: 0, perfects: 0, misses: 0, overstrums: 0,
  ended: false, failed: false, paused: false,
  particles: [], popups: [],
  active: [],                 // notes currently being sustained
  sustainGrace: 0,            // song-time until which a dropped fret is forgiven (after unpause)
  laneFlash: [0, 0, 0, 0],      // song-time of last hit flash per lane
  strumFlash: 0,
  raf: 0,
};

function songTime() { return audio.ctx.currentTime - S.songStart - S.offset / 1000; }
function multFor(combo) { return combo >= 30 ? 4 : combo >= 20 ? 3 : combo >= 10 ? 2 : 1; }

/* ---------- Best score persistence (per-viewer convenience) ---------- */
function bestKey(diff) { return 'keyboardhero.best.' + diff; }
function readBest(diff) { try { return Number(localStorage.getItem(bestKey(diff))) || 0; } catch (e) { return 0; } }
function writeBest(diff, score) { try { localStorage.setItem(bestKey(diff), String(score)); } catch (e) { /* storage unavailable */ } }
function readOffset() { try { return clamp(Number(localStorage.getItem('keyboardhero.offset')) || 0, -300, 300); } catch (e) { return 0; } }
function writeOffset(ms) { try { localStorage.setItem('keyboardhero.offset', String(ms)); } catch (e) { /* storage unavailable */ } }

/* =========================================================
   Judgement
   ========================================================= */
function fretsMatch(frets) {
  const h = S.held;
  if (frets.length === 1) {
    // Single note: the fret must be held and nothing higher may be held (lower anchors are fine).
    const f = frets[0];
    if (!h[f]) return false;
    for (let l = f + 1; l < LANES; l++) if (h[l]) return false;
    return true;
  }
  for (let l = 0; l < LANES; l++) if (h[l] !== frets.includes(l)) return false;
  return true;
}

function fretsHeld(frets) { return frets.every(l => S.held[l]); }

function hit(note, err, now) {
  note.judged = true; note.hit = true;
  const perfect = err <= WINDOW_PERFECT;
  S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo);
  const newMult = multFor(S.combo);
  if (newMult !== S.mult) { S.mult = newMult; popMult(); }
  S.score += NOTE_SCORE * note.frets.length * S.mult + (perfect ? 10 : 0);
  S.hits++; if (perfect) S.perfects++;
  S.rock = clamp(S.rock + ROCK_HIT * note.frets.length, 0, 1);
  S.errSum += now - note.t; S.errN++;
  const remaining = note.dur > 0 ? note.t + note.dur - now : 0;
  if (S.song.file) { audio.pick(audio.now()); note.voice = null; }
  else note.voice = audio.guitar(note.pitches, audio.now(), remaining > 0.05 ? remaining : 0);
  if (remaining > 0.05) {
    note.sustaining = true; note.sustainEnd = note.t + note.dur; note.sustainScored = now; note.sustainAcc = 0;
    S.active.push(note);
  }
  for (const l of note.frets) { S.laneFlash[l] = now; spawnSparks(l); }
  S.popups.push({ text: perfect ? 'Perfect' : 'Good', color: perfect ? '#ffb347' : '#f2eee6', t0: now });
  updateHud();
}
function miss(note, now, reason) {
  note.judged = true; note.hit = false;
  S.misses++;
  breakCombo(now, reason === 'late' ? 'Miss' : 'Wrong frets');
  S.rock = clamp(S.rock - ROCK_MISS, 0, 1);
  if (S.song.file) audio.duck();
  if (reason !== 'late') audio.clank(audio.now());
  updateHud();
}
function overstrum(now) {
  S.overstrums++;
  breakCombo(now, 'Overstrum');
  S.rock = clamp(S.rock - ROCK_OVER, 0, 1);
  if (S.song.file) audio.duck();
  audio.clank(audio.now());
  updateHud();
}
function breakCombo(now, label) {
  S.combo = 0;
  if (S.mult !== 1) { S.mult = 1; popMult(); }
  S.popups.push({ text: label, color: '#ff5252', t0: now });
}

function strum() {
  if (S.screen !== 'game' || S.paused || S.ended) return;
  const now = songTime();
  S.strumFlash = now;
  const notes = S.song.notes;
  let idx = -1;
  for (let i = S.nextNote; i < notes.length; i++) {
    const n = notes[i];
    if (n.judged) continue;
    const dt = n.t - now;
    if (dt > WINDOW_GOOD) break;
    if (dt < -WINDOW_GOOD) continue;
    idx = i; break;
  }
  if (idx < 0) { overstrum(now); return; }
  const n = notes[idx];
  if (fretsMatch(n.frets)) hit(n, Math.abs(n.t - now), now);
  else miss(n, now, 'wrong');
}

/* =========================================================
   Screens
   ========================================================= */
function show(name) {
  S.screen = name;
  $('menu').hidden = name !== 'menu';
  $('game').hidden = name !== 'game';
  $('results').hidden = name !== 'results';
}

async function startGame() {
  audio.init();
  await audio.ctx.resume();
  if (S.source === 'file') {
    if (!S.fileReady) return;
    S.song = buildFileSong(S.file, S.diff);
  } else {
    S.song = generateSong(S.seed, S.diff);
  }
  Object.assign(S, {
    nextNote: 0, backingIdx: 0, held: [false, false, false, false], errSum: 0, errN: 0,
    score: 0, combo: 0, maxCombo: 0, mult: 1, rock: 0.5,
    hits: 0, perfects: 0, misses: 0, overstrums: 0,
    ended: false, failed: false, paused: false,
    particles: [], popups: [], active: [], sustainGrace: 0, laneFlash: [-9, -9, -9, -9], strumFlash: -9,
  });
  S.songStart = audio.ctx.currentTime + 0.6;
  if (S.song.file) audio.playFile(S.file.buffer, S.songStart + S.song.lead);
  $('overlay').hidden = true;
  $('mult').className = '';
  show('game');
  resizeCanvas();
  updateHud();
  cancelAnimationFrame(S.raf);
  S.raf = requestAnimationFrame(frame);
}

function endGame(failed) {
  S.ended = true; S.failed = failed;
  cancelAnimationFrame(S.raf);
  if (S.song.file) audio.stopFile();
  const total = S.song.notes.length;
  const acc = total ? S.hits / total : 0;
  const stars = failed ? 0 : acc >= 0.97 ? 5 : acc >= 0.9 ? 4 : acc >= 0.75 ? 3 : acc >= 0.5 ? 2 : 1;
  const prevBest = readBest(S.diff);
  const isBest = !failed && !S.song.file && S.score > prevBest;
  if (isBest) writeBest(S.diff, S.score);

  const songLabel = S.song.file ? S.song.name : 'seed “' + S.seed + '”';
  $('res-eyebrow').textContent = failed ? 'Booed off stage' : DIFFS[S.diff].label + ' · ' + S.song.bpm + ' bpm · ' + songLabel;
  $('res-title').textContent = failed ? 'Song failed' : stars === 5 ? 'Encore!' : stars >= 3 ? 'Nice set' : 'Rough gig';
  $('stars').innerHTML = Array.from({ length: 5 }, (_, i) => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('');
  $('res-score').textContent = S.score.toLocaleString();
  $('res-hit').textContent = `${S.hits} / ${total}`;
  $('res-acc').textContent = Math.round(acc * 100) + '%';
  $('res-combo').textContent = S.maxCombo;
  $('res-perf').textContent = S.perfects;
  $('res-miss').textContent = S.misses;
  $('res-over').textContent = S.overstrums;
  $('res-best').innerHTML = S.song.file ? '' : isBest ? 'New best on ' + DIFFS[S.diff].label + '!' : 'Best on ' + DIFFS[S.diff].label + ': <b>' + (Math.max(prevBest, 0)).toLocaleString() + '</b>';
  if (S.errN >= 5) {
    const avg = Math.round(S.errSum / S.errN * 1000);
    const tip = Math.abs(avg) >= 15 ? ' · try a timing offset of ' + (S.offset + avg) + ' ms' : '';
    $('res-timing').innerHTML = 'Average timing: <b>' + Math.abs(avg) + ' ms ' + (avg >= 0 ? 'late' : 'early') + '</b>' + tip;
  } else $('res-timing').textContent = '';
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  show('results');
}

function togglePause(force) {
  if (S.screen !== 'game' || S.ended) return;
  const want = force === undefined ? !S.paused : force;
  if (want === S.paused) return;
  S.paused = want;
  $('overlay').hidden = !want;
  if (want) audio.ctx.suspend(); else { S.sustainGrace = songTime() + 0.4; audio.ctx.resume(); }
}

function quitToMenu() {
  cancelAnimationFrame(S.raf);
  if (S.song && S.song.file) audio.stopFile();
  for (const n of S.active) if (n.voice) n.voice.release();
  S.active = [];
  S.ended = true; S.paused = false;
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  refreshBest();
  show('menu');
}

/* =========================================================
   HUD
   ========================================================= */
function updateHud() {
  $('score').textContent = S.score.toLocaleString();
  $('combo').textContent = S.combo + ' combo';
  const m = $('mult');
  m.textContent = 'x' + S.mult;
  m.classList.toggle('m2', S.mult === 2);
  m.classList.toggle('m3', S.mult === 3);
  m.classList.toggle('m4', S.mult === 4);
  const rf = $('rock-fill');
  rf.style.height = Math.round(S.rock * 100) + '%';
  rf.style.background = S.rock < 0.3 ? 'var(--bad)' : S.rock < 0.6 ? 'var(--warn)' : 'var(--good)';
}
function popMult() {
  const m = $('mult');
  m.classList.add('pop');
  setTimeout(() => m.classList.remove('pop'), 140);
}
function refreshBest() {
  const b = readBest(S.diff);
  $('best').innerHTML = 'Best on ' + DIFFS[S.diff].label + ': <b>' + (b ? b.toLocaleString() : '—') + '</b>';
}

/* =========================================================
   Rendering
   ========================================================= */
const canvas = $('highway');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
const PERSP = 2.4;   // perspective strength

function resizeCanvas() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
function geom() {
  const laneW = Math.min(W * 0.17, 120);
  return { cx: W / 2, laneW, yStrike: H * 0.8, yTop: H * 0.06 };
}
function scaleAt(z) { return 1 / (1 + PERSP * z); }
function zToY(g, z) { const f = z * (1 + PERSP) / (1 + PERSP * z); return g.yStrike - (g.yStrike - g.yTop) * f; }
function laneX(g, lane, z) { return g.cx + (lane - 1.5) * g.laneW * scaleAt(z); }

function spawnSparks(lane) {
  const g = geom();
  const x = laneX(g, lane, 0), y = g.yStrike;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const sp = 120 + Math.random() * 260;
    S.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.45 + Math.random() * 0.25, age: 0, color: LANE_COLORS[lane], r: 2 + Math.random() * 2.5 });
  }
}

let lastFrameTime = 0;
function frame(ts) {
  S.raf = requestAnimationFrame(frame);
  const dtReal = lastFrameTime ? Math.min((ts - lastFrameTime) / 1000, 0.05) : 0;
  lastFrameTime = ts;
  if (S.paused) { draw(songTime()); return; }

  const now = songTime();
  const song = S.song;

  // Schedule backing track a little ahead of the audio clock
  const ac = audio.ctx;
  while (S.backingIdx < song.backing.length && song.backing[S.backingIdx].t + S.songStart < ac.currentTime + 0.25) {
    const ev = song.backing[S.backingIdx++];
    audio.playBacking(ev, Math.max(ev.t + S.songStart, ac.currentTime));
  }

  // Notes that scrolled past unhit are misses
  const notes = song.notes;
  while (S.nextNote < notes.length) {
    const n = notes[S.nextNote];
    if (n.judged) { S.nextNote++; continue; }
    if (n.t < now - WINDOW_GOOD) { miss(n, now, 'late'); S.nextNote++; continue; }
    break;
  }

  // Active sustains: pay out while the frets stay held, drop them when released early
  if (S.active.length) {
    const graced = now < S.sustainGrace;
    let scored = false;
    for (const n of S.active) {
      const upTo = Math.min(now, n.sustainEnd);
      if (upTo > n.sustainScored) {
        n.sustainAcc += SUSTAIN_PER_BEAT * n.frets.length * S.mult * (upTo - n.sustainScored) / song.beat;
        n.sustainScored = upTo;
        const whole = Math.floor(n.sustainAcc);
        if (whole > 0) { S.score += whole; n.sustainAcc -= whole; scored = true; }
      }
      if (now >= n.sustainEnd) { n.sustaining = false; S.rock = clamp(S.rock + ROCK_HIT * 0.5, 0, 1); scored = true; }
      else if (!graced && !fretsHeld(n.frets)) { n.sustaining = false; n.dropT = now; if (n.voice) n.voice.release(); }
    }
    S.active = S.active.filter(n => n.sustaining);
    if (scored) updateHud();
  }

  // Particles
  for (const p of S.particles) { p.age += dtReal; p.x += p.vx * dtReal; p.y += p.vy * dtReal; p.vy += 600 * dtReal; }
  S.particles = S.particles.filter(p => p.age < p.life);
  S.popups = S.popups.filter(p => now - p.t0 < 0.6);

  $('prog-fill').style.width = clamp(now / song.duration * 100, 0, 100) + '%';

  if (S.rock <= 0) { draw(now); endGame(true); return; }
  if (now > song.duration) { draw(now); endGame(false); return; }
  draw(now);
}

function draw(now) {
  const g = geom();
  const song = S.song;
  const look = song.lookahead;
  const zBottom = -0.16;

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0b0a10'); bg.addColorStop(1, '#141220');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // Spotlight glow behind the far end
  const glow = ctx.createRadialGradient(g.cx, g.yTop, 0, g.cx, g.yTop, H * 0.5);
  glow.addColorStop(0, 'rgba(255,179,71,0.18)'); glow.addColorStop(1, 'rgba(255,179,71,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  // Highway body
  const yB = zToY(g, zBottom), yT = zToY(g, 1);
  const xBL = laneX(g, -0.5, zBottom), xBR = laneX(g, 3.5, zBottom);
  const xTL = laneX(g, -0.5, 1), xTR = laneX(g, 3.5, 1);
  ctx.beginPath(); ctx.moveTo(xBL, yB); ctx.lineTo(xBR, yB); ctx.lineTo(xTR, yT); ctx.lineTo(xTL, yT); ctx.closePath();
  const hw = ctx.createLinearGradient(0, yT, 0, g.yStrike);
  hw.addColorStop(0, 'rgba(38,34,52,0.35)'); hw.addColorStop(1, 'rgba(38,34,52,0.95)');
  ctx.fillStyle = hw; ctx.fill();

  // Lane tint when held
  for (let l = 0; l < LANES; l++) {
    if (!S.held[l]) continue;
    ctx.beginPath();
    ctx.moveTo(laneX(g, l - 0.5, zBottom), yB); ctx.lineTo(laneX(g, l + 0.5, zBottom), yB);
    ctx.lineTo(laneX(g, l + 0.5, 1), yT); ctx.lineTo(laneX(g, l - 0.5, 1), yT); ctx.closePath();
    ctx.fillStyle = LANE_COLORS[l] + '14'; ctx.fill();
  }

  // Beat lines: tracked beats for a loaded track, a fixed grid for generated songs
  const beatLine = (t, bar) => {
    const z = (t - now) / look;
    if (z < zBottom || z > 1) return;
    const y = zToY(g, z);
    ctx.strokeStyle = bar ? 'rgba(242,238,230,0.22)' : 'rgba(242,238,230,0.08)';
    ctx.lineWidth = bar ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(laneX(g, -0.5, z), y); ctx.lineTo(laneX(g, 3.5, z), y); ctx.stroke();
  };
  if (song.beats) {
    for (let b = 0; b < song.beats.length; b++) {
      const t = song.beats[b];
      if (t < now - 0.3) continue;
      if (t > now + look) break;
      beatLine(t, ((b - song.barPhase) % 4 + 4) % 4 === 0);
    }
  } else {
    const firstBeat = Math.floor((now - 0.2) / song.beat), lastBeat = Math.ceil((now + look) / song.beat);
    for (let b = firstBeat; b <= lastBeat; b++) beatLine(b * song.beat, b % 4 === 0);
  }

  // Lane dividers & rails
  for (let l = -0.5; l <= 3.5; l++) {
    const rail = l === -0.5 || l === 3.5;
    ctx.strokeStyle = rail ? 'rgba(242,238,230,0.5)' : 'rgba(242,238,230,0.12)';
    ctx.lineWidth = rail ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(laneX(g, l, zBottom), yB); ctx.lineTo(laneX(g, l, 1), yT); ctx.stroke();
  }

  // Strike line
  const strumAge = now - S.strumFlash;
  ctx.strokeStyle = strumAge < 0.08 ? 'rgba(255,255,255,0.95)' : 'rgba(242,238,230,0.55)';
  ctx.lineWidth = strumAge < 0.08 ? 4 : 2.5;
  ctx.beginPath(); ctx.moveTo(laneX(g, -0.5, 0), g.yStrike); ctx.lineTo(laneX(g, 3.5, 0), g.yStrike); ctx.stroke();

  // Fret buttons
  const sustLane = [false, false, false, false];
  for (const n of S.active) for (const l of n.frets) sustLane[l] = true;
  const rx0 = g.laneW * 0.40, ry0 = rx0 * 0.5;
  for (let l = 0; l < LANES; l++) {
    const x = laneX(g, l, 0), y = g.yStrike;
    const flash = clamp(1 - (now - S.laneFlash[l]) / 0.18, 0, 1);
    const active = l < song.lanes;
    ctx.save();
    if (S.held[l] || flash > 0 || sustLane[l]) { ctx.shadowColor = LANE_COLORS[l]; ctx.shadowBlur = 18 + flash * 22 + (sustLane[l] ? 12 + 8 * Math.sin(now * 18) : 0); }
    ctx.beginPath(); ctx.ellipse(x, y, rx0 * (1 + flash * 0.15), ry0 * (1 + flash * 0.15), 0, 0, Math.PI * 2);
    ctx.fillStyle = S.held[l] ? LANE_COLORS[l] : (active ? 'rgba(20,18,30,0.9)' : 'rgba(20,18,30,0.5)');
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = active ? LANE_COLORS[l] : 'rgba(141,135,152,0.5)'; ctx.stroke();
    ctx.restore();
    if (flash > 0) {
      ctx.beginPath(); ctx.ellipse(x, y, rx0 * (1 + flash * 0.6), ry0 * (1 + flash * 0.6), 0, 0, Math.PI * 2);
      ctx.strokeStyle = LANE_COLORS[l]; ctx.globalAlpha = flash * 0.8; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = S.held[l] ? '#0b0a10' : (active ? '#f2eee6' : 'rgba(141,135,152,0.6)');
    ctx.font = `700 ${Math.round(ry0 * 1.2)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(LANE_NAMES[l], x, y + 1);
  }

  // Notes: far ones first so near ones overlap them
  const notes = song.notes;
  const tMin = now - 0.3, tMax = now + look;
  const tCut = tMin - song.maxDur;
  let iEnd = notes.length;
  while (iEnd > 0 && notes[iEnd - 1].t > tMax) iEnd--;

  // Sustain tails go under the gems
  for (let i = iEnd - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.t < tCut) break;
    if (!n.dur) continue;
    const endT = n.t + n.dur;
    if (endT < tMin) continue;
    let startT, style;
    if (n.sustaining) { startT = now; style = 'active'; }
    else if (n.hit) { if (n.dropT === undefined) continue; startT = n.dropT; style = 'dead'; }
    else { startT = n.t; style = n.judged ? 'dead' : 'pending'; }
    const z0 = Math.max((startT - now) / look, zBottom), z1 = Math.min((endT - now) / look, 1);
    if (z1 <= z0) continue;
    for (const l of n.frets) drawTail(g, l, z0, z1, LANE_COLORS[l], style);
  }

  for (let i = iEnd - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.t < tCut) break;
    if (n.hit && !n.sustaining) continue;
    if (n.t < tMin && !n.sustaining) continue;
    const z = n.sustaining ? 0 : (n.t - now) / look;
    if (z < zBottom) continue;
    const s = scaleAt(z), y = zToY(g, z);
    const rx = g.laneW * 0.40 * s, ry = rx * 0.55;
    const missed = n.judged && !n.hit;
    if (n.frets.length > 1) {
      const x0 = laneX(g, n.frets[0], z), x1 = laneX(g, n.frets[n.frets.length - 1], z);
      ctx.fillStyle = missed ? 'rgba(141,135,152,0.35)' : 'rgba(242,238,230,0.55)';
      ctx.fillRect(x0, y - ry * 0.3, x1 - x0, ry * 0.6);
    }
    for (const l of n.frets) {
      const x = laneX(g, l, z);
      ctx.beginPath(); ctx.ellipse(x, y + ry * 0.35, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = missed ? '#3a3548' : shade(LANE_COLORS[l], -0.45); ctx.fill();   // base
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      if (missed) { ctx.fillStyle = '#4b4560'; }
      else {
        const gr = ctx.createRadialGradient(x - rx * 0.3, y - ry * 0.4, rx * 0.1, x, y, rx);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, LANE_COLORS[l]); gr.addColorStop(1, shade(LANE_COLORS[l], -0.25));
        ctx.fillStyle = gr;
      }
      ctx.fill();
      ctx.lineWidth = Math.max(1, 2 * s); ctx.strokeStyle = 'rgba(11,10,16,0.8)'; ctx.stroke();
    }
  }

  // Particles
  for (const p of S.particles) {
    ctx.globalAlpha = 1 - p.age / p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Judgement popups
  for (const p of S.popups) {
    const a = now - p.t0;
    const k = clamp(a / 0.6, 0, 1);
    ctx.globalAlpha = 1 - k * k;
    ctx.fillStyle = p.color;
    ctx.font = `400 ${Math.round(Math.min(W, 640) * 0.045 + 12)}px "Bungee", "Impact", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.text, g.cx, g.yStrike - g.laneW * 0.9 - k * 40);
  }
  ctx.globalAlpha = 1;

  // Count-in
  if (now < song.countInEnd) {
    const beatsLeft = Math.ceil((song.countInEnd - now) / song.beat);
    ctx.fillStyle = 'rgba(242,238,230,0.9)';
    ctx.font = `400 ${Math.round(Math.min(W, 640) * 0.1 + 20)}px "Bungee", "Impact", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(now < 0 ? 'Ready' : String(beatsLeft), g.cx, H * 0.4);
  }
}

function drawTail(g, lane, z0, z1, color, style) {
  const s0 = scaleAt(z0), s1 = scaleAt(z1);
  const w0 = g.laneW * 0.14 * s0, w1 = g.laneW * 0.14 * s1;
  const xa = laneX(g, lane, z0), xb = laneX(g, lane, z1);
  const ya = zToY(g, z0), yb = zToY(g, z1);
  ctx.beginPath(); ctx.moveTo(xa - w0, ya); ctx.lineTo(xa + w0, ya); ctx.lineTo(xb + w1, yb); ctx.lineTo(xb - w1, yb); ctx.closePath();
  if (style === 'dead') { ctx.fillStyle = 'rgba(75,69,96,0.7)'; ctx.fill(); return; }
  ctx.save();
  if (style === 'active') { ctx.shadowColor = color; ctx.shadowBlur = 16; }
  ctx.fillStyle = style === 'active' ? color : shade(color, -0.3);
  ctx.globalAlpha = style === 'active' ? 0.95 : 0.7;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = style === 'active' ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.25)';
  ctx.lineWidth = style === 'active' ? 2 : 1;
  ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const f = 1 + amt;
  r = clamp(Math.round(r * f), 0, 255); gg = clamp(Math.round(gg * f), 0, 255); b = clamp(Math.round(b * f), 0, 255);
  return `rgb(${r},${gg},${b})`;
}

/* =========================================================
   Input
   ========================================================= */
window.addEventListener('keydown', e => {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (S.screen === 'game') {
    if (key === 'Escape') { e.preventDefault(); togglePause(); return; }
    const lane = KEYS.indexOf(key);
    if (lane >= 0) { e.preventDefault(); S.held[lane] = true; return; }
    if (STRUM_KEYS.has(e.key)) { e.preventDefault(); if (!e.repeat) strum(); return; }
  } else if (S.screen === 'menu') {
    if (key === 'Enter' && document.activeElement !== $('seed')) { e.preventDefault(); $('start').click(); }
  } else if (S.screen === 'results') {
    if (key === 'Enter') { e.preventDefault(); $('retry').click(); }
  }
});
window.addEventListener('keyup', e => {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const lane = KEYS.indexOf(key);
  if (lane >= 0) S.held[lane] = false;
});
window.addEventListener('blur', () => { S.held = [false, false, false, false]; togglePause(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });
window.addEventListener('resize', () => { if (S.screen === 'game') resizeCanvas(); });

/* ---------- Menu wiring ---------- */
$('diff-seg').addEventListener('click', e => {
  const b = e.target.closest('button[data-diff]'); if (!b) return;
  S.diff = b.dataset.diff;
  for (const x of $('diff-seg').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  refreshBest();
});
$('src-seg').addEventListener('click', e => {
  const b = e.target.closest('button[data-src]'); if (!b) return;
  S.source = b.dataset.src;
  for (const x of $('src-seg').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  $('seed-field').hidden = S.source !== 'generated';
  $('file-field').hidden = S.source !== 'file';
  $('best').hidden = S.source === 'file';
  updateStartState();
});
$('pick-file').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) loadFile(f); });
$('offset').addEventListener('input', e => {
  S.offset = clamp(Number(e.target.value) || 0, -300, 300);
  writeOffset(S.offset);
});

function setFileStatus(text) { $('file-status').textContent = text; }
function updateStartState() {
  const b = $('start');
  if (S.source === 'file' && !S.fileReady) {
    b.disabled = true;
    b.textContent = S.file === undefined ? 'Analysing…' : 'Choose a file to start';
  } else { b.disabled = false; b.textContent = 'Start'; }
}
async function loadFile(file) {
  audio.init();
  S.file = undefined; S.fileReady = false; updateStartState();
  setFileStatus('Decoding ' + file.name + '…');
  try {
    const decoded = await decodeAudio(audio.ctx, await file.arrayBuffer());
    const an = await analyseAudio(decoded, p => setFileStatus('Listening to ' + file.name + '… ' + Math.round(p * 100) + '%'));
    an.name = file.name; an.buffer = decoded;
    S.file = an; S.fileReady = true;
    const few = an.onsets.length < an.duration * 0.5;
    setFileStatus(file.name + ' · ' + fmtTime(decoded.duration) + ' · ' + Math.round(an.bpm) + ' bpm · ' + an.onsets.length + ' hits found' + (few ? '. Quiet track: the chart will be sparse.' : ''));
  } catch (err) {
    S.file = null; S.fileReady = false;
    setFileStatus('Couldn\'t read that file. Try MP3, OGG, WAV, M4A or FLAC.');
  }
  updateStartState();
}

$('seed').addEventListener('input', e => { S.seed = e.target.value || 'default'; });
$('shuffle').addEventListener('click', () => {
  const w = SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
  const n = SEED_NOUNS[Math.floor(Math.random() * SEED_NOUNS.length)];
  $('seed').value = S.seed = `${w} ${n}`;
});
$('start').addEventListener('click', () => { S.seed = $('seed').value.trim() || 'default'; startGame(); });
$('resume').addEventListener('click', () => togglePause(false));
$('quit').addEventListener('click', quitToMenu);
$('retry').addEventListener('click', startGame);
$('to-menu').addEventListener('click', () => { refreshBest(); show('menu'); });

S.offset = readOffset();
$('offset').value = S.offset;
refreshBest();
updateStartState();
show('menu');

$('version').textContent = `v${VERSION} · built ${new Date(BUILT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
$('version').title = BUILT;

// Offline support. The worker URL carries the version, so `npm run bump` installs a
// fresh worker with a clean cache.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register(`./sw.js?v=${VERSION}`).catch(() => {});
}
