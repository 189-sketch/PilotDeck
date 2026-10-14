// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { createProjectFilesRouter } from './project-files.js';
import { resolveRegisteredProject } from '../services/projectRegistration.js';

let root, home, workspace, url, server;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-files-http-'));
  workspace = path.join(root, 'workspace');
  home = path.join(workspace, 'container', 'state');
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'auth.db'), 'fake-secret');
  await fs.writeFile(path.join(workspace, 'normal.txt'), 'normal');
  await fs.writeFile(path.join(workspace, 'index.html'), '<h1>preview</h1>');
  await fs.mkdir(path.join(home, 'projects', 'demo'), { recursive: true });
  await fs.writeFile(path.join(home, 'projects', 'demo', '.cwd'), workspace);
  const app = express();
  app.use(express.json());
  app.use(createProjectFilesRouter({
    env: { PILOT_HOME: home, WORKSPACES_ROOT: path.join(root, 'workspaces') },
    resolveProject: name => resolveRegisteredProject(name, home),
    authenticateToken: (req, res, next) => {
      if (req.headers.authorization !== 'Bearer test') return res.status(401).json({ error: 'Unauthenticated' });
      req.user = { id: 'file-boundary-test' };
      next();
    },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}/api/projects/`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});
const request = (name, suffix, method = 'GET', body) => fetch(`${url}${encodeURIComponent(name)}${suffix}`, {
  method, headers: { Authorization: 'Bearer test', ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function forbidden(response, status = 403) {
  expect(response.status).toBe(status);
  expect((await response.json()).error.code).toBe(status === 404 ? 'PROJECT_NOT_FOUND' : 'PROJECT_PATH_FORBIDDEN');
}
function uploadForm(name = 'new.txt', target = '') {
  const form = new FormData();
  form.append('targetPath', target);
  form.append('relativePaths', JSON.stringify([name]));
  form.append('files', new Blob(['upload']), path.basename(name));
  return form;
}

describe('production project file router', () => {
  it('rejects project root injection across file endpoints before accessing files', async () => {
    expect((await fetch(`${url}${encodeURIComponent('/etc')}/file?filePath=passwd`)).status).toBe(401);
    for (const name of ['/etc', '/root', root, '-etc', '-root', 'unknown']) {
      const operations = [
        ['/file?filePath=auth.db'], ['/files/content?path=auth.db'], ['/files'], ['/download'], ['/preview/index.html'],
        ['/files/preview/pdf?path=auth.db'], ['/files/preview/spreadsheet/data?path=auth.db'],
        ['/file', 'PUT', { filePath: 'marker', content: 'changed' }],
        ['/files', 'DELETE', { path: 'marker' }],
        ['/files/create', 'POST', { path: '', name: 'marker', type: 'file' }],
        ['/files/rename', 'PUT', { oldPath: 'marker', newName: 'other' }],
        ['/files/upload/check', 'POST', { relativePaths: ['marker'] }],
      ];
      for (const args of operations) await forbidden(await request(name, ...args), 404);
      await forbidden(await fetch(`${url}${encodeURIComponent(name)}/files/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: uploadForm() }), 404);
      const image = new FormData();
      image.append('images', new Blob(['fake-image'], { type: 'image/png' }), 'image.png');
      await forbidden(await fetch(`${url}${encodeURIComponent(name)}/upload-images`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: image }), 404);
      const attachment = new FormData();
      attachment.append('attachments', new Blob(['fake-attachment']), 'note.txt');
      await forbidden(await fetch(`${url}${encodeURIComponent(name)}/upload-attachments`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: attachment }), 404);
    }
    expect(await fs.readFile(path.join(home, 'auth.db'), 'utf8')).toBe('fake-secret');
    await expect(fs.access(path.join(root, 'marker'))).rejects.toThrow();
  });

  it('blocks protected paths and destructive ancestors and filters trees and archives', async () => {
    const secret = 'container/state/auth.db';
    for (const suffix of [`/file?filePath=${secret}`, `/files/content?path=${secret}`, `/preview/${secret}`, `/files/preview/pdf?path=${secret}`, `/files/preview/spreadsheet/manifest?path=${secret}`, `/files/preview/spreadsheet/data?path=${secret}`, `/files/preview/spreadsheet/sheet?path=${secret}&sheet=0`]) {
      await forbidden(await request('demo', suffix));
    }
    await forbidden(await request('demo', '/file', 'PUT', { filePath: secret, content: 'changed' }));
    await forbidden(await request('demo', '/files/create', 'POST', { path: 'container/state', name: 'new', type: 'file' }));
    for (const target of ['container/state', 'container', '.']) {
      await forbidden(await request('demo', '/files', 'DELETE', { path: target }));
      await forbidden(await request('demo', '/files/rename', 'PUT', { oldPath: target, newName: 'renamed' }));
    }
    await forbidden(await request('demo', '/files/upload/check', 'POST', { targetPath: 'container/state', relativePaths: ['new'] }));
    await forbidden(await fetch(`${url}demo/files/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: uploadForm('new', 'container/state') }));
    await fs.symlink(home, path.join(workspace, 'alias'));
    const tree = await (await request('demo', '/files')).json();
    expect(JSON.stringify(tree)).not.toContain('auth.db');
    expect(tree.map(item => item.name)).not.toContain('alias');
    const zip = await JSZip.loadAsync(await (await request('demo', '/download')).arrayBuffer());
    expect(Object.keys(zip.files).some(name => name.includes('state') || name.includes('alias'))).toBe(false);
    expect(await zip.file('normal.txt').async('string')).toBe('normal');
    expect(await fs.readFile(path.join(home, 'auth.db'), 'utf8')).toBe('fake-secret');
  });

  it('allows internal link reads but rejects escapes and every symlink mutation', async () => {
    await fs.symlink('normal.txt', path.join(workspace, 'internal'));
    await fs.symlink(root, path.join(workspace, 'outside'));
    await fs.symlink(path.join(root, 'missing'), path.join(workspace, 'dangling'));
    expect((await (await request('demo', '/file?filePath=internal')).json()).content).toBe('normal');
    for (const target of ['../other', `${workspace}-other/file`, 'outside/file', 'dangling', 'container/state/auth.db']) {
      await forbidden(await request('demo', `/file?filePath=${encodeURIComponent(target)}`));
    }
    for (const target of ['internal', 'outside/new/deep', 'dangling']) {
      await forbidden(await request('demo', '/file', 'PUT', { filePath: target, content: 'changed' }));
      await forbidden(await request('demo', '/files', 'DELETE', { path: target }));
      await forbidden(await request('demo', '/files/rename', 'PUT', { oldPath: target, newName: 'renamed' }));
    }
    await fs.mkdir(path.join(workspace, 'page'));
    await fs.symlink(path.join(home, 'auth.db'), path.join(workspace, 'page/index.html'));
    await forbidden(await request('demo', '/preview/page/'));
    await forbidden(await request('demo', '/file?filePath=x%00y'));
    await forbidden(await request('demo', '/file?filePath=normal.txt&filePath=index.html'));
    await forbidden(await request('demo', '/files/create', 'POST', { path: 'outside/new', name: 'created', type: 'file' }));
    await forbidden(await request('demo', '/files/create', 'POST', { path: {}, name: 'created', type: 'file' }));
    await forbidden(await request('demo', '/files/upload/check', 'POST', { targetPath: false, relativePaths: ['created'] }));
    await forbidden(await request('demo', '/files/upload/check', 'POST', { relativePaths: ['../escape'] }));
    expect(await fs.readFile(path.join(workspace, 'normal.txt'), 'utf8')).toBe('normal');
  });

  it('preserves normal reads, writes, creation, rename, preview, range, spreadsheet and upload', async () => {
    expect((await (await request(workspace, '/file?filePath=normal.txt')).json()).content).toBe('normal');
    expect((await request('demo', '/file', 'PUT', { filePath: path.join(workspace, 'normal.txt'), content: 'edited' })).status).toBe(200);
    expect((await request('demo', '/files/create', 'POST', { path: 'a/b', name: 'new.txt', type: 'file' })).status).toBe(200);
    expect((await request('demo', '/files/rename', 'PUT', { oldPath: 'a/b/new.txt', newName: 'renamed.txt' })).status).toBe(200);
    expect((await request('demo', '/files', 'DELETE', { path: 'a/b/renamed.txt' })).status).toBe(200);
    expect(await (await request('demo', '/preview/')).text()).toContain('<h1>preview</h1>');
    const ranged = await fetch(`${url}demo/files/content?path=normal.txt`, { headers: { Authorization: 'Bearer test', Range: 'bytes=0-1' } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('ed');
    await fs.mkdir(path.join(workspace, 'page'));
    await fs.writeFile(path.join(workspace, 'page/index.html'), '<p>nested</p>');
    expect(await (await request('demo', '/preview/page/')).text()).toContain('<p>nested</p>');
    expect((await request('demo', '/files/upload/check', 'POST', { targetPath: 'docs', relativePaths: ['new.txt'] })).status).toBe(200);
    const uploaded = await fetch(`${url}demo/files/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: uploadForm('new.txt', 'docs') });
    expect(uploaded.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, 'docs/new.txt'), 'utf8')).toBe('upload');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Data').getCell('A1').value = 'preview-cell';
    await workbook.xlsx.writeFile(path.join(workspace, 'sheet.xlsx'));
    const manifest = await request('demo', '/files/preview/spreadsheet/manifest?path=sheet.xlsx');
    expect(manifest.status).toBe(200);
    expect(JSON.stringify(await manifest.json())).toContain('Data');
    const data = await request('demo', '/files/preview/spreadsheet/data?path=sheet.xlsx');
    expect(data.status).toBe(200);
    expect(JSON.stringify(await data.json())).toContain('preview-cell');
  });

  it('keeps General files forbidden and moves new chat attachments to the General workspace', async () => {
    for (const name of ['general', home]) await forbidden(await request(name, '/files'));
    for (const name of ['general', 'demo']) {
      const form = new FormData();
      form.append('attachments', new Blob(['attachment']), 'note.txt');
      const response = await fetch(`${url}${name}/upload-attachments`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form });
      expect(response.status).toBe(200);
      const output = await response.json();
      const stored = output.files[0].path;
      expect(stored.startsWith(name === 'general' ? path.join(root, 'workspaces/general') : workspace)).toBe(true);
      expect(stored.startsWith(home)).toBe(false);
      expect(await fs.readFile(stored, 'utf8')).toBe('attachment');
    }
    const image = new FormData();
    image.append('images', new Blob(['fake-image'], { type: 'image/png' }), 'image.png');
    const imageResponse = await fetch(`${url}general/upload-images`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: image });
    expect(imageResponse.status).toBe(200);
    expect((await imageResponse.json()).images[0].data).toBe('data:image/png;base64,ZmFrZS1pbWFnZQ==');
    await vi.waitFor(async () => expect(await fs.readFile(path.join(home, 'auth.db'), 'utf8')).toBe('fake-secret'));
  });

  it('revalidates registration after a successful request', async () => {
    expect((await request('demo', '/files')).status).toBe(200);
    await fs.rm(path.join(home, 'projects/demo'), { recursive: true });
    await forbidden(await request('demo', '/files'), 404);
  });

  it('rejects a symlink staging directory and chat attachment target without changing secrets', async () => {
    await fs.symlink(home, path.join(workspace, '.tmp'));
    await forbidden(await fetch(`${url}demo/files/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: uploadForm() }));
    const form = new FormData();
    form.append('attachments', new Blob(['attachment']), 'note.txt');
    await forbidden(await fetch(`${url}demo/upload-attachments`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form }));
    expect(await fs.readFile(path.join(home, 'auth.db'), 'utf8')).toBe('fake-secret');
    await expect(fs.access(path.join(home, 'new.txt'))).rejects.toThrow();
  });
});
