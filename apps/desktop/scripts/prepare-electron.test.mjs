import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { get } from 'node:http';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundedDownloader, downloadTimeouts, electronDownloadOptions, prepareElectron } from './prepare-electron.mjs';

test('downloader enforces connection and total timeout', async () => {
  const request = () => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = error => req.emit('error', error);
    return req;
  };
  await assert.rejects(boundedDownloader(request, { connect: 10, socket: 100, request: 100 }).download('unused', 'unused'), /connection timeout/);
  await assert.rejects(boundedDownloader(request, { connect: 100, socket: 100, request: 10 }).download('unused', 'unused'), /total timeout/);
});

test('downloader follows redirects and aborts stalled responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pilotdeck-electron-http-'));
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/file' }); res.end(); }
    else if (req.url === '/file') res.end('electron archive');
    else { res.writeHead(200); res.write('partial'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const downloader = boundedDownloader(get, { connect: 1000, socket: 30, request: 1000 });
    await downloader.download(`${url}/redirect`, join(root, 'archive'));
    await assert.rejects(downloader.download(`${url}/stall`, join(root, 'partial')), /idle timeout|aborted/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('official, China and explicit Electron mirrors resolve the correct version directory', () => {
  assert.deepEqual(electronDownloadOptions('42.11.1', 'x64', {}).mirrorOptions,
    { mirror: 'https://github.com/electron/electron/releases/download/', customDir: 'v42.11.1' });
  assert.deepEqual(electronDownloadOptions('42.11.1', 'x64', { PILOTDECK_DESKTOP_DOWNLOAD_MIRROR: 'china' }).mirrorOptions,
    { mirror: 'https://cdn.npmmirror.com/binaries/electron/', customDir: '{{ version }}' });
  const options = electronDownloadOptions('42.11.1', 'arm64', {
    PILOTDECK_DESKTOP_DOWNLOAD_MIRROR: 'china', ELECTRON_MIRROR: 'https://example.test', ELECTRON_CUSTOM_DIR: 'release',
  });
  assert.deepEqual(options.mirrorOptions, { mirror: 'https://example.test/', customDir: 'release' });
  assert.deepEqual(downloadTimeouts, { connect: 15000, socket: 60000, request: 900000 });
});

test('CLI exits unsuccessfully when preparation fails', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare-electron.mjs', import.meta.url))], {
    env: { ...process.env, PILOTDECK_DESKTOP_NODE_ARCH: 'unsupported' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported Linux Electron architecture/);
});

for (const scenario of ['download', 'cached', 'wrong-arch', 'timeout']) {
  test(`Electron preparation: ${scenario}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pilotdeck-electron-')));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      const electron = join(root, 'node_modules/electron');
      mkdirSync(join(electron, 'dist'), { recursive: true });
      writeFileSync(join(electron, 'package.json'), JSON.stringify({ version: '42.11.1' }));
      writeFileSync(join(electron, 'checksums.json'), '{}');
      if (scenario === 'cached' || scenario === 'wrong-arch') {
        const binary = Buffer.alloc(20);
        binary.set([127, 69, 76, 70]);
        binary.writeUInt16LE(scenario === 'cached' ? 62 : 183, 18);
        writeFileSync(join(electron, 'dist/electron'), binary);
        writeFileSync(join(electron, 'dist/version'), '42.11.1');
      }
      let attempts = 0;
      const action = () => prepareElectron({ desktopRoot: root, arch: 'x64', env: {},
        download: async options => {
          attempts++;
          assert.equal(options.version, '42.11.1');
          if (scenario === 'timeout') throw new Error('Request timed out');
          return '/cached/electron.zip';
        }, extract: async (archive, options) => {
          assert.equal(archive, '/cached/electron.zip');
          assert.equal(options.dir, join(electron, 'dist'));
        } });
      if (scenario === 'timeout') {
        await assert.rejects(action, /after 3 attempts/);
        assert.equal(attempts, 3);
      } else {
        assert.equal(await action(), join(electron, 'dist'));
        assert.equal(attempts, scenario === 'cached' ? 0 : 1);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
