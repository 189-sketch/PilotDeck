import * as fs from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideOrEqual } from '../utils/pathSafety.js';
import { isDesktopRuntimeProjectPath, resolvePilotHome } from '../utils/pilotPaths.js';
import { ensureGeneralWorkspaceDirectory } from '../utils/generalWorkspace.js';

export function forbiddenPath() {
  return Object.assign(new Error('Project path is forbidden'), { code: 'PROJECT_PATH_FORBIDDEN', status: 403 });
}

// Canonicalize existing ancestors as well as paths that have not been created yet.
async function canonicalPath(target) {
  try { return await fs.realpath(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling link is not a safe missing destination.
    if ((await fs.lstat(target).catch(() => null))?.isSymbolicLink()) throw forbiddenPath();
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await canonicalPath(parent), path.basename(target));
  }
}

export async function createProjectFileAccess(projectRoot, env = process.env) {
  const root = path.resolve(projectRoot);
  const canonicalRoot = await fs.realpath(root);
  const protectedPaths = [resolvePilotHome(env)];
  if (env.PILOTDECK_DESKTOP === '1' && env.PILOTDECK_DESKTOP_RUNTIME_ROOT) protectedPaths.push(path.resolve(env.PILOTDECK_DESKTOP_RUNTIME_ROOT));
  const protectedRealPaths = await Promise.all(protectedPaths.map(canonicalPath));
  const assertNoRuntimeDescendant = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (isDesktopRuntimeProjectPath(child, env)) throw forbiddenPath();
      await assertNoRuntimeDescendant(child);
    }
  };
  const assertAllowed = (lexical, real, destructive = false) => {
    if (!isPathInsideOrEqual(root, lexical) || !isPathInsideOrEqual(canonicalRoot, real)) throw forbiddenPath();
    for (const target of [lexical, real]) {
      let ancestor = target;
      while (true) {
        if (isDesktopRuntimeProjectPath(ancestor, env)) throw forbiddenPath();
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    for (const protectedRoot of [...protectedPaths, ...protectedRealPaths]) {
      if (isPathInsideOrEqual(protectedRoot, lexical) || isPathInsideOrEqual(protectedRoot, real)
        || (destructive && (isPathInsideOrEqual(lexical, protectedRoot) || isPathInsideOrEqual(real, protectedRoot)))) throw forbiddenPath();
    }
  };
  assertAllowed(root, canonicalRoot);
  if (!(await fs.stat(canonicalRoot)).isDirectory()) throw Object.assign(new Error('Project directory not found'), { status: 404, code: 'PROJECT_NOT_FOUND' });
  const resolve = async (value = '', { write = false, destructive = false } = {}) => {
    if (typeof value !== 'string' || value.includes('\0')) throw forbiddenPath();
    let target = path.resolve(root, value);
    // Read helpers may pass back a canonical path (e.g. /private/var on macOS).
    if (path.isAbsolute(value) && !isPathInsideOrEqual(root, target) && isPathInsideOrEqual(canonicalRoot, target)) {
      target = path.resolve(root, path.relative(canonicalRoot, target));
    }
    if (!isPathInsideOrEqual(root, target)) throw forbiddenPath();
    if (write) {
      let current = root;
      for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
        current = path.join(current, part);
        const info = await fs.lstat(current).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (info?.isSymbolicLink()) throw forbiddenPath();
      }
    }
    const real = await canonicalPath(target);
    assertAllowed(target, real, destructive);
    if (destructive && env.PILOTDECK_DESKTOP === '1') await assertNoRuntimeDescendant(target);
    return write ? target : real;
  };
  return { root, canonicalRoot, resolve };
}

export function sendProjectFileError(res, error) {
  if (error?.code === 'PROJECT_NOT_FOUND' || error?.code === 'PROJECT_PATH_FORBIDDEN') {
    res.status(error.status || 403).json({ error: { code: error.code, message: error.message } });
    return true;
  }
  return false;
}

export function createProjectFileMiddleware({ resolveProject, env = process.env, attachments = false }) {
  return async (req, res, next) => {
    try {
      let root = await resolveProject(req.params.projectName);
      if (attachments && path.resolve(root) === path.resolve(resolvePilotHome(env))) root = await ensureGeneralWorkspaceDirectory(env);
      req.projectFiles = await createProjectFileAccess(root, env);
      next();
    } catch (error) {
      if (!sendProjectFileError(res, error)) res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: { code: error.code === 'ENOENT' ? 'PROJECT_NOT_FOUND' : 'PROJECT_FILES_FAILED', message: error.message } });
    }
  };
}
