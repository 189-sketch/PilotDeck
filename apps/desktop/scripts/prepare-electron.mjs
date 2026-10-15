import { closeSync, createWriteStream, existsSync, openSync, readSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { get } from 'node:https';
import { get as getHttp } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isChinaMirrorPreset } from './download-sources.mjs';

export function electronDownloadOptions(version, arch, env = process.env) {
  const mirror = env.ELECTRON_MIRROR?.trim() || (isChinaMirrorPreset(env)
    ? 'https://cdn.npmmirror.com/binaries/electron/'
    : 'https://github.com/electron/electron/releases/download/');
  return {
    version, arch, platform: 'linux', artifactName: 'electron',
    cacheRoot: env.electron_config_cache || undefined,
    mirrorOptions: {
      mirror: mirror.replace(/\/*$/, '/'),
      customDir: env.ELECTRON_CUSTOM_DIR || (mirror.includes('npmmirror.com') ? '{{ version }}' : `v${version}`),
    },
    downloadOptions: {
      getProgressCallback: progress => {
        if (Date.now() - lastProgress >= 10_000) {
          console.log(`[desktop] Electron downloaded ${Math.round(progress.transferred / 1048576)} MB (${Math.round(progress.percent * 100)}%)`);
          lastProgress = Date.now();
        }
      },
    },
  };
}
let lastProgress = 0;

export const downloadTimeouts = { connect: 15_000, socket: 60_000, request: 900_000 };
export function boundedDownloader(request = (url, callback) =>
  (new URL(url).protocol === 'http:' ? getHttp : get)(url, callback), timeouts = downloadTimeouts) {
  return { async download(url, target, options = {}) {
    let req;
    let connectTimer;
    const totalTimer = setTimeout(() => req?.destroy(new Error('Electron download total timeout')), timeouts.request);
    try {
      await new Promise((resolveDownload, reject) => {
        const start = (currentUrl, redirects = 0) => {
          req = request(currentUrl, response => {
            clearTimeout(connectTimer);
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
              response.resume();
              if (redirects >= 10) reject(new Error('Too many Electron download redirects'));
              else start(new URL(response.headers.location, currentUrl).href, redirects + 1);
              return;
            }
            if (response.statusCode !== 200) {
              response.resume();
              reject(new Error(`Electron download HTTP ${response.statusCode}`));
              return;
            }
            let transferred = 0;
            const total = Number(response.headers['content-length']) || 0;
            const progress = new Transform({ transform(chunk, encoding, callback) {
              transferred += chunk.length;
              options.getProgressCallback?.({ transferred, total, percent: total ? transferred / total : 0 });
              callback(null, chunk);
            } });
            pipeline(response, progress, createWriteStream(target)).then(resolveDownload, reject);
          });
          connectTimer = setTimeout(() => req.destroy(new Error('Electron download connection timeout')), timeouts.connect);
          req.on('socket', socket => {
            if (req.reusedSocket) clearTimeout(connectTimer);
            else socket.once(socket.encrypted ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
          });
          req.setTimeout(timeouts.socket, () => req.destroy(new Error('Electron download idle timeout')));
          req.on('error', reject);
        };
        start(url);
      });
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
    }
  } };
}

export async function prepareElectron({ desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  env = process.env, arch = env.PILOTDECK_DESKTOP_NODE_ARCH || process.arch,
  download, extract } = {}) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Linux Electron architecture: ${arch}`);
  const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
  const electronRoot = dirname(desktopRequire.resolve('electron/package.json'));
  const electronRequire = createRequire(join(electronRoot, 'package.json'));
  const { version } = electronRequire('./package.json');
  const dist = join(electronRoot, 'dist');
  const binary = join(dist, 'electron');
  if (existsSync(binary) && existsSync(join(dist, 'version')) &&
      readFileSync(join(dist, 'version'), 'utf8').trim().replace(/^v/, '') === version) {
    const header = Buffer.alloc(20);
    const descriptor = openSync(binary, 'r');
    let bytesRead;
    try { bytesRead = readSync(descriptor, header, 0, header.length, 0); }
    finally { closeSync(descriptor); }
    if (bytesRead === 20 && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
        header.readUInt16LE(18) === (arch === 'x64' ? 62 : 183)) {
      writeFileSync(join(electronRoot, 'path.txt'), 'electron');
      console.log(`[desktop] Electron ${version} linux/${arch} already prepared: ${dist}`);
      return dist;
    }
  }
  const options = electronDownloadOptions(version, arch, env);
  options.downloader = boundedDownloader();
  options.checksums = electronRequire('./checksums.json');
  download ||= electronRequire('@electron/get').downloadArtifact;
  extract ||= electronRequire('@electron-internal/extract-zip').extract;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[desktop] Electron ${version} linux/${arch}: ${options.mirrorOptions.mirror} (attempt ${attempt}/3)`);
    try {
      const archive = await download(options);
      await extract(archive, { dir: dist });
      if (existsSync(join(dist, 'electron.d.ts'))) renameSync(join(dist, 'electron.d.ts'), join(electronRoot, 'electron.d.ts'));
      writeFileSync(join(electronRoot, 'path.txt'), 'electron');
      console.log(`[desktop] Electron ready: ${dist}`);
      return dist;
    } catch (error) {
      console.error(`[desktop] Electron attempt ${attempt} failed: ${error.message}`);
      if (attempt === 3) throw new Error(`Cannot prepare Electron ${version} linux/${arch} after 3 attempts`, { cause: error });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareElectron().catch(error => { console.error(error); process.exitCode = 1; });
}
