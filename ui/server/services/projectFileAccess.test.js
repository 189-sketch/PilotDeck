// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectFileAccess } from './projectFileAccess.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it('checks lexical paths, existing ancestors, symlinks and protected subtrees', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-boundary-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const home = path.join(workspace, 'state');
  const outside = path.join(root, 'workspace-other');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(workspace, 'normal'), 'normal');
  await fs.symlink('normal', path.join(workspace, 'internal'));
  await fs.symlink(outside, path.join(workspace, 'external'));
  await fs.symlink(home, path.join(workspace, 'secret-link'));
  await fs.symlink(path.join(outside, 'missing'), path.join(workspace, 'dangling'));
  const access = await createProjectFileAccess(workspace, { PILOT_HOME: home });
  expect(await access.resolve('internal')).toBe(await fs.realpath(path.join(workspace, 'normal')));
  expect(await access.resolve('a/b/c', { write: true })).toBe(path.join(workspace, 'a/b/c'));
  for (const value of ['../workspace-other/file', outside, {}, 'x\0y', 'external/file', 'secret-link/token', 'state/token', 'dangling']) {
    await expect(access.resolve(value)).rejects.toMatchObject({ code: 'PROJECT_PATH_FORBIDDEN' });
  }
  for (const value of ['internal', 'external/new/deep', 'dangling']) {
    await expect(access.resolve(value, { write: true })).rejects.toMatchObject({ code: 'PROJECT_PATH_FORBIDDEN' });
  }
  await expect(access.resolve('.', { write: true, destructive: true })).rejects.toMatchObject({ code: 'PROJECT_PATH_FORBIDDEN' });
  await expect(createProjectFileAccess(home, { PILOT_HOME: home })).rejects.toMatchObject({ code: 'PROJECT_PATH_FORBIDDEN' });
});

it('protects canonical PILOT_HOME and desktop runtime descendants', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-paths-'));
  roots.push(root);
  const home = path.join(root, 'state');
  await fs.mkdir(home);
  const alias = path.join(root, 'alias');
  await fs.symlink(home, alias);
  const access = await createProjectFileAccess(root, { PILOT_HOME: alias, PILOTDECK_DESKTOP: '1', PILOTDECK_DESKTOP_RUNTIME_ROOT: path.join(root, 'app/resources/runtime') });
  for (const value of ['state/token', 'alias/token', 'app/resources/runtime/config', 'other/resources/runtime/data']) {
    await expect(access.resolve(value)).rejects.toMatchObject({ code: 'PROJECT_PATH_FORBIDDEN' });
  }
  await expect(access.resolve('app', { write: true, destructive: true })).rejects.toMatchObject({ code: 'PROJECT_PATH_FORBIDDEN' });
  await fs.mkdir(path.join(root, 'other/resources/runtime'), { recursive: true });
  await expect(access.resolve('other', { write: true, destructive: true })).rejects.toMatchObject({ code: 'PROJECT_PATH_FORBIDDEN' });
});
