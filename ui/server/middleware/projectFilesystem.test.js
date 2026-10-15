// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectFilesystemMiddleware } from './projectFilesystem.js';
import { isPathInsideOrEqual } from '../utils/pathSafety.js';
import { createWorkspaceFileUploadHandler, createWorkspaceUploadCheckHandler } from '../services/workspaceFileUpload.js';

let root, home, workspace, server, url;
const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');

// Mount the production handlers without starting the gateway, database or UI.
function mountReportedHandlers(app, authenticateToken, requireRealProjectFilesystem) {
    for (const [method, suffix] of [['get', 'file'], ['get', 'files/content'], ['put', 'file'], ['delete', 'files']]) {
        const start = source.indexOf(`app.${method}('/api/projects/:projectName/${suffix}',`);
        const end = source.indexOf('\n});', start) + '\n});'.length;
        expect(start).toBeGreaterThan(-1);
        const register = new Function('app', 'authenticateToken', 'requireRealProjectFilesystem', 'fsPromises', 'path', 'isPathInsideOrEqual', 'resolvePathInProject', 'validatePathInProject', 'mime', 'streamFileWithRange', source.slice(start, end));
        const helper = name => {
            const start = source.indexOf(`function ${name}(`);
            const end = source.indexOf('\n}', start) + 2;
            return new Function('path', 'isPathInsideOrEqual', `${source.slice(start, end)}; return ${name};`)(path, isPathInsideOrEqual);
        };
        register(app, authenticateToken, requireRealProjectFilesystem, fs, path, isPathInsideOrEqual, helper('resolvePathInProject'), helper('validatePathInProject'),
            { lookup: () => 'application/octet-stream' }, async (_req, res, target) => res.send(await fs.readFile(target)));
    }
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'reported-project-injection-'));
    home = path.join(root, 'state');
    workspace = path.join(root, 'workspace');
    await fs.mkdir(path.join(home, 'projects', 'demo'), { recursive: true });
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(home, 'projects/demo/.cwd'), workspace);
    await fs.writeFile(path.join(home, 'auth.db'), 'fake-auth-database');
    await fs.writeFile(path.join(home, 'server-token'), 'fake-server-token');
    await fs.writeFile(path.join(workspace, 'normal.txt'), 'normal');
    const app = express();
    app.use(express.json());
    const authenticateToken = (req, res, next) => req.headers.authorization === 'Bearer test' ? next() : res.sendStatus(401);
    const guard = createProjectFilesystemMiddleware({ env: { PILOT_HOME: home } });
    mountReportedHandlers(app, authenticateToken, guard);
    const resolveProject = () => { throw new Error('Upload must use the root authorized by middleware'); };
    app.post('/api/projects/:projectName/files/upload/check', authenticateToken, guard, createWorkspaceUploadCheckHandler({ resolveProject }));
    app.post('/api/projects/:projectName/files/upload', authenticateToken, guard, createWorkspaceFileUploadHandler({ resolveProject }));
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

describe('reported project root injection', () => {
    it('rejects unauthenticated access and unregistered absolute/dash roots for read, download, write, delete and upload', async () => {
        expect((await fetch(`${url}${encodeURIComponent(root)}/file?filePath=state/server-token`)).status).toBe(401);
        for (const name of ['/root', '/etc', root, '-root', '-etc', 'unknown']) {
            for (const args of [
                ['/file?filePath=state/server-token'], ['/files/content?path=state/auth.db'],
                ['/file', 'PUT', { filePath: 'marker', content: 'changed' }],
                ['/files', 'DELETE', { path: 'marker' }],
                ['/files/upload/check', 'POST', { relativePaths: ['marker'] }],
            ]) {
                const response = await request(name, ...args);
                expect(response.status).toBe(404);
                expect((await response.json()).error.code).toBe('PROJECT_NOT_FOUND');
            }
            const form = new FormData();
            form.append('files', new Blob(['changed']), 'marker');
            expect((await fetch(`${url}${encodeURIComponent(name)}/files/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form })).status).toBe(404);
        }
        expect(await fs.readFile(path.join(home, 'auth.db'), 'utf8')).toBe('fake-auth-database');
        expect(await fs.readFile(path.join(home, 'server-token'), 'utf8')).toBe('fake-server-token');
        await expect(fs.access(path.join(root, 'marker'))).rejects.toThrow();
    });

    it('rejects registered PILOT_HOME, descendants and parents', async () => {
        for (const [id, location] of [['parent', root], ['home', home], ['child', path.join(home, 'projects')]]) {
            await fs.mkdir(path.join(home, 'projects', id));
            await fs.writeFile(path.join(home, 'projects', id, '.cwd'), location);
            for (const suffix of ['/file?filePath=state/server-token', '/files/content?path=auth.db']) {
                const response = await request(id, suffix);
                expect(response.status).toBe(403);
                expect((await response.json()).error.code).toBe('PROJECT_PATH_FORBIDDEN');
            }
        }
        expect((await request('general', '/file?filePath=server-token')).status).toBe(403);
    });

    it('keeps legitimate project read, download, write, delete and upload behavior', async () => {
        expect((await (await request('demo', '/file?filePath=normal.txt')).json()).content).toBe('normal');
        expect(await (await request(workspace, '/files/content?path=normal.txt')).text()).toBe('normal');
        expect((await request('demo', '/file', 'PUT', { filePath: 'normal.txt', content: 'edited' })).status).toBe(200);
        expect(await fs.readFile(path.join(workspace, 'normal.txt'), 'utf8')).toBe('edited');
        expect((await request('demo', '/files/upload/check', 'POST', { relativePaths: ['new.txt'] })).status).toBe(200);
        const form = new FormData();
        form.append('files', new Blob(['upload']), 'new.txt');
        expect((await fetch(`${url}demo/files/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form })).status).toBe(200);
        expect(await fs.readFile(path.join(workspace, 'new.txt'), 'utf8')).toBe('upload');
        expect((await request('demo', '/files', 'DELETE', { path: 'new.txt' })).status).toBe(200);
        await expect(fs.access(path.join(workspace, 'new.txt'))).rejects.toThrow();
    });

    it('revalidates registrations and rejects missing workspaces', async () => {
        expect((await request('demo', '/file?filePath=normal.txt')).status).toBe(200);
        await fs.rm(path.join(home, 'projects/demo'), { recursive: true });
        expect((await request('demo', '/file?filePath=normal.txt')).status).toBe(404);
        await fs.mkdir(path.join(home, 'projects/demo'));
        await fs.writeFile(path.join(home, 'projects/demo/.cwd'), path.join(root, 'missing'));
        expect((await request('demo', '/file?filePath=normal.txt')).status).toBe(404);
    });

    it('wires every project file route to the guard and uses only its resolved root', () => {
        const fileRoutes = source.match(/app\.(?:get|put|post|delete)\('\/api\/projects\/:projectName\/(?:file(?:'|s[/'\w]*')|preview\/\*'|download')[^\n]*/g);
        expect(fileRoutes.length).toBe(15);
        for (const route of fileRoutes) expect(route).toContain('authenticateToken, requireRealProjectFilesystem');
        const start = source.indexOf('// Read file content endpoint');
        const end = source.indexOf("app.post('/api/projects/:projectName/files/upload',", start);
        const handlers = source.slice(start, end);
        expect(handlers).not.toContain('extractProjectDirectory(');
        expect(handlers).not.toContain('Fallback to simple dash replacement');
    });
});
