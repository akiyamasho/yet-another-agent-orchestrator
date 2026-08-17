'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanupClipboardImages, saveClipboardImage, saveClipboardImageBytes } = require('./clipboard-image.cjs');

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

test('persists renderer-provided PNG bytes asynchronously and rejects non-PNG payloads', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-clipboard-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const validPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('renderer-png')]);
  const filePath = await saveClipboardImageBytes({
    bytes: new Uint8Array(validPng),
    mimeType: 'image/png',
    name: 'clipboard.png',
    userData,
    now: 1720000000000,
    id: UUID,
  });
  assert.deepEqual(fs.readFileSync(filePath), validPng);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  await assert.rejects(() => saveClipboardImageBytes({ bytes: Buffer.from('jpeg'), mimeType: 'image/jpeg', userData, id: UUID }), /PNG files/);
  await assert.rejects(() => saveClipboardImageBytes({ bytes: Buffer.from('not-a-png'), mimeType: 'image/png', userData, id: UUID }), /valid PNG/);
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
