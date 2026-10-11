import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFS, generateSong, fmtTime, hashSeed, mulberry32 } from '../js/song.js';

test('the same seed and difficulty always build the same chart', () => {
  const a = generateSong('midnight riff', 'hard');
  const b = generateSong('  Midnight Riff ', 'hard');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.notes, generateSong('neon anthem', 'hard').notes);
});

test('the seeded generator is deterministic and stays in [0, 1)', () => {
  const r1 = mulberry32(hashSeed('x')), r2 = mulberry32(hashSeed('x'));
  for (let i = 0; i < 1000; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

for (const diff of Object.keys(DIFFS)) {
  test(`${diff}: gems stay in their lanes, in time order, and tails never reach the next gem`, () => {
    for (const seed of ['midnight riff', 'neon anthem', 'ghost groove', 'copper stomp']) {
      const song = generateSong(seed, diff);
      assert.ok(song.bpm >= 104 && song.bpm <= 147);
      assert.ok(song.notes.length > 32);
      for (let i = 0; i < song.notes.length; i++) {
        const n = song.notes[i];
        assert.ok(n.frets.length >= 1 && n.frets.every((l) => l >= 0 && l < DIFFS[diff].lanes));
        assert.deepEqual(n.frets, [...n.frets].sort((x, y) => x - y));
        if (i + 1 < song.notes.length) {
          const next = song.notes[i + 1];
          assert.ok(next.t > n.t, 'notes are in time order');
          if (n.dur > 0) assert.ok(n.t + n.dur <= next.t - song.beat / 2 + 1e-9, 'half a beat to reset after a tail');
        }
      }
      assert.ok(song.notes[0].t >= song.countInEnd, 'nothing to play during the count-in');
      assert.ok(song.duration > song.notes.at(-1).t + song.notes.at(-1).dur);
    }
  });
}

test('easy has no chords; the last gem is a four-beat held chord at every tempo', () => {
  const easy = generateSong('midnight riff', 'easy');
  const chords = easy.notes.slice(0, -1).filter((n) => n.frets.length > 1);
  assert.equal(chords.length, 0);
  // Many seeds, so many tempos: a floating-point floor once cut this to 3.5 beats.
  for (const diff of Object.keys(DIFFS)) {
    for (let i = 0; i < 60; i++) {
      const song = generateSong(`seed ${i}`, diff);
      const last = song.notes.at(-1);
      assert.equal(last.frets.length, 2);
      assert.ok(Math.abs(last.dur - 4 * song.beat) < 1e-9, `${diff} seed ${i} at ${song.bpm} bpm: ${last.dur / song.beat} beats`);
    }
  }
});

test('fmtTime formats minutes and seconds', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(65.9), '1:05');
  assert.equal(fmtTime(600), '10:00');
});
