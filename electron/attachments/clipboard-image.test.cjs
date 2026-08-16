'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanupClipboardImages, saveClipboardImage } = require('./clipboard-image.cjs');

const UUID = '11111111-2222-4333-8444-555555555555';

test('stores a pasted clipboard image as a private PNG attachment', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-clipboard-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const filePath = saveClipboardImage({
    image: { isEmpty: () => false, toPNG: () => Buffer.from('png-data') },
    userData,
    now: 1720000000000,
    id: UUID,
  });
  assert.equal(path.basename(filePath), `clipboard-1720000000000-${UUID}.png`);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'png-data');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('rejects an empty or oversized clipboard image', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-clipboard-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  assert.throws(() => saveClipboardImage({ image: { isEmpty: () => true }, userData, id: UUID }), /does not contain an image/);
  assert.throws(() => saveClipboardImage({ image: { isEmpty: () => false, toPNG: () => Buffer.alloc(5) }, userData, maxBytes: 4, id: UUID }), /25 MB attachment limit/);
});

test('cleans only expired Constellation clipboard images', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-clipboard-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const oldPath = saveClipboardImage({ image: { isEmpty: () => false, toPNG: () => Buffer.from('old') }, userData, now: 1720000000000, id: UUID });
  const keepPath = path.join(path.dirname(oldPath), 'notes.png');
  fs.writeFileSync(keepPath, 'keep');
  fs.utimesSync(oldPath, new Date(0), new Date(0));
  assert.equal(cleanupClipboardImages({ userData, now: 1720000000000, maxAgeMs: 1000 }), 1);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(keepPath), true);
});
