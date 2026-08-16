'use strict';

const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const https = require('node:https');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ALLOWED_DOWNLOAD_HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').split('-')[0];
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split('.').map((value) => Number.parseInt(value, 10) || 0);
  const b = normalizeVersion(right).split('.').map((value) => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

function request(url, options = {}, redirects = 0) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) return Promise.reject(new Error(`Blocked update host: ${parsed.hostname}`));
  if (redirects > 6) return Promise.reject(new Error('Too many update download redirects.'));
  return new Promise((resolve, reject) => {
    const req = https.get(parsed, { headers: { 'User-Agent': 'Constellation-Updater', Accept: 'application/vnd.github+json', ...options.headers } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(request(new URL(response.headers.location, parsed).toString(), options, redirects + 1));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => reject(new Error(`Update server returned ${response.statusCode}: ${body.slice(0, 240)}`)));
        return;
      }
      resolve(response);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Update request timed out.')));
    req.on('error', reject);
  });
}

async function textRequest(url) {
  const response = await request(url);
  response.setEncoding('utf8');
  let body = '';
  for await (const chunk of response) body += chunk;
  return body;
}

async function jsonRequest(url) {
  return JSON.parse(await textRequest(url));
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function download(url, destination, onProgress) {
  const response = await request(url, { headers: { Accept: 'application/octet-stream' } });
  const total = Number(response.headers['content-length']) || 0;
  const temp = `${destination}.part`;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  let transferred = 0;
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(temp, { mode: 0o600 });
    response.on('data', (chunk) => { transferred += chunk.length; onProgress?.({ transferred, total, percent: total ? Math.round((transferred / total) * 100) : 0 }); });
    response.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    response.pipe(output);
  });
  await fsp.rename(temp, destination);
  return destination;
}

function checksumFor(contents, filename) {
  for (const line of String(contents).split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  return null;
}

class GitHubReleaseUpdater extends EventEmitter {
  constructor(options) {
    super();
    this.owner = options.owner;
    this.repo = options.repo;
    this.currentVersion = options.currentVersion;
    this.arch = options.arch;
    this.userData = options.userData;
    this.execPath = options.execPath;
    this.state = { phase: 'idle', currentVersion: this.currentVersion };
    this.release = null;
    this.downloaded = null;
    this.preparedApp = null;
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.state);
    return this.state;
  }

  snapshot() { return this.state; }

  async check() {
    this.update({ phase: 'checking', error: undefined });
    try {
      const release = await jsonRequest(`https://api.github.com/repos/${this.owner}/${this.repo}/releases/latest`);
      const version = normalizeVersion(release.tag_name || release.name);
      const asset = (release.assets || []).find((item) => item.name === `Constellation-${version}-${this.arch}.zip` || item.name.endsWith(`-${this.arch}.zip`));
      const checksums = (release.assets || []).find((item) => item.name === 'SHA256SUMS.txt');
      const available = Boolean(version && compareVersions(version, this.currentVersion) > 0);
      this.release = { version, tag: release.tag_name, notes: release.body || '', url: release.html_url, publishedAt: release.published_at, asset, checksums };
      if (available && (!asset || !checksums)) throw new Error(`v${version} is published but does not include the ${this.arch} ZIP and SHA256SUMS.txt.`);
      return this.update({ phase: available ? 'available' : 'current', available, latestVersion: version, releaseUrl: release.html_url, releaseNotes: release.body || '', publishedAt: release.published_at, progress: undefined });
    } catch (error) {
      this.update({ phase: 'error', error: error.message || String(error) });
      throw error;
    }
  }

  async download() {
    if (!this.release || compareVersions(this.release.version, this.currentVersion) <= 0) await this.check();
    if (!this.release?.asset || !this.release?.checksums) throw new Error('No compatible update is available.');
    this.update({ phase: 'downloading', error: undefined, progress: 0 });
    try {
      const directory = path.join(this.userData, 'updates', this.release.tag || `v${this.release.version}`);
      await fsp.mkdir(directory, { recursive: true });
      const checksumText = await textRequest(this.release.checksums.browser_download_url);
      const expected = checksumFor(checksumText, this.release.asset.name);
      if (!expected) throw new Error(`SHA256SUMS.txt does not contain ${this.release.asset.name}.`);
      const archive = path.join(directory, this.release.asset.name);
      await download(this.release.asset.browser_download_url, archive, ({ percent, transferred, total }) => this.update({ phase: 'downloading', progress: percent, transferred, total }));
      const actual = await sha256(archive);
      if (actual !== expected) throw new Error('Downloaded update failed SHA-256 verification. The file was not installed.');
      this.downloaded = { archive, expected, directory };
      await this.prepare();
      return this.update({ phase: 'ready', progress: 100, downloadedPath: archive, verified: true });
    } catch (error) {
      this.update({ phase: 'error', error: error.message || String(error) });
      throw error;
    }
  }

  async prepare() {
    if (!this.downloaded) throw new Error('Download the update first.');
    const staging = path.join(this.downloaded.directory, 'staging');
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', this.downloaded.archive, staging]);
    const stagedApp = path.join(staging, 'Constellation.app');
    const plist = path.join(stagedApp, 'Contents', 'Info.plist');
    const [{ stdout: bundleId }, { stdout: version }] = await Promise.all([
      execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]),
      execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]),
    ]);
    if (bundleId.trim() !== 'com.shoko.constellation') throw new Error('The downloaded app has an unexpected bundle identifier.');
    if (normalizeVersion(version) !== normalizeVersion(this.release.version)) throw new Error('The downloaded app version does not match the GitHub release.');
    this.preparedApp = stagedApp;
  }

  async install() {
    if (!this.preparedApp || this.state.phase !== 'ready') throw new Error('Download and verify the update first.');
    const currentApp = path.resolve(this.execPath, '..', '..', '..');
    if (!currentApp.endsWith('.app') || path.basename(currentApp) !== 'Constellation.app') throw new Error('Automatic replacement is available only from the packaged Constellation app.');
    if (currentApp.startsWith('/Volumes/')) throw new Error('Move Constellation to Applications before installing updates.');
    await fsp.access(path.dirname(currentApp), fs.constants.W_OK);
    const backup = path.join(path.dirname(currentApp), `.Constellation.app.previous-${Date.now()}`);
    const script = path.join(this.downloaded.directory, 'install-update.sh');
    const marker = path.join(this.userData, 'pending-update-cleanup.json');
    await fsp.writeFile(marker, `${JSON.stringify({ backup, target: currentApp })}\n`, { mode: 0o600 });
    await fsp.writeFile(script, `#!/bin/sh\nPID="$1"\nTARGET="$2"\nSTAGED="$3"\nBACKUP="$4"\nCOUNT=0\nwhile kill -0 "$PID" 2>/dev/null && [ "$COUNT" -lt 150 ]; do sleep 0.2; COUNT=$((COUNT + 1)); done\nif [ -e "$TARGET" ]; then mv "$TARGET" "$BACKUP" || exit 1; fi\nif mv "$STAGED" "$TARGET"; then open "$TARGET"; exit 0; fi\nif [ -e "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; open "$TARGET"; fi\nexit 1\n`, { mode: 0o700 });
    const child = require('node:child_process').spawn('/bin/sh', [script, String(process.pid), currentApp, this.preparedApp, backup], { detached: true, stdio: 'ignore' });
    child.unref();
    return this.update({ phase: 'installing' });
  }
}

module.exports = { GitHubReleaseUpdater, compareVersions, normalizeVersion, checksumFor };
