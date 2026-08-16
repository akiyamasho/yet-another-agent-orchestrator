'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compareVersions, normalizeVersion, checksumFor } = require('./github-release-updater.cjs');

test('compares GitHub release versions without lexical mistakes', () => {
  assert.equal(normalizeVersion('v0.2.0'), '0.2.0');
  assert.equal(compareVersions('0.10.0', '0.2.0'), 1);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1);
});

test('reads only the checksum for the exact release filename', () => {
  const hash = 'a'.repeat(64);
  assert.equal(checksumFor(`${hash}  Constellation-0.2.0-arm64.zip\n`, 'Constellation-0.2.0-arm64.zip'), hash);
  assert.equal(checksumFor(`${hash}  other.zip\n`, 'Constellation-0.2.0-arm64.zip'), null);
});
