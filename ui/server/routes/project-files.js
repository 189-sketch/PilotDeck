import express from 'express';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import mime from 'mime-types';
import JSZip from 'jszip';
import { contentDispositionAttachment } from '../utils/downloadHeaders.js';
import { createProjectFileMiddleware, sendProjectFileError } from '../services/projectFileAccess.js';
import { createWorkspaceFileUploadHandler, createWorkspaceUploadCheckHandler } from '../services/workspaceFileUpload.js';
import { OFFICE_PREVIEW_SERVICE_LIBREOFFICE, convertOfficeDocumentToPdf, getConfiguredOfficePreviewService } from '../services/officePreview.js';
import { SPREADSHEET_PREVIEW_EXTENSIONS, getSpreadsheetInteractivePreview, getSpreadsheetPreviewManifest, getSpreadsheetSheetPreviewPdf } from '../services/spreadsheetPreview.js';

async function resolvePathInProject(access, targetPath = '') {
    return { valid: true, resolved: await access.resolve(targetPath) };
}

function setPreviewContentType(res, filePath) {
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const charset = mimeType.startsWith('text/') || mimeType === 'application/javascript' || mimeType === 'application/json'
        ? '; charset=utf-8'
        : '';
    res.setHeader('Content-Type', `${mimeType}${charset}`);
}

function parseRangeHeader(rangeHeader, fileSize) {
    if (!rangeHeader) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!match) return { invalid: true };

    const [, startPart, endPart] = match;
    if (!startPart && !endPart) return { invalid: true };

    let start;
    let end;

    if (!startPart) {
        const suffixLength = Number.parseInt(endPart, 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            return { invalid: true };
        }
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
    } else {
        start = Number.parseInt(startPart, 10);
        end = endPart ? Number.parseInt(endPart, 10) : fileSize - 1;
    }

    if (
        !Number.isFinite(start)
        || !Number.isFinite(end)
        || start < 0
        || end < start
        || start >= fileSize
    ) {
        return { invalid: true };
    }

    return {
        start,
        end: Math.min(end, fileSize - 1),
    };
}

async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function streamFileWithRange(req, res, filePath, options = {}) {
    const stats = await fsPromises.stat(filePath);
    const fileSize = stats.size;
    const mimeType = options.mimeType || mime.lookup(filePath) || 'application/octet-stream';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    if (options.cacheControl) {
        res.setHeader('Cache-Control', options.cacheControl);
    }
    if (options.pragma) {
        res.setHeader('Pragma', options.pragma);
    }
    if (options.downloadFilename) {
        res.setHeader('Content-Disposition', contentDispositionAttachment(options.downloadFilename));
    }

    if (fileSize === 0) {
        res.setHeader('Content-Length', '0');
        res.status(200).end();
        return;
    }

    const range = parseRangeHeader(req.headers.range, fileSize);
    if (range?.invalid) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
    }

    const streamOptions = range ? { start: range.start, end: range.end } : undefined;
    if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
        res.setHeader('Content-Length', String(fileSize));
    }

    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    const fileStream = fs.createReadStream(filePath, streamOptions);
    fileStream.pipe(res);
    fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error reading file' });
        } else {
            res.destroy(error);
        }
    });
}

const OFFICE_PDF_PREVIEW_EXTENSIONS = new Set([
    'doc', 'docx', 'wps',
    'xls', 'xlsx', 'et',
    'ppt', 'pptx', 'dps',
    'odt', 'ods', 'odp',
]);

const getFileExtension = (filePath) => path.extname(filePath).slice(1).toLowerCase();

async function addDirectoryToZip(zip, directoryPath, rootPath, access) {
    const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
        const absolutePath = path.join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) continue;
        try { await access.resolve(absolutePath); }
        catch (error) { if (error.code === 'PROJECT_PATH_FORBIDDEN') continue; throw error; }
        const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join('/');

        if (!relativePath) {
            continue;
        }

        if (entry.isDirectory()) {
            zip.folder(relativePath);
            await addDirectoryToZip(zip, absolutePath, rootPath, access);
            continue;
        }

        if (entry.isFile()) {
            const [content, stats] = await Promise.all([
                fsPromises.readFile(absolutePath),
                fsPromises.stat(absolutePath),
            ]);
            zip.file(relativePath, content, { date: stats.mtime });
        }
    }
}

