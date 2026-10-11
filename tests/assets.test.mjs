import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);

test('the service worker caches every script, stylesheet, font and icon', () => {
  const sw = readFileSync(new URL('sw.js', root), 'utf8');
  const cached = new Set([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));
  for (const dir of ['js', 'css', 'icons']) {
    for (const f of readdirSync(new URL(`${dir}/`, root))) {
      assert.ok(cached.has(`${dir}/${f}`), `${dir}/${f} is missing from ASSETS in sw.js`);
    }
  }
  for (const f of readdirSync(new URL('fonts/', root)).filter((f) => f.endsWith('.woff2'))) {
    assert.ok(cached.has(`fonts/${f}`), `fonts/${f} is missing from ASSETS in sw.js`);
  }
});

test('every cached asset exists on disk', () => {
  const sw = readFileSync(new URL('sw.js', root), 'utf8');
  for (const [, path] of sw.matchAll(/'\.\/([^']+)'/g)) {
    assert.doesNotThrow(() => readFileSync(new URL(path, root)), `${path} is listed in sw.js but missing`);
  }
});

test('the service worker only touches its own caches and scope', () => {
  const sw = readFileSync(new URL('sw.js', root), 'utf8').replace(/\/\/.*$/gm, '');   // code only, not comments
  assert.match(sw, /const CACHE_PREFIX = 'kh-';/);
  assert.match(sw, /k\.startsWith\(CACHE_PREFIX\)/, 'activate must only delete caches with our prefix');
  assert.match(sw, /req\.url\.startsWith\(self\.registration\.scope\)/, 'fetch must ignore other apps on the origin');
  assert.doesNotMatch(sw, /caches\.match\(/, 'caches.match() searches every app\'s caches');
});

test('the stylesheet loads no remote fonts or styles', () => {
  const css = readFileSync(new URL('css/style.css', root), 'utf8');
  const html = readFileSync(new URL('index.html', root), 'utf8');
  assert.doesNotMatch(css + html, /https?:\/\/(fonts\.googleapis|fonts\.gstatic)/);
});

test('version.js has a semver version and an ISO build time', async () => {
  const { VERSION, BUILT } = await import('../js/version.js');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(!Number.isNaN(Date.parse(BUILT)));
});

test('the manifest pins its app id instead of deriving it from start_url', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  // Must stay exactly this: changing it makes browsers treat the app as a different one.
  assert.equal(manifest.id, '/kh/');
});
