const http = require('http');
const fs = require('fs');
const { promisify } = require('util');
let fsp = fs.promises;
if (!fsp) {
  fsp = {
    access: promisify(fs.access),
    readFile: promisify(fs.readFile),
    writeFile: promisify(fs.writeFile),
    stat: promisify(fs.stat),
    unlink: promisify(fs.unlink),
    mkdir: (target, options) => new Promise((resolve, reject) => {
      fs.mkdir(target, options || {}, (err) => {
        if (err && err.code !== 'EEXIST') return reject(err);
        resolve();
      });
    }),
    rmdir: (target, options) => new Promise((resolve, reject) => {
      fs.rmdir(target, options || {}, (err) => {
        if (err && err.code !== 'ENOENT') return reject(err);
        resolve();
      });
    }),
  };
}
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORAGE_DIR = path.join(ROOT, 'storage');
const TMP_DIR = path.join(STORAGE_DIR, 'tmp');
const FILE_DIR = path.join(STORAGE_DIR, 'files');
const INDEX_FILE = path.join(STORAGE_DIR, 'index.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};



async function ensureDir(targetPath) {
  try {
    await fsp.mkdir(targetPath, { recursive: true });
  } catch (err) {
    if (err && (err.code === 'ENOTSUP' || err.code === 'ERR_INVALID_ARG_VALUE' || err.code === 'ERR_INVALID_OPT_VALUE')) {
      const parts = targetPath.split(path.sep);
      let current = parts[0] === '' ? path.sep : parts[0];
      for (let i = 1; i <= parts.length; i += 1) {
        const segment = parts[i];
        if (!segment) continue;
        current = current === path.sep ? path.join(current, segment) : path.join(current, segment);
        try {
          // eslint-disable-next-line no-await-in-loop
          await fsp.mkdir(current);
        } catch (innerErr) {
          if (!innerErr || innerErr.code !== 'EEXIST') throw innerErr;
        }
      }
      return;
    }
    if (!err || err.code !== 'EEXIST') throw err;
  }
}

async function removeFileSafe(targetPath) {
  try {
    if (typeof fsp.rm === 'function') {
      await fsp.rm(targetPath, { force: true });
    } else {
      await fsp.unlink(targetPath);
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

async function removeDirSafe(targetPath) {
  try {
    if (typeof fsp.rm === 'function') {
      await fsp.rm(targetPath, { recursive: true, force: true });
    } else {
      await fsp.rmdir(targetPath, { recursive: true });
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
  }
}

async function ensureStorage() {
  await ensureDir(TMP_DIR);
  await ensureDir(FILE_DIR);
  try {
    await fsp.access(INDEX_FILE);
  } catch {
    await fsp.writeFile(INDEX_FILE, JSON.stringify({ uploads: {}, codes: {} }, null, 2));
  }
}

async function readIndex() {
  return JSON.parse(await fsp.readFile(INDEX_FILE, 'utf-8'));
}

async function writeIndex(data) {
  await fsp.writeFile(INDEX_FILE, JSON.stringify(data, null, 2));
}

function randomId(len = 16) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function randomCode(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

async function serveStatic(reqPath, res) {
  const safePath = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    notFound(res);
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return notFound(res);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    notFound(res);
  }
}

async function mergeChunks(uploadId, totalChunks, outputPath) {
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outputPath);
    ws.on('error', reject);
    ws.on('finish', resolve);
    let idx = 0;

    const pipeNext = () => {
      if (idx >= totalChunks) {
        ws.end();
        return;
      }
      const part = path.join(TMP_DIR, uploadId, `${idx}.part`);
      const rs = fs.createReadStream(part);
      rs.on('error', reject);
      rs.on('end', async () => {
        idx += 1;
        await removeFileSafe(part);
        pipeNext();
      });
      rs.pipe(ws, { end: false });
    };

    pipeNext();
  });
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'POST' && url.pathname === '/api/upload/init') {
      const body = JSON.parse((await readBody(req)).toString('utf-8'));
      const { fileName, fileSize, mimeType, totalChunks, chunkSize, fingerprint, uploadId } = body;
      if (!fileName || !fileSize || !totalChunks || !chunkSize) {
        return sendJson(res, 400, { error: '缺少必要参数' });
      }
      const db = await readIndex();
      if (uploadId && db.uploads[uploadId]) {
        const record = db.uploads[uploadId];
        return sendJson(res, 200, {
          uploadId,
          code: record.code,
          uploadedChunks: record.uploadedChunks || [],
        });
      }

      const newUploadId = randomId(20);
      let code = randomCode();
      while (db.codes[code]) code = randomCode();

      db.uploads[newUploadId] = {
        uploadId: newUploadId,
        code,
        fingerprint,
        fileName,
        fileSize,
        mimeType: mimeType || 'application/octet-stream',
        totalChunks,
        chunkSize,
        uploadedChunks: [],
        complete: false,
        createdAt: new Date().toISOString(),
      };
      db.codes[code] = newUploadId;
      await ensureDir(path.join(TMP_DIR, newUploadId));
      await writeIndex(db);
      return sendJson(res, 200, { uploadId: newUploadId, code, uploadedChunks: [] });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/upload/status/')) {
      const uploadId = url.pathname.split('/').pop();
      const db = await readIndex();
      const record = db.uploads[uploadId];
      if (!record) return sendJson(res, 404, { error: '上传任务不存在' });
      return sendJson(res, 200, {
        uploadId,
        code: record.code,
        complete: record.complete,
        uploadedChunks: record.uploadedChunks || [],
        totalChunks: record.totalChunks,
      });
    }

    if (req.method === 'POST' && /\/api\/upload\/[^/]+\/chunk/.test(url.pathname)) {
      const uploadId = url.pathname.split('/')[3];
      const idx = Number(url.searchParams.get('index'));
      if (Number.isNaN(idx)) return sendJson(res, 400, { error: 'chunk index 无效' });
      const db = await readIndex();
      const record = db.uploads[uploadId];
      if (!record) return sendJson(res, 404, { error: '上传任务不存在' });

      const body = await readBody(req);
      await fsp.writeFile(path.join(TMP_DIR, uploadId, `${idx}.part`), body);
      if (!record.uploadedChunks.includes(idx)) {
        record.uploadedChunks.push(idx);
        record.uploadedChunks.sort((a, b) => a - b);
        await writeIndex(db);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && /\/api\/upload\/[^/]+\/complete/.test(url.pathname)) {
      const uploadId = url.pathname.split('/')[3];
      const db = await readIndex();
      const record = db.uploads[uploadId];
      if (!record) return sendJson(res, 404, { error: '上传任务不存在' });
      if (record.complete) return sendJson(res, 200, { ok: true, code: record.code });
      if ((record.uploadedChunks || []).length < record.totalChunks) {
        return sendJson(res, 400, { error: '文件分片未全部上传完成' });
      }
      const filePath = path.join(FILE_DIR, `${record.code}.bin`);
      await mergeChunks(uploadId, record.totalChunks, filePath);
      record.complete = true;
      record.filePath = filePath;
      record.completedAt = new Date().toISOString();
      await removeDirSafe(path.join(TMP_DIR, uploadId));
      await writeIndex(db);
      return sendJson(res, 200, { ok: true, code: record.code });
    }

    if (req.method === 'GET' && /\/api\/download\/[^/]+\/meta/.test(url.pathname)) {
      const code = url.pathname.split('/')[3].toUpperCase();
      const db = await readIndex();
      const uploadId = db.codes[code];
      if (!uploadId) return sendJson(res, 404, { error: '提取码不存在' });
      const record = db.uploads[uploadId];
      if (!record || !record.complete) return sendJson(res, 404, { error: '文件尚未准备完成' });
      return sendJson(res, 200, {
        code,
        fileName: record.fileName,
        fileSize: record.fileSize,
        mimeType: record.mimeType,
      });
    }

    if (req.method === 'GET' && /\/api\/download\/[^/]+$/.test(url.pathname)) {
      const code = url.pathname.split('/')[3].toUpperCase();
      const db = await readIndex();
      const uploadId = db.codes[code];
      if (!uploadId) return notFound(res);
      const record = db.uploads[uploadId];
      if (!record || !record.complete) return notFound(res);

      const stat = await fsp.stat(record.filePath);
      const total = stat.size;
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);

      if (range) {
        const [startStr, endStr] = range.replace('bytes=', '').split('-');
        const start = Number(startStr);
        const end = endStr ? Number(endStr) : total - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(record.filePath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, { 'Content-Length': total });
      fs.createReadStream(record.filePath).pipe(res);
      return;
    }

    notFound(res);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

(async () => {
  await ensureStorage();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url);
      return;
    }
    serveStatic(url.pathname, res);
  });

  server.listen(PORT, () => {
    console.log(`Anonymous transfer app running at http://localhost:${PORT}`);
  });
})();