function getSafeZipFilename(projectName) {
    const safeName = String(projectName || 'project')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
        .replace(/^\.+$/, 'project')
        .trim() || 'project';
    return `${safeName}.zip`;
}

function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true, access) {
    // Using fsPromises from import
    const items = [];

    try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            // Debug: log all entries including hidden files


            // Skip heavy build directories and VCS directories
            if (entry.name === 'node_modules' ||
                entry.name === 'dist' ||
                entry.name === 'build' ||
                entry.name.startsWith('.pilotdeck') ||
                entry.name === '.tmp' ||
                /^\.pilotdeck_build\.(?:c|m)?js$/i.test(entry.name) ||
                entry.name === '.git' ||
                entry.name === '.svn' ||
                entry.name === '.hg') continue;

            const itemPath = path.join(dirPath, entry.name);
            if (entry.isSymbolicLink()) continue;
            try { await access.resolve(itemPath); }
            catch (error) { if (error.code === 'PROJECT_PATH_FORBIDDEN') continue; throw error; }
            const item = {
                name: entry.name,
                path: itemPath,
                type: entry.isDirectory() ? 'directory' : 'file'
            };

            // Get file stats for additional metadata
            try {
                const stats = await fsPromises.stat(itemPath);
                item.size = stats.size;
                item.modified = stats.mtime.toISOString();

                // Convert permissions to rwx format
                const mode = stats.mode;
                const ownerPerm = (mode >> 6) & 7;
                const groupPerm = (mode >> 3) & 7;
                const otherPerm = mode & 7;
                item.permissions = ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
                item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
            } catch (statError) {
                // If stat fails, provide default values
                item.size = 0;
                item.modified = null;
                item.permissions = '000';
                item.permissionsRwx = '---------';
            }

            if (entry.isDirectory() && currentDepth < maxDepth) {
                // Recursively get subdirectories but limit depth
                try {
                    // Check if we can access the directory before trying to read it
                    await fsPromises.access(item.path, fs.constants.R_OK);
                    item.children = await getFileTree(item.path, maxDepth, currentDepth + 1, showHidden, access);
                } catch (e) {
                    // Silently skip directories we can't access (permission denied, etc.)
                    item.children = [];
                }
            }

            items.push(item);
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
    }

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

