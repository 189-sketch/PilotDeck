import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelEvent } from '../../src/model/index.js';

test('gateway records main and title calls with routing disabled, without extra requests', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-usage-'));
  await mkdir(join(home, 'skills'));
  await writeFile(join(home, 'pilotdeck.yaml'), `
schemaVersion: 1
agent: { model: test/model, maxContextTokens: 65536, maxOutputTokens: 8192 }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: fixture
      models: { model: {} }
router: { enabled: false }
memory: { enabled: false }
telemetry: { enabled: false }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false, computer-use: false }
`);
  let streams = 0;
  let titles = 0;
  const local = createLocalGateway({
    pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'),
    env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: join(home, 'pilotdeck.yaml'), PILOT_AGENT_MODEL: undefined },
    __testModelFactory(snapshot) {
      return {
        ...createModelRuntime(snapshot.config.model),
        async *stream(): AsyncIterable<CanonicalModelEvent> {
          streams++;
          yield { type: 'message_start', role: 'assistant' };
          yield { type: 'text_delta', text: 'hello' };
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
          yield { type: 'message_end', finishReason: 'stop' };
        },
        async complete(request) {
          assert.equal(request.metadata?.purpose, 'session_title_generation');
          titles++;
          return { role: 'assistant', content: [{ type: 'text', text: '{"title":"Usage test"}' }], finishReason: 'stop', usage: { totalTokens: 5 } };
        },
      };
    },
  });
  t.after(async () => { local.dispose(); await rm(home, { recursive: true, force: true }); });
  const catalog = await local.gateway.modelCatalogList!({ includeAuto: true });
  assert.equal(catalog.router.autoAvailable, false);
  const events = [];
  for await (const event of local.gateway.submitTurn({ projectKey: home, sessionKey: 'web:usage', channelKey: 'web', message: 'hello' })) events.push(event);
  assert.ok(events.some(event => event.type === 'turn_completed'));
  assert.equal(events.some(event => event.type === 'error'), false);
  let records: number[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const dir = join(home, 'usage/daily');
      const files = await readdir(dir);
      records = (await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')))).join('').trim().split('\n').map(Number);
    }
    catch { /* asynchronous counter may not have flushed yet */ }
    if (records.length === 2) break;
    await setTimeout(10);
  }
  assert.equal(streams, 1);
  assert.equal(titles, 1);
  assert.deepEqual(records.sort((a, b) => a - b), [5, 120]);
});
