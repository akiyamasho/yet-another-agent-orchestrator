'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLIPBOARD_FILE = /^clipboard-(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.png$/i;

function clipboardImageDirectory(userData) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw new Error('Clipboard storage requires an absolute userData path.');
  return path.join(userData, 'clipboard-images');
}

function saveClipboardImage({ image, userData, maxBytes = DEFAULT_MAX_BYTES, now = Date.now(), id = randomUUID() }) {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) throw new Error('The clipboard does not contain an image.');
  if (typeof image.toPNG !== 'function') throw new Error('Electron could not read the clipboard image.');
  const png = image.toPNG();
  if (!Buffer.isBuffer(png) || png.length === 0) throw new Error('Electron could not encode the clipboard image.');
  if (png.length > maxBytes) throw new Error('The clipboard image exceeds the 25 MB attachment limit.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Could not create a safe clipboard image name.');

  const directory = clipboardImageDirectory(userData);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `clipboard-${Math.trunc(now)}-${id}.png`);
  fs.writeFileSync(filePath, png, { flag: 'wx', mode: 0o600 });
  return filePath;
}

/**
 * Persist bytes already read by the renderer. Keeping this path separate from
 * Electron's native clipboard conversion avoids blocking the main process on
 * clipboard.readImage()/toPNG() while the composer is being typed into.
 */
async function saveClipboardImageBytes({ bytes, mimeType = 'image/png', userData, maxBytes = DEFAULT_MAX_BYTES, now = Date.now(), id = randomUUID(), name = 'clipboard.png' }) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('Could not read the clipboard image.');
  const png = Buffer.from(bytes);
  if (!png.length) throw new Error('The clipboard does not contain an image.');
  if (png.length > maxBytes) throw new Error('The clipboard image exceeds the 25 MB attachment limit.');
  if (mimeType !== 'image/png') throw new Error('Clipboard images must be PNG files.');
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error('The clipboard image is not a valid PNG.');
  if (typeof name !== 'string' || name.length > 160 || /[\\/\0]/.test(name)) throw new Error('Could not create a safe clipboard image name.');
  if (!/^clipboard\.png$/i.test(path.basename(name))) throw new Error('Could not create a safe clipboard image name.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Could not create a safe clipboard image name.');

  const directory = clipboardImageDirectory(userData);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `clipboard-${Math.trunc(now)}-${id}.png`);
  await fs.promises.writeFile(filePath, png, { flag: 'wx', mode: 0o600 });
  return filePath;
}

function cleanupClipboardImages({ userData, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const directory = clipboardImageDirectory(userData);
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !CLIPBOARD_FILE.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stats = fs.statSync(filePath);
    if (now - stats.mtimeMs <= maxAgeMs) continue;
    fs.rmSync(filePath, { force: true });
    removed += 1;
  }
  return removed;
}

module.exports = { cleanupClipboardImages, clipboardImageDirectory, saveClipboardImage, saveClipboardImageBytes };