export function createProjectFilesRouter({ authenticateToken, resolveProject, env = process.env, officePreviewPdfRateLimiter = (_req, _res, next) => next() }) {
    const router = express.Router();
    const requireRealProjectFilesystem = createProjectFileMiddleware({ resolveProject, env });
    const requireAttachmentFilesystem = createProjectFileMiddleware({ resolveProject, env, attachments: true });
    // Read file content endpoint
    router.get('/api/projects/:projectName/file', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { filePath } = req.query;


            // Security: ensure the requested path is inside the project root
            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            const projectRoot = req.projectFiles.root;

            const resolved = await req.projectFiles.resolve(filePath);

            const content = await fsPromises.readFile(resolved, 'utf8');
            res.json({ content, path: resolved });
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error reading file:', error);
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File not found' });
            } else if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // Serve raw file bytes for previews and downloads.
    router.get('/api/projects/:projectName/files/content', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { path: filePath } = req.query;

            // Security: ensure the requested path is inside the project root
            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            const projectRoot = req.projectFiles.root;

            const resolvedResult = await resolvePathInProject(req.projectFiles, filePath);

            const resolved = resolvedResult.resolved;
            const stats = await fsPromises.stat(resolved).catch(() => null);
            if (!stats?.isFile()) {
                return res.status(404).json({ error: 'File not found' });
            }

            const mimeType = mime.lookup(resolved) || 'application/octet-stream';
            if (req.method === 'HEAD' && (req.query.sha256 === '1' || req.query.sha256 === 'true')) {
                res.setHeader('X-PilotDeck-Content-SHA256', await sha256File(resolved));
            }
            await streamFileWithRange(req, res, resolved, {
                mimeType,
                downloadFilename: req.query.download ? path.basename(resolved) : null,
            });

        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error serving binary file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // Convert Office files to PDF for lightweight read-only preview.
    // This is an optional fallback for legacy Office/PPT formats; it only works
    // when LibreOffice/soffice is available on the host.
    router.get('/api/projects/:projectName/files/preview/pdf', authenticateToken, requireRealProjectFilesystem, officePreviewPdfRateLimiter, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { path: filePath } = req.query;
            const force = req.query.force === '1' || req.query.force === 'true';

            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            const projectRoot = req.projectFiles.root;

            const resolvedResult = await resolvePathInProject(req.projectFiles, filePath);

            const resolved = resolvedResult.resolved;
            const extension = getFileExtension(resolved);
            if (!OFFICE_PDF_PREVIEW_EXTENSIONS.has(extension)) {
                return res.status(400).json({ error: 'Unsupported Office preview format' });
            }

            const stats = await fsPromises.stat(resolved).catch(() => null);
            if (!stats?.isFile()) {
                return res.status(404).json({ error: 'File not found' });
            }

            const officePreviewService = getConfiguredOfficePreviewService();
            if (officePreviewService !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
                return res.status(409).json({
                    error: 'LibreOffice preview service is not selected',
                    code: 'LIBREOFFICE_PREVIEW_NOT_SELECTED',
                });
            }

            const pdfPath = await convertOfficeDocumentToPdf(resolved, { force, projectRoot: req.projectFiles.canonicalRoot });
            await streamFileWithRange(req, res, pdfPath, {
                mimeType: 'application/pdf',
                cacheControl: 'no-store, no-cache, must-revalidate',
                pragma: 'no-cache',
            });
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error generating Office PDF preview:', error);
            if (!res.headersSent) {
                res.status(error.statusCode || 500).json({
                    error: error.code === 'LIBREOFFICE_NOT_FOUND'
                        ? 'LibreOffice executable not found'
                        : error.code === 'OFFICE_PREVIEW_DISABLED'
                            ? 'Office preview service is disabled'
                            : 'Failed to generate Office PDF preview',
                    code: error.code || 'OFFICE_PREVIEW_FAILED',
                });
            }
        }
    });

    // Preserve workbook semantics for spreadsheet previews. The manifest exposes
    // visible worksheet tabs, while each worksheet is rendered as its own PDF so
    // multi-page sheets remain grouped under one tab in the UI.
    router.get('/api/projects/:projectName/files/preview/spreadsheet/manifest', authenticateToken, requireRealProjectFilesystem, officePreviewPdfRateLimiter, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { path: filePath } = req.query;
            const force = req.query.force === '1' || req.query.force === 'true';

            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            const projectRoot = req.projectFiles.root;
            const resolvedResult = await resolvePathInProject(req.projectFiles, filePath);
            const extension = getFileExtension(resolvedResult.resolved);
            if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
                return res.status(400).json({ error: 'Unsupported spreadsheet preview format' });
            }
            if (
                extension !== 'xlsx'
                && getConfiguredOfficePreviewService() !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE
            ) {
                return res.status(409).json({
                    error: 'Legacy spreadsheet preview requires LibreOffice',
                    code: 'LIBREOFFICE_PREVIEW_NOT_SELECTED',
                });
            }
            const manifest = await getSpreadsheetPreviewManifest(resolvedResult.resolved, { force });
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            return res.json(manifest);
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error reading spreadsheet preview manifest:', error);
            return res.status(error.statusCode || 500).json({
                error: error.message || 'Failed to read spreadsheet preview manifest',
                code: error.code || 'SPREADSHEET_PREVIEW_MANIFEST_FAILED',
            });
        }
    });

    router.get('/api/projects/:projectName/files/preview/spreadsheet/data', authenticateToken, requireRealProjectFilesystem, officePreviewPdfRateLimiter, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { path: filePath } = req.query;
            const force = req.query.force === '1' || req.query.force === 'true';

            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            const projectRoot = req.projectFiles.root;
            const resolvedResult = await resolvePathInProject(req.projectFiles, filePath);
            const extension = getFileExtension(resolvedResult.resolved);
            if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
                return res.status(400).json({ error: 'Unsupported spreadsheet preview format' });
            }
            if (
                extension !== 'xlsx'
                && getConfiguredOfficePreviewService() !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE
            ) {
                return res.status(409).json({
                    error: 'Legacy spreadsheet preview requires LibreOffice',
                    code: 'LIBREOFFICE_PREVIEW_NOT_SELECTED',
                });
            }

            const preview = await getSpreadsheetInteractivePreview(
                resolvedResult.resolved,
                { force },
            );
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            return res.json(preview);
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error generating interactive spreadsheet preview:', error);
            return res.status(error.statusCode || 500).json({
                error: error.statusCode
                    ? error.message
                    : 'Unable to generate spreadsheet preview. Please retry.',
                code: error.code || 'SPREADSHEET_INTERACTIVE_PREVIEW_FAILED',
            });
        }
    });

    router.get('/api/projects/:projectName/files/preview/spreadsheet/sheet', authenticateToken, requireRealProjectFilesystem, officePreviewPdfRateLimiter, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { path: filePath, sheet: sheetIndex } = req.query;
            const force = req.query.force === '1' || req.query.force === 'true';

            if (!filePath || sheetIndex === undefined) {
                return res.status(400).json({ error: 'File path and worksheet index are required' });
            }

            const projectRoot = req.projectFiles.root;
            const resolvedResult = await resolvePathInProject(req.projectFiles, filePath);
            const extension = getFileExtension(resolvedResult.resolved);
            if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
                return res.status(400).json({ error: 'Unsupported spreadsheet preview format' });
            }
            const officePreviewService = getConfiguredOfficePreviewService();
            if (officePreviewService !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
                return res.status(409).json({
                    error: 'LibreOffice preview service is not selected',
                    code: 'LIBREOFFICE_PREVIEW_NOT_SELECTED',
                });
            }

            const pdfPath = await getSpreadsheetSheetPreviewPdf(
                resolvedResult.resolved,
                Number(sheetIndex),
                { force },
            );
            await streamFileWithRange(req, res, pdfPath, {
                mimeType: 'application/pdf',
                cacheControl: 'no-store, no-cache, must-revalidate',
                pragma: 'no-cache',
            });
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error generating worksheet PDF preview:', error);
            if (!res.headersSent) {
                res.status(error.statusCode || 500).json({
                    error: error.message || 'Failed to generate worksheet preview',
                    code: error.code || 'SPREADSHEET_SHEET_PREVIEW_FAILED',
                });
            }
        }
    });

    // Serve project files through a stable project-root URL so generated HTML can
    // load sibling CSS, JS and image assets with normal relative paths.
    router.get('/api/projects/:projectName/preview/*', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {
            const { projectName } = req.params;
            const relativeFilePath = req.params[0] || 'index.html';

            const projectRoot = req.projectFiles.root;

            const resolvedResult = await resolvePathInProject(req.projectFiles, relativeFilePath);

            let resolved = resolvedResult.resolved;
            let stats = await fsPromises.stat(resolved).catch(() => null);
            if (stats?.isDirectory()) {
                resolved = await req.projectFiles.resolve(path.join(resolved, 'index.html'));
                stats = await fsPromises.stat(resolved).catch(() => null);
            }

            if (!stats || !stats.isFile()) {
                return res.status(404).type('text/plain').send('Preview file not found.');
            }

            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            setPreviewContentType(res, resolved);
            fs.createReadStream(resolved).pipe(res);
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error serving project preview:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Download the complete project as a zip archive.
    router.get('/api/projects/:projectName/download', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {
            const { projectName } = req.params;
            const projectRoot = req.projectFiles.root;

            const rootStats = await fsPromises.stat(projectRoot).catch(() => null);
            if (!rootStats?.isDirectory()) {
                return res.status(404).json({ error: 'Project directory not found' });
            }

            const zip = new JSZip();
            await addDirectoryToZip(zip, projectRoot, projectRoot, req.projectFiles);

            const filename = getSafeZipFilename(projectName);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', contentDispositionAttachment(filename));

            const zipStream = zip.generateNodeStream({
                type: 'nodebuffer',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 },
            });
            zipStream.on('error', (error) => {
                console.error('Error streaming project zip:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Failed to generate project archive' });
                } else {
                    res.end();
                }
            });
            zipStream.pipe(res);
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error downloading project archive:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // Save file content endpoint
    router.put('/api/projects/:projectName/file', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { filePath, content } = req.body;


            // Security: ensure the requested path is inside the project root
            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            if (content === undefined) {
                return res.status(400).json({ error: 'Content is required' });
            }

            const projectRoot = req.projectFiles.root;

            const resolved = await req.projectFiles.resolve(filePath, { write: true });

            // Write the new content
            await fsPromises.writeFile(resolved, content, 'utf8');

            res.json({
                success: true,
                path: resolved,
                message: 'File saved successfully'
            });
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error saving file:', error);
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File or directory not found' });
            } else if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    router.get('/api/projects/:projectName/files', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {

            // Using fsPromises from import

            const actualPath = req.projectFiles.root;

            // Check if path exists
            try {
                await fsPromises.access(actualPath);
            } catch (e) {
                return res.status(404).json({ error: `Project path not found: ${actualPath}` });
            }

            const files = await getFileTree(actualPath, 10, 0, true, req.projectFiles);
            res.json(files);
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('[ERROR] File tree error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // ============================================================================
    // FILE OPERATIONS API ENDPOINTS
    // ============================================================================

    async function validatePathInProject(access, targetPath, destructive = false) {
        return { valid: true, resolved: await access.resolve(targetPath, { write: true, destructive }) };
    }

    /**
     * Validate filename - check for invalid characters
     * @param {string} name - The filename to validate
     * @returns {{ valid: boolean, error?: string }}
     */
    function validateFilename(name) {
        if (typeof name !== 'string' || !name.trim()) {
            return { valid: false, error: 'Filename cannot be empty' };
        }
        // Check for invalid characters (Windows + Unix)
        const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
        if (invalidChars.test(name)) {
            return { valid: false, error: 'Filename contains invalid characters' };
        }
        // Check for reserved names (Windows)
        const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
        if (reserved.test(name)) {
            return { valid: false, error: 'Filename is a reserved name' };
        }
        // Check for dots only
        if (/^\.+$/.test(name)) {
            return { valid: false, error: 'Filename cannot be only dots' };
        }
        return { valid: true };
    }

    // POST /api/projects/:projectName/files/create - Create new file or directory
    router.post('/api/projects/:projectName/files/create', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { path: parentPath, type, name } = req.body;

            // Validate input
            if (!name || !type) {
                return res.status(400).json({ error: 'Name and type are required' });
            }

            if (!['file', 'directory'].includes(type)) {
                return res.status(400).json({ error: 'Type must be "file" or "directory"' });
            }

            const nameValidation = validateFilename(name);
            if (!nameValidation.valid) {
                return res.status(400).json({ error: nameValidation.error });
            }

            // Get project root
            const projectRoot = req.projectFiles.root;

            // Build and validate target path
            const targetDir = parentPath === undefined ? '' : parentPath;
            await req.projectFiles.resolve(targetDir, { write: true });
            const targetPath = targetDir ? path.join(targetDir, name) : name;
            const validation = await validatePathInProject(req.projectFiles, targetPath);

            const resolvedPath = validation.resolved;

            // Check if already exists
            try {
                await fsPromises.access(resolvedPath);
                return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
            } catch {
                // Doesn't exist, which is what we want
            }

            // Create file or directory
            if (type === 'directory') {
                await fsPromises.mkdir(resolvedPath, { recursive: false });
            } else {
                // Ensure parent directory exists
                const parentDir = path.dirname(resolvedPath);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }
                await fsPromises.writeFile(resolvedPath, '', 'utf8');
            }

            res.json({
                success: true,
                path: resolvedPath,
                name,
                type,
                message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
            });
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error creating file/directory:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'Parent directory not found' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // PUT /api/projects/:projectName/files/rename - Rename file or directory
    router.put('/api/projects/:projectName/files/rename', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { oldPath, newName } = req.body;

            // Validate input
            if (!oldPath || !newName) {
                return res.status(400).json({ error: 'oldPath and newName are required' });
            }

            const nameValidation = validateFilename(newName);
            if (!nameValidation.valid) {
                return res.status(400).json({ error: nameValidation.error });
            }

            // Get project root
            const projectRoot = req.projectFiles.root;

            // Validate old path
            const oldValidation = await validatePathInProject(req.projectFiles, oldPath, true);

            const resolvedOldPath = oldValidation.resolved;

            // Check if old path exists
            try {
                await fsPromises.access(resolvedOldPath);
            } catch {
                return res.status(404).json({ error: 'File or directory not found' });
            }

            // Build and validate new path
            const parentDir = path.dirname(resolvedOldPath);
            const resolvedNewPath = path.join(parentDir, newName);
            const newValidation = await validatePathInProject(req.projectFiles, resolvedNewPath, true);

            // Check if new path already exists
            try {
                await fsPromises.access(resolvedNewPath);
                return res.status(409).json({ error: 'A file or directory with this name already exists' });
            } catch {
                // Doesn't exist, which is what we want
            }

            // Rename
            await fsPromises.rename(resolvedOldPath, resolvedNewPath);

            res.json({
                success: true,
                oldPath: resolvedOldPath,
                newPath: resolvedNewPath,
                newName,
                message: 'Renamed successfully'
            });
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error renaming file/directory:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File or directory not found' });
            } else if (error.code === 'EXDEV') {
                res.status(400).json({ error: 'Cannot move across different filesystems' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // DELETE /api/projects/:projectName/files - Delete file or directory
    router.delete('/api/projects/:projectName/files', authenticateToken, requireRealProjectFilesystem, async (req, res) => {
        try {
            const { projectName } = req.params;
            const { path: targetPath, type } = req.body;

            // Validate input
            if (!targetPath) {
                return res.status(400).json({ error: 'Path is required' });
            }

            // Get project root
            const projectRoot = req.projectFiles.root;

            // Validate path
            const validation = await validatePathInProject(req.projectFiles, targetPath, true);

            const resolvedPath = validation.resolved;

            // Check if path exists and get stats
            let stats;
            try {
                stats = await fsPromises.stat(resolvedPath);
            } catch {
                return res.status(404).json({ error: 'File or directory not found' });
            }

            // Prevent deleting the project root itself
            if (resolvedPath === path.resolve(projectRoot)) {
                return res.status(403).json({ error: 'Cannot delete project root directory' });
            }

            // Delete based on type
            if (stats.isDirectory()) {
                await fsPromises.rm(resolvedPath, { recursive: true, force: true });
            } else {
                await fsPromises.unlink(resolvedPath);
            }

            res.json({
                success: true,
                path: resolvedPath,
                type: stats.isDirectory() ? 'directory' : 'file',
                message: 'Deleted successfully'
            });
        } catch (error) {
            if (sendProjectFileError(res, error)) return;
            console.error('Error deleting file/directory:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File or directory not found' });
            } else if (error.code === 'ENOTEMPTY') {
                res.status(400).json({ error: 'Directory is not empty' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    const uploadFilesHandler = createWorkspaceFileUploadHandler({ resolveProject, env });

    router.post('/api/projects/:projectName/files/upload/check', authenticateToken, requireRealProjectFilesystem,
        createWorkspaceUploadCheckHandler({ resolveProject, env }));

    router.post('/api/projects/:projectName/files/upload', authenticateToken, requireRealProjectFilesystem, uploadFilesHandler);

    const CHAT_ATTACHMENT_IMAGE_MIMES = new Set([
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/svg+xml',
    ]);

    function sanitizeAttachmentFilename(name, fallback = 'attachment') {
        const baseName = path.basename(String(name || fallback));
        const sanitized = baseName
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .replace(/^\.+$/, fallback)
            .slice(0, 180)
            .trim();
        return sanitized || fallback;
    }

    function normalizeUploadedFilename(name, fallback = 'attachment') {
        const original = String(name || fallback);
        try {
            const decoded = Buffer.from(original, 'latin1').toString('utf8');
            const looksMojibake = /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùûüýþÿ]/.test(original);
            if (looksMojibake && decoded && !decoded.includes('�')) {
                return decoded;
            }
        } catch {
            // Keep the browser-provided name when transcoding is not applicable.
        }
        return original;
    }

    async function moveUploadedAttachment(file, attachmentDir, index, access) {
        const originalName = normalizeUploadedFilename(file.originalname, `attachment-${index + 1}`);
        file.originalname = originalName;
        const safeName = sanitizeAttachmentFilename(originalName, `attachment-${index + 1}`);
        const ext = path.extname(safeName);
        const stem = ext ? safeName.slice(0, -ext.length) : safeName;
        let candidate = `${index + 1}-${safeName}`;
        let destination = path.join(attachmentDir, candidate);
        let suffix = 1;
        while (true) {
            try {
                await fsPromises.access(destination);
                candidate = `${index + 1}-${stem}-${suffix}${ext}`;
                destination = path.join(attachmentDir, candidate);
                suffix += 1;
            } catch {
                break;
            }
        }

        destination = await access.resolve(destination, { write: true });
        await fsPromises.copyFile(file.path, destination, fs.constants.COPYFILE_EXCL);
        await fsPromises.unlink(file.path);
        return {
            name: originalName,
            path: destination,
            size: file.size,
            mimeType: file.mimetype || mime.lookup(originalName) || 'application/octet-stream',
        };
    }

    // Mixed chat attachment upload endpoint. Images are returned as data URLs for
    // multimodal input/previews and are also staged under the project so the agent
    // can operate on the same bytes by path; other files are staged by path only.
    router.post('/api/projects/:projectName/upload-attachments', authenticateToken, requireAttachmentFilesystem, async (req, res) => {
        let multerUpload;
        try {
            const multer = (await import('multer')).default;
            const uploadRoot = path.join(os.tmpdir(), 'pilotdeck-chat-attachments', String(req.user.id));
            const storage = multer.diskStorage({
                destination: async (_req, _file, cb) => {
                    try {
                        await fsPromises.mkdir(uploadRoot, { recursive: true });
                        cb(null, uploadRoot);
                    } catch (error) {
                        cb(error);
                    }
                },
                filename: (_req, file, cb) => {
                    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
                    file.originalname = normalizeUploadedFilename(file.originalname);
                    cb(null, `${uniqueSuffix}-${sanitizeAttachmentFilename(file.originalname)}`);
                },
            });

            multerUpload = multer({
                storage,
                limits: {
                    fileSize: 20 * 1024 * 1024,
                    files: 10,
                },
            }).array('attachments', 10);
        } catch (error) {
            console.error('Error configuring attachment upload:', error);
            return res.status(500).json({ error: 'Internal server error' });
        }

        multerUpload(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No attachments provided' });
            }

            let attachmentDir = null;
            try {
                const projectRoot = req.projectFiles.root;
                const targetDir = path.join(projectRoot, '.tmp', 'chat-attachments', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
                const validation = await validatePathInProject(req.projectFiles, targetDir);
                attachmentDir = validation.resolved;

                const images = [];
                const files = [];
                await fsPromises.mkdir(attachmentDir, { recursive: true });

                for (const [index, file] of req.files.entries()) {
                    if (CHAT_ATTACHMENT_IMAGE_MIMES.has(file.mimetype)) {
                        const buffer = await fsPromises.readFile(file.path);
                        const storedFile = await moveUploadedAttachment(file, attachmentDir, index, req.projectFiles);
                        images.push({
                            name: storedFile.name,
                            data: `data:${file.mimetype};base64,${buffer.toString('base64')}`,
                            path: storedFile.path,
                            size: storedFile.size,
                            mimeType: storedFile.mimeType,
                        });
                        continue;
                    }

                    files.push(await moveUploadedAttachment(file, attachmentDir, index, req.projectFiles));
                }

                if (files.length === 0 && images.length === 0 && attachmentDir) {
                    await fsPromises.rm(attachmentDir, { recursive: true, force: true }).catch(() => { });
                }

                res.json({ images, files });
            } catch (error) {
                console.error('Error processing attachments:', error);
                await Promise.all((req.files || []).map(file => fsPromises.unlink(file.path).catch(() => { })));
                if (attachmentDir) {
                    await fsPromises.rm(attachmentDir, { recursive: true, force: true }).catch(() => { });
                }
                if (!sendProjectFileError(res, error)) res.status(500).json({ error: 'Failed to process attachments' });
            }
        });
    });


    // Image upload endpoint
    router.post('/api/projects/:projectName/upload-images', authenticateToken, requireAttachmentFilesystem, async (req, res) => {
        try {
            const multer = (await import('multer')).default;
            const path = (await import('path')).default;
            const fs = (await import('fs')).promises;
            const os = (await import('os')).default;

            // Configure multer for image uploads
            const storage = multer.diskStorage({
                destination: async (req, file, cb) => {
                    const uploadDir = path.join(os.tmpdir(), 'pilotdeck-image-uploads', String(req.user.id));
                    await fs.mkdir(uploadDir, { recursive: true });
                    cb(null, uploadDir);
                },
                filename: (req, file, cb) => {
                    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                    cb(null, uniqueSuffix + '-' + sanitizedName);
                }
            });

            const fileFilter = (req, file, cb) => {
                const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
                if (allowedMimes.includes(file.mimetype)) {
                    cb(null, true);
                } else {
                    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
                }
            };

            const upload = multer({
                storage,
                fileFilter,
                limits: {
                    fileSize: 5 * 1024 * 1024, // 5MB
                    files: 5
                }
            });

            // Handle multipart form data
            upload.array('images', 5)(req, res, async (err) => {
                if (err) {
                    return res.status(400).json({ error: err.message });
                }

                if (!req.files || req.files.length === 0) {
                    return res.status(400).json({ error: 'No image files provided' });
                }

                try {
                    // Process uploaded images
                    const processedImages = await Promise.all(
                        req.files.map(async (file) => {
                            // Read file and convert to base64
                            const buffer = await fs.readFile(file.path);
                            const base64 = buffer.toString('base64');
                            const mimeType = file.mimetype;

                            // Clean up temp file immediately
                            await fs.unlink(file.path);

                            return {
                                name: file.originalname,
                                data: `data:${mimeType};base64,${base64}`,
                                size: file.size,
                                mimeType: mimeType
                            };
                        })
                    );

                    res.json({ images: processedImages });
                } catch (error) {
                    console.error('Error processing images:', error);
                    // Clean up any remaining files
                    await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => { })));
                    res.status(500).json({ error: 'Failed to process images' });
                }
            });
        } catch (error) {
            console.error('Error in image upload endpoint:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });


    return router;
}
