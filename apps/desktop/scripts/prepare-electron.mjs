import { closeSync, createWriteStream, existsSync, openSync, readSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
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
export function boundedDownloader(request = globalThis.fetch, timeouts = downloadTimeouts) {
  return { async download(url, target, options = {}) {
    const controller = new AbortController();
    let response;
    let idleTimer;
    let connectTimer;
    const abort = message => controller.abort(new Error(`Electron download ${message} timeout`));
    const totalTimer = setTimeout(() => abort('total'), timeouts.request);
    try {
      for (let redirects = 0; ; redirects++) {
        connectTimer = setTimeout(() => abort('connection'), timeouts.connect);
        response = await request(url, { signal: controller.signal, redirect: 'manual' });
        clearTimeout(connectTimer);
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
          await response.body?.cancel();
          if (redirects >= 10) throw new Error('Too many Electron download redirects');
          url = new URL(response.headers.get('location'), url).href;
          continue;
        }
        if (response.status !== 200) throw new Error(`Electron download HTTP ${response.status}`);
        break;
      }
      let transferred = 0;
      const total = Number(response.headers.get('content-length')) || 0;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort('idle'), timeouts.socket);
      };
      resetIdleTimer();
      const progress = new Transform({ transform(chunk, encoding, callback) {
        resetIdleTimer();
        transferred += chunk.length;
        options.getProgressCallback?.({ transferred, total, percent: total ? transferred / total : 0 });
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(target), { signal: controller.signal });
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
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
  options.checksums = electronRequire('./checksums.json');
  if (!download) {
    const electronGet = electronRequire('@electron/get');
    download = electronGet.downloadArtifact;
    // Use the same dispatcher as @electron/get's ELECTRON_GET_USE_PROXY support.
    const getRequire = createRequire(electronRequire.resolve('@electron/get'));
    options.downloader = boundedDownloader(getRequire('undici').fetch);
  }
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
