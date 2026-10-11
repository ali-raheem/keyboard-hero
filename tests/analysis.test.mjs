import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseAudio, buildFileSong, estimateTempo, makeFFT, trackBeats, FILE_LEAD } from '../js/analysis.js';

// A fake AudioBuffer: decaying noise bursts (drum hits) on every beat at the given tempo.
function clickTrack(bpm, seconds, sampleRate = 22050) {
  const len = Math.floor(seconds * sampleRate);
  const data = new Float32Array(len);
  let seed = 1;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  const step = 60 / bpm;
  for (let t = 0.25; t < seconds; t += step) {
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < 0.06 * sampleRate && start + i < len; i++) data[start + i] += noise() * Math.exp(-i / (0.012 * sampleRate));
  }
  return { sampleRate, length: len, numberOfChannels: 1, duration: seconds, getChannelData: () => data };
}

test('the FFT finds a pure tone in the right bin', () => {
  const n = 64, fft = makeFFT(n);
  const re = Float32Array.from({ length: n }, (_, i) => Math.cos(2 * Math.PI * 5 * i / n));
  const im = new Float32Array(n);
  fft(re, im);
  const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]));
  assert.equal(mags.indexOf(Math.max(...mags.slice(0, n / 2))), 5);
});

test('tempo estimation recovers the period of a pulse train', () => {
  const fr = 43, period = 21;                        // 60 * 43 / 21 ≈ 122.9 bpm
  const env = new Float32Array(43 * 30);
  for (let f = 0; f < env.length; f += period) env[f] = 1;
  const { bpm } = estimateTempo(env, fr);
  assert.ok(Math.abs(bpm - 60 * fr / period) < 2, `got ${bpm}`);
  const beats = trackBeats(env, period);
  assert.ok(beats.length > 20);
  for (let i = 1; i < beats.length; i++) assert.ok(Math.abs(beats[i] - beats[i - 1] - period) <= 2);
});

test('analysing a 100 bpm click track finds the tempo and the hits', async () => {
  const an = await analyseAudio(clickTrack(100, 20), () => {});
  assert.ok(Math.abs(an.bpm - 100) < 4, `bpm ${an.bpm}`);
  assert.ok(an.onsets.length >= 25 && an.onsets.length <= 40, `${an.onsets.length} onsets`);
});

test('a chart built from a track keeps its gems after the lead-in and in lane', async () => {
  const an = await analyseAudio(clickTrack(110, 20), () => {});
  an.name = 'clicks.wav';
  for (const diff of ['easy', 'medium', 'hard', 'expert']) {
    const song = buildFileSong(an, diff);
    assert.ok(song.notes.length > 10, `${diff}: ${song.notes.length} gems`);
    for (let i = 0; i < song.notes.length; i++) {
      const n = song.notes[i];
      assert.ok(n.t >= FILE_LEAD);
      assert.ok(n.frets.every((l) => l >= 0 && l < song.lanes));
      if (i) assert.ok(n.t > song.notes[i - 1].t);
    }
    assert.deepEqual(song, buildFileSong(an, diff), 'same file and difficulty, same chart');
  }
});
