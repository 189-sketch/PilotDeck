import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const probe = fileURLToPath(new URL('./verify-runtime-pty.cjs', import.meta.url));
for (const scenario of ['success', 'missing-native', 'spawn-failure', 'wrong-output']) {
  test(`runtime PTY probe: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'pilotdeck-pty-'));
    try {
      const moduleRoot = join(root, 'node_modules', 'node-pty');
      mkdirSync(moduleRoot, { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(moduleRoot, 'index.js'), scenario === 'missing-native'
        ? "require('./prebuilds/linux-arm64/pty.node');"
        : `exports.spawn = () => {
          ${scenario === 'spawn-failure' ? "throw new Error('spawn failed');" : ''}
          return {
            onData(cb) { setImmediate(() => cb(${JSON.stringify(scenario === 'wrong-output' ? 'unexpected' : 'pilotdeck-pty-ok')})); },
            onExit(cb) { setImmediate(() => cb({ exitCode: 0 })); },
            kill() {},
          };
        };`);
      const result = spawnSync(process.execPath, [probe, root], {
        encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '' },
      });
      assert.ifError(result.error);
      if (scenario === 'success') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PASS/);
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, scenario === 'missing-native' ? /pty\.node/ : scenario === 'spawn-failure' ? /spawn failed/ : /AssertionError/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
