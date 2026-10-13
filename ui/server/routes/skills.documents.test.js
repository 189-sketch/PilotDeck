// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let temporary, skillPath, router;
beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-documents-test-'));
  const root = path.join(temporary, 'skills');
  skillPath = path.join(root, 'example');
  await fs.mkdir(path.join(skillPath, 'references'), { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Skill');
  await fs.writeFile(path.join(skillPath, 'references', 'guide.md'), '# Guide');
  await fs.writeFile(path.join(temporary, 'outside.md'), 'private');
  await fs.symlink(path.join(temporary, 'outside.md'), path.join(skillPath, 'escape.md'));
  await fs.writeFile(path.join(skillPath, 'script.sh'), 'echo run');
  await fs.writeFile(path.join(skillPath, 'large.md'), 'a'.repeat(1024 * 1024 + 1));
  vi.stubEnv('PILOTDECK_BUNDLED_SKILLS_DIR', root);
  vi.resetModules();
  router = (await import('./skills.js')).default;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(temporary, { recursive: true, force: true });
});
async function invoke(endpoint, file) {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  await router.stack
    .find((layer) => layer.route?.path === endpoint)
    .route.stack[0].handle({ body: { skillPath, file } }, response);
  return response;
}
it('lists supporting text documents without scripts or symlink escapes', async () => {
  const response = await invoke('/documents');
  expect(response.json).toHaveBeenCalledWith({
    files: ['SKILL.md', 'large.md', 'references/guide.md'],
  });
});
it('reads a reference inside the skill folder', async () => {
  const response = await invoke('/read-document', 'references/guide.md');
  expect(response.json).toHaveBeenCalledWith({ file: 'references/guide.md', content: '# Guide' });
});
it.each(['../../outside.md', 'escape.md'])('rejects an escaping reference %s', async (file) => {
  expect((await invoke('/read-document', file)).status).toHaveBeenCalledWith(403);
});
it.each(['/etc/secret.md', 'script.sh'])('rejects unsupported document paths %s', async (file) => {
  expect((await invoke('/read-document', file)).status).toHaveBeenCalledWith(400);
});
it('bounds large documents and reports missing references', async () => {
  expect((await invoke('/read-document', 'large.md')).status).toHaveBeenCalledWith(413);
  expect((await invoke('/read-document', 'missing.md')).status).toHaveBeenCalledWith(404);
});
