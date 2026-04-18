const http = require('http');
const fs = require('fs');
const { promisify } = require('util');
const { execFile } = require('child_process');
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

const PORT = process.env.PORT || 30022;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORAGE_DIR = path.join(ROOT, 'storage');
const TMP_DIR = path.join(STORAGE_DIR, 'tmp');
const FILE_DIR = path.join(STORAGE_DIR, 'files');
const INDEX_FILE = path.join(STORAGE_DIR, 'index.json');
const ANALYTICS_FILE = path.join(STORAGE_DIR, 'analytics.json');
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const MAX_FILE_SIZE_BYTES = 2 * GIB;
const MAX_DOWNLOADS = 10;
const DEFAULT_MAX_DOWNLOADS = 3;
const MIN_FREE_BYTES_AFTER_PEAK = 12 * GIB;
const APP_STORAGE_SOFT_LIMIT_BYTES = 16 * GIB;
const APP_STORAGE_HARD_LIMIT_BYTES = 20 * GIB;
const UPLOAD_PEAK_OVERHEAD_BYTES = 512 * MIB;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_CHUNK_BODY_BYTES = 6 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const AUTO_DELETE_IF_NOT_DOWNLOADED_MS = 4 * 60 * 60 * 1000;
const INCOMPLETE_UPLOAD_TTL_MS = 30 * 60 * 1000;
const DOWNLOADED_FILE_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const DOWNLOADED_FILE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const ABSOLUTE_FILE_TTL_MS = 72 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const ANALYTICS_RETENTION_DAYS = 30;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const execFileAsync = promisify(execFile);
let analyticsMutationQueue = Promise.resolve();

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
  try {
    await fsp.access(ANALYTICS_FILE);
  } catch {
    await fsp.writeFile(ANALYTICS_FILE, JSON.stringify(createEmptyAnalytics(), null, 2));
  }
}

async function readIndex() {
  return syncIndexData(JSON.parse(await fsp.readFile(INDEX_FILE, 'utf-8')));
}

async function writeIndex(data) {
  await fsp.writeFile(INDEX_FILE, JSON.stringify(data, null, 2));
}

function createEmptyAnalytics() {
  return {
    totals: {
      pageViews: 0,
      uploadsCompleted: 0,
      downloadsCompleted: 0,
    },
    daily: {},
    updatedAt: new Date().toISOString(),
  };
}

function buildAnalyticsSeedFromIndex(indexData) {
  const analytics = createEmptyAnalytics();
  for (const uploadId of Object.keys(indexData.uploads || {})) {
    const record = indexData.uploads[uploadId];
    if (!record || !record.complete) {
      continue;
    }
    analytics.totals.uploadsCompleted += 1;
    analytics.totals.downloadsCompleted += Number(record.downloadCount) || 0;
  }
  return analytics;
}

function normalizeAnalytics(data) {
  const source = data && typeof data === 'object' ? data : {};
  return {
    totals: {
      pageViews: Number(source.totals && source.totals.pageViews) || 0,
      uploadsCompleted: Number(source.totals && source.totals.uploadsCompleted) || 0,
      downloadsCompleted: Number(source.totals && source.totals.downloadsCompleted) || 0,
    },
    daily: source.daily && typeof source.daily === 'object' ? source.daily : {},
    updatedAt: source.updatedAt || new Date().toISOString(),
  };
}

async function readAnalytics() {
  return normalizeAnalytics(JSON.parse(await fsp.readFile(ANALYTICS_FILE, 'utf-8')));
}

async function writeAnalytics(data) {
  await fsp.writeFile(ANALYTICS_FILE, JSON.stringify(data, null, 2));
}

async function backfillAnalyticsFromIndex() {
  const [analytics, indexData] = await Promise.all([readAnalytics(), readIndex()]);
  const seed = buildAnalyticsSeedFromIndex(indexData);
  let changed = false;
  if (seed.totals.uploadsCompleted > analytics.totals.uploadsCompleted) {
    analytics.totals.uploadsCompleted = seed.totals.uploadsCompleted;
    changed = true;
  }
  if (seed.totals.downloadsCompleted > analytics.totals.downloadsCompleted) {
    analytics.totals.downloadsCompleted = seed.totals.downloadsCompleted;
    changed = true;
  }
  if (changed) {
    analytics.updatedAt = new Date().toISOString();
    await writeAnalytics(analytics);
  }
}

function getDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
}

function isLikelyBot(req) {
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
  if (!userAgent) return true;
  return /bot|crawler|spider|slurp|curl|wget|python|axios|httpclient|headless|lighthouse|monitor|scan|checker|preview/.test(userAgent);
}

function getVisitorHash(req, dayKey) {
  const ip = getClientIp(req);
  const userAgent = String(req.headers['user-agent'] || '');
  return crypto
    .createHash('sha256')
    .update(`${dayKey}|${ip}|${userAgent}`)
    .digest('hex');
}

function getOrCreateDailyAnalytics(analytics, dayKey) {
  if (!analytics.daily[dayKey] || typeof analytics.daily[dayKey] !== 'object') {
    analytics.daily[dayKey] = {
      pageViews: 0,
      uniqueVisitors: 0,
      uploadsCompleted: 0,
      downloadsCompleted: 0,
      visitors: {},
    };
  }
  const record = analytics.daily[dayKey];
  if (!record.visitors || typeof record.visitors !== 'object') {
    record.visitors = {};
  }
  record.pageViews = Number(record.pageViews) || 0;
  record.uniqueVisitors = Number(record.uniqueVisitors) || 0;
  record.uploadsCompleted = Number(record.uploadsCompleted) || 0;
  record.downloadsCompleted = Number(record.downloadsCompleted) || 0;
  return record;
}

function pruneAnalytics(analytics, now = new Date()) {
  const cutoffMs = now.getTime() - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const dayKey of Object.keys(analytics.daily)) {
    const dayMs = Date.parse(`${dayKey}T00:00:00.000Z`);
    if (!Number.isFinite(dayMs) || dayMs < cutoffMs) {
      delete analytics.daily[dayKey];
      continue;
    }
    const record = getOrCreateDailyAnalytics(analytics, dayKey);
    if (dayKey !== getDayKey(now)) {
      delete record.visitors;
    }
  }
}

function enqueueAnalyticsMutation(mutator) {
  const run = analyticsMutationQueue.catch(() => {}).then(async () => {
    const analytics = await readAnalytics();
    const result = await mutator(analytics);
    pruneAnalytics(analytics);
    analytics.updatedAt = new Date().toISOString();
    await writeAnalytics(analytics);
    return result;
  });
  analyticsMutationQueue = run;
  return run;
}

function trackPageView(req, pathname) {
  if (req.method !== 'GET') return;
  if (isLikelyBot(req)) return;
  if (pathname !== '/' && pathname !== '/zh/' && pathname !== '/zh/index.html') return;
  const now = new Date();
  const dayKey = getDayKey(now);
  const visitorHash = getVisitorHash(req, dayKey);
  enqueueAnalyticsMutation(async (analytics) => {
    const daily = getOrCreateDailyAnalytics(analytics, dayKey);
    analytics.totals.pageViews += 1;
    daily.pageViews += 1;
    if (!daily.visitors[visitorHash]) {
      daily.visitors[visitorHash] = now.toISOString();
      daily.uniqueVisitors += 1;
    }
  }).catch((err) => {
    console.error('Failed to track page view', err);
  });
}

async function recordAnalyticsEvent(eventName) {
  await enqueueAnalyticsMutation(async (analytics) => {
    const dayKey = getDayKey();
    const daily = getOrCreateDailyAnalytics(analytics, dayKey);
    if (eventName === 'uploadCompleted') {
      analytics.totals.uploadsCompleted += 1;
      daily.uploadsCompleted += 1;
      return;
    }
    if (eventName === 'downloadCompleted') {
      analytics.totals.downloadsCompleted += 1;
      daily.downloadsCompleted += 1;
    }
  });
}

async function buildPublicStats() {
  const [analytics, db] = await Promise.all([readAnalytics(), readIndex()]);
  pruneAnalytics(analytics);
  const dayKey = getDayKey();
  const daily = getOrCreateDailyAnalytics(analytics, dayKey);
  let activeFiles = 0;
  for (const uploadId of Object.keys(db.uploads)) {
    const record = db.uploads[uploadId];
    if (!record || !record.complete || !record.filePath) {
      continue;
    }
    if (isRecordExpired(record)) {
      continue;
    }
    const remainingDownloads = Math.max(0, (record.maxDownloads || 1) - (record.downloadCount || 0));
    if (remainingDownloads > 0) {
      activeFiles += 1;
    }
  }
  const recentDays = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const currentDate = new Date();
    currentDate.setUTCHours(0, 0, 0, 0);
    currentDate.setUTCDate(currentDate.getUTCDate() - offset);
    const currentDayKey = getDayKey(currentDate);
    const dayRecord = analytics.daily[currentDayKey] || {};
    recentDays.push({
      dayKey: currentDayKey,
      label: currentDayKey.slice(5),
      pageViews: Number(dayRecord.pageViews) || 0,
      uniqueVisitors: Number(dayRecord.uniqueVisitors) || 0,
      uploadsCompleted: Number(dayRecord.uploadsCompleted) || 0,
      downloadsCompleted: Number(dayRecord.downloadsCompleted) || 0,
    });
  }
  return {
    totals: {
      pageViews: analytics.totals.pageViews,
      uploadsCompleted: analytics.totals.uploadsCompleted,
      downloadsCompleted: analytics.totals.downloadsCompleted,
    },
    today: {
      pageViews: daily.pageViews,
      uniqueVisitors: daily.uniqueVisitors,
      uploadsCompleted: daily.uploadsCompleted,
      downloadsCompleted: daily.downloadsCompleted,
    },
    activeFiles,
    languages: 2,
    recentDays,
    updatedAt: analytics.updatedAt,
  };
}

function randomId(len = 16) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function randomCode(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let normalized = value / 1024;
  let index = 0;
  while (normalized >= 1024 && index < units.length - 1) {
    normalized /= 1024;
    index += 1;
  }
  return `${normalized.toFixed(2)} ${units[index]}`;
}

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function normalizeFileName(name) {
  return String(name || '')
    .replace(/[\r\n]/g, '_')
    .replace(/[\x00-\x1F\x7F]/g, '_')
    .slice(0, 255);
}

function isValidUploadId(value) {
  return /^[a-f0-9]{20}$/i.test(String(value || ''));
}

function isValidCode(value) {
  return /^[A-Z0-9]{8}$/.test(String(value || ''));
}

function sendJson(res, status, payload) {
  setCommonHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (typeof maxBytes === 'number' && total > maxBytes) {
        const err = new Error('请求体过大');
        err.statusCode = 413;
        req.destroy(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => {
      if (err && err.statusCode) {
        reject(err);
        return;
      }
      const wrapped = new Error('读取请求体失败');
      wrapped.statusCode = 400;
      reject(wrapped);
    });
  });
}

function parseJsonBody(req, maxBytes) {
  return readBody(req, maxBytes).then((buf) => {
    try {
      return JSON.parse(buf.toString('utf-8'));
    } catch {
      const err = new Error('JSON 格式错误');
      err.statusCode = 400;
      throw err;
    }
  });
}

function notFound(res) {
  setCommonHeaders(res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function redirect(res, location, statusCode = 301) {
  setCommonHeaders(res);
  res.writeHead(statusCode, { Location: location });
  res.end();
}

async function serveStatic(reqPath, res) {
  const normalizedPath = reqPath === '/' ? '/index.html' : reqPath;
  const candidates = [normalizedPath];
  if (normalizedPath.endsWith('/')) {
    candidates.unshift(`${normalizedPath}index.html`);
  } else if (!path.extname(normalizedPath)) {
    candidates.push(`${normalizedPath}/index.html`);
  }

  for (const candidate of candidates) {
    const filePath = path.join(PUBLIC_DIR, path.normalize(candidate));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      continue;
    }
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const ext = path.extname(filePath);
      setCommonHeaders(res);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    } catch {
      // Try the next candidate path.
    }
  }
  notFound(res);
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

function normalizeMaxDownloads(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_MAX_DOWNLOADS;
  return Math.min(MAX_DOWNLOADS, Math.max(1, Math.floor(num)));
}

function parseTime(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getRecordCreatedTime(record) {
  return parseTime(record && record.createdAt);
}

async function getDiskStats(targetPath) {
  if (typeof fsp.statfs === 'function') {
    const stat = await fsp.statfs(targetPath);
    const blockSize = stat.bsize || stat.frsize || 1;
    return {
      totalBytes: Number(stat.blocks) * Number(blockSize),
      freeBytes: Number(stat.bavail || stat.bfree) * Number(blockSize),
    };
  }

  const { stdout } = await execFileAsync('df', ['-kP', targetPath]);
  const lines = stdout.trim().split('\n');
  const line = lines[lines.length - 1].trim().split(/\s+/);
  const totalKb = Number(line[1]);
  const availKb = Number(line[3]);
  return {
    totalBytes: totalKb * 1024,
    freeBytes: availKb * 1024,
  };
}

async function statSafe(targetPath) {
  try {
    return await fsp.stat(targetPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function getPathSize(targetPath) {
  const stat = await statSafe(targetPath);
  if (!stat) return 0;
  if (stat.isFile()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return 0;
  }

  const children = await fsp.readdir(targetPath);
  let total = 0;
  for (const child of children) {
    // eslint-disable-next-line no-await-in-loop
    total += await getPathSize(path.join(targetPath, child));
  }
  return total;
}

async function getStorageUsageBytes() {
  const [tmpBytes, fileBytes, indexStat, analyticsStat] = await Promise.all([
    getPathSize(TMP_DIR),
    getPathSize(FILE_DIR),
    statSafe(INDEX_FILE),
    statSafe(ANALYTICS_FILE),
  ]);
  return tmpBytes + fileBytes + (indexStat ? indexStat.size : 0) + (analyticsStat ? analyticsStat.size : 0);
}

function checkUploadCapacity(fileSize, diskStats, currentStorageBytes) {
  const uploadGrowthBytes = fileSize * 2 + UPLOAD_PEAK_OVERHEAD_BYTES;
  const projectedPeakStorageBytes = currentStorageBytes + uploadGrowthBytes;
  const projectedFreeBytesAfterPeak = diskStats.freeBytes - uploadGrowthBytes;
  return {
    ok: projectedPeakStorageBytes <= APP_STORAGE_HARD_LIMIT_BYTES
      && projectedFreeBytesAfterPeak >= MIN_FREE_BYTES_AFTER_PEAK,
    uploadGrowthBytes,
    projectedPeakStorageBytes,
    projectedFreeBytesAfterPeak,
  };
}

function getRecordCompletionTime(record) {
  const rawValue = record && (record.completedAt || record.createdAt);
  if (!rawValue) return null;
  const timestamp = Date.parse(rawValue);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getRecordLastChunkTime(record) {
  return parseTime(record && record.lastChunkAt) || getRecordCreatedTime(record);
}

function getRecordFirstDownloadTime(record) {
  return parseTime(record && record.firstDownloadedAt);
}

function getRecordLastDownloadTime(record) {
  return parseTime(record && record.lastDownloadedAt) || getRecordFirstDownloadTime(record);
}

function getRecordStorageBytes(record) {
  const explicitSize = Number(record && record.storageBytes);
  if (Number.isFinite(explicitSize) && explicitSize >= 0) {
    return explicitSize;
  }
  if (record && record.complete) {
    return Number(record.fileSize) || 0;
  }
  return 0;
}

function getRecordExpiryTime(record) {
  if (!record) return null;
  const createdAtMs = getRecordCreatedTime(record);
  if (!createdAtMs) return null;

  const candidates = [createdAtMs + ABSOLUTE_FILE_TTL_MS];
  if (record.complete) {
    if ((record.downloadCount || 0) > 0) {
      const firstDownloadedAtMs = getRecordFirstDownloadTime(record) || getRecordLastDownloadTime(record) || getRecordCompletionTime(record) || createdAtMs;
      const lastDownloadedAtMs = getRecordLastDownloadTime(record) || firstDownloadedAtMs;
      candidates.push(lastDownloadedAtMs + DOWNLOADED_FILE_IDLE_TTL_MS);
      candidates.push(firstDownloadedAtMs + DOWNLOADED_FILE_MAX_TTL_MS);
    } else {
      const completedAtMs = getRecordCompletionTime(record) || createdAtMs;
      candidates.push(completedAtMs + AUTO_DELETE_IF_NOT_DOWNLOADED_MS);
    }
  } else {
    candidates.push(getRecordLastChunkTime(record) + INCOMPLETE_UPLOAD_TTL_MS);
  }

  return Math.min(...candidates.filter((value) => Number.isFinite(value)));
}

function isRecordExpired(record, now = Date.now()) {
  const expiryTime = getRecordExpiryTime(record);
  return Number.isFinite(expiryTime) && now >= expiryTime;
}

function getRecordExpiryMessage(record) {
  if (!record) return '文件已过期，已自动删除';
  if (!record.complete) return '上传任务长时间未继续，已自动清理';
  if ((record.downloadCount || 0) > 0) return '文件保留期已结束，已自动删除';
  return '文件已超过 4 小时未被下载，已自动删除';
}

function syncUploadRecord(record) {
  if (!record || typeof record !== 'object') return record;
  record.maxDownloads = normalizeMaxDownloads(record.maxDownloads);
  record.downloadCount = Math.max(0, Math.floor(Number(record.downloadCount) || 0));
  const uploadedChunks = Array.isArray(record.uploadedChunks) ? record.uploadedChunks : [];
  record.uploadedChunks = [...new Set(uploadedChunks
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0))]
    .sort((a, b) => a - b);
  record.storageBytes = record.complete ? getRecordStorageBytes(record) : 0;
  const expiryTime = getRecordExpiryTime(record);
  record.expiresAt = Number.isFinite(expiryTime) ? new Date(expiryTime).toISOString() : null;
  return record;
}

function syncIndexData(data) {
  const db = data && typeof data === 'object' ? data : {};
  db.uploads = db.uploads && typeof db.uploads === 'object' ? db.uploads : {};
  db.codes = {};
  for (const uploadId of Object.keys(db.uploads)) {
    const record = db.uploads[uploadId];
    if (!record || typeof record !== 'object') {
      delete db.uploads[uploadId];
      continue;
    }
    syncUploadRecord(record);
    if (record.code) {
      db.codes[record.code] = uploadId;
    }
  }
  return db;
}

function shouldDeleteUndownloadedRecord(record, now = Date.now()) {
  if (!record || !record.complete || (record.downloadCount || 0) > 0) return false;
  return isRecordExpired(record, now);
}

async function removeUploadRecord(db, uploadId) {
  const record = db.uploads[uploadId];
  if (!record) return false;

  if (record.filePath) {
    await removeFileSafe(record.filePath);
  }
  await removeDirSafe(path.join(TMP_DIR, uploadId));
  delete db.uploads[uploadId];
  if (record.code) {
    delete db.codes[record.code];
  }
  return true;
}

async function purgeExpiredUploads(db, now = Date.now()) {
  const removedUploadIds = [];
  for (const uploadId of Object.keys(db.uploads)) {
    const record = db.uploads[uploadId];
    syncUploadRecord(record);
    if (!isRecordExpired(record, now)) {
      continue;
    }
    await removeUploadRecord(db, uploadId);
    removedUploadIds.push({
      uploadId,
      reason: getRecordExpiryMessage(record),
    });
  }
  return removedUploadIds;
}

async function purgeIfExpiredBeforeAccess(db, uploadId, now = Date.now()) {
  const record = db.uploads[uploadId];
  if (!isRecordExpired(record, now)) {
    return null;
  }
  const reason = getRecordExpiryMessage(record);
  await removeUploadRecord(db, uploadId);
  await writeIndex(db);
  return reason;
}

function getDownloadedPressureCandidates(db) {
  return Object.keys(db.uploads)
    .map((uploadId) => ({ uploadId, record: db.uploads[uploadId] }))
    .filter(({ record }) => record && record.complete && record.filePath && (record.downloadCount || 0) > 0)
    .sort((left, right) => {
      const leftTime = getRecordLastDownloadTime(left.record) || getRecordFirstDownloadTime(left.record) || getRecordCompletionTime(left.record) || getRecordCreatedTime(left.record) || 0;
      const rightTime = getRecordLastDownloadTime(right.record) || getRecordFirstDownloadTime(right.record) || getRecordCompletionTime(right.record) || getRecordCreatedTime(right.record) || 0;
      return leftTime - rightTime;
    });
}

async function reclaimStoragePressure(db, currentStorageBytes) {
  let storageBytes = currentStorageBytes;
  const removedUploadIds = [];
  if (storageBytes <= APP_STORAGE_SOFT_LIMIT_BYTES) {
    return { storageBytes, removedUploadIds };
  }

  for (const { uploadId, record } of getDownloadedPressureCandidates(db)) {
    await removeUploadRecord(db, uploadId);
    removedUploadIds.push({
      uploadId,
      reason: 'storage-pressure',
      code: record.code,
    });
    storageBytes = await getStorageUsageBytes();
    if (storageBytes <= APP_STORAGE_SOFT_LIMIT_BYTES) {
      break;
    }
  }

  return { storageBytes, removedUploadIds };
}

async function runExpiredUploadCleanup() {
  const db = await readIndex();
  const removedExpired = await purgeExpiredUploads(db);
  let storageBytes = await getStorageUsageBytes();
  const reclaimed = await reclaimStoragePressure(db, storageBytes);
  storageBytes = reclaimed.storageBytes;
  if (removedExpired.length || reclaimed.removedUploadIds.length) {
    await writeIndex(db);
  }

  if (removedExpired.length) {
    console.log(`Removed ${removedExpired.length} expired upload(s)`);
  }
  if (reclaimed.removedUploadIds.length) {
    console.log(`Removed ${reclaimed.removedUploadIds.length} downloaded upload(s) to relieve storage pressure`);
  }
  return { removedExpired, reclaimed: reclaimed.removedUploadIds, storageBytes };
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/stats/public') {
      return sendJson(res, 200, await buildPublicStats());
    }

    if (req.method === 'POST' && url.pathname === '/api/upload/init') {
      const body = await parseJsonBody(req, MAX_JSON_BODY_BYTES);
      const {
        fileName,
        fileSize,
        mimeType,
        totalChunks,
        chunkSize,
        fingerprint,
        maxDownloads,
        uploadId,
      } = body;

      if (!fileName || !fileSize || !totalChunks || !chunkSize) {
        return sendJson(res, 400, { error: '缺少必要参数' });
      }

      const normalizedFileName = normalizeFileName(fileName);
      if (!normalizedFileName) {
        return sendJson(res, 400, { error: '文件名无效' });
      }

      const normalizedFileSize = Number(fileSize);
      if (!Number.isFinite(normalizedFileSize) || normalizedFileSize <= 0) {
        return sendJson(res, 400, { error: '文件大小无效' });
      }
      if (normalizedFileSize >= MAX_FILE_SIZE_BYTES) {
        return sendJson(res, 400, { error: '文件大小必须小于 2GB' });
      }

      const normalizedTotalChunks = Number(totalChunks);
      const normalizedChunkSize = Number(chunkSize);
      if (!Number.isInteger(normalizedTotalChunks) || normalizedTotalChunks <= 0) {
        return sendJson(res, 400, { error: '分片总数无效' });
      }
      if (!Number.isInteger(normalizedChunkSize) || normalizedChunkSize <= 0) {
        return sendJson(res, 400, { error: '分片大小无效' });
      }

      let db = await readIndex();
      if (uploadId && isValidUploadId(uploadId) && db.uploads[uploadId]) {
        const record = db.uploads[uploadId];
        if (!isRecordExpired(record)) {
          return sendJson(res, 200, {
            uploadId,
            code: record.code,
            uploadedChunks: record.uploadedChunks || [],
            maxDownloads: record.maxDownloads || DEFAULT_MAX_DOWNLOADS,
          });
        }
      }

      const maintenance = await runExpiredUploadCleanup();
      const diskStats = await getDiskStats(STORAGE_DIR);
      const currentStorageBytes = maintenance && Number.isFinite(maintenance.storageBytes)
        ? maintenance.storageBytes
        : await getStorageUsageBytes();
      const capacity = checkUploadCapacity(normalizedFileSize, diskStats, currentStorageBytes);
      if (!capacity.ok) {
        return sendJson(res, 400, {
          error: [
            capacity.projectedPeakStorageBytes > APP_STORAGE_HARD_LIMIT_BYTES
              ? `应用存储峰值预计达到 ${formatBytes(capacity.projectedPeakStorageBytes)}，超过硬上限 ${formatBytes(APP_STORAGE_HARD_LIMIT_BYTES)}`
              : null,
            capacity.projectedFreeBytesAfterPeak < MIN_FREE_BYTES_AFTER_PEAK
              ? `上传后系统可用空间预计只剩 ${formatBytes(Math.max(0, capacity.projectedFreeBytesAfterPeak))}，低于保留阈值 ${formatBytes(MIN_FREE_BYTES_AFTER_PEAK)}`
              : null,
          ].filter(Boolean).join('；'),
        });
      }

      db = await readIndex();
      const newUploadId = randomId(20);
      let code = randomCode();
      while (db.codes[code]) code = randomCode();
      const createdAt = new Date().toISOString();

      db.uploads[newUploadId] = {
        uploadId: newUploadId,
        code,
        fingerprint,
        fileName: normalizedFileName,
        fileSize: normalizedFileSize,
        mimeType: mimeType || 'application/octet-stream',
        totalChunks: normalizedTotalChunks,
        chunkSize: normalizedChunkSize,
        maxDownloads: normalizeMaxDownloads(maxDownloads),
        downloadCount: 0,
        storageBytes: 0,
        uploadedChunks: [],
        complete: false,
        createdAt,
        lastChunkAt: createdAt,
        firstDownloadedAt: null,
        lastDownloadedAt: null,
        expiresAt: new Date(Date.parse(createdAt) + INCOMPLETE_UPLOAD_TTL_MS).toISOString(),
      };
      db.codes[code] = newUploadId;
      await ensureDir(path.join(TMP_DIR, newUploadId));
      await writeIndex(db);
      return sendJson(res, 200, {
        uploadId: newUploadId,
        code,
        uploadedChunks: [],
        maxDownloads: db.uploads[newUploadId].maxDownloads,
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/upload/status/')) {
      const uploadId = url.pathname.split('/').pop();
      const db = await readIndex();
      const record = db.uploads[uploadId];
      if (!record) return sendJson(res, 404, { error: '上传任务不存在' });
      const expiredMessage = await purgeIfExpiredBeforeAccess(db, uploadId);
      if (expiredMessage) return sendJson(res, 404, { error: expiredMessage });
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
      if (!isValidUploadId(uploadId)) return sendJson(res, 400, { error: 'uploadId 无效' });
      const idx = Number(url.searchParams.get('index'));
      if (!Number.isInteger(idx) || idx < 0) return sendJson(res, 400, { error: 'chunk index 无效' });
      const db = await readIndex();
      const record = db.uploads[uploadId];
      if (!record) return sendJson(res, 404, { error: '上传任务不存在' });
      const expiredMessage = await purgeIfExpiredBeforeAccess(db, uploadId);
      if (expiredMessage) return sendJson(res, 404, { error: expiredMessage });
      if (record.complete) return sendJson(res, 400, { error: '上传任务已完成' });

      if (idx >= record.totalChunks) return sendJson(res, 400, { error: 'chunk index 超出范围' });

      const body = await readBody(req, Math.max(MAX_CHUNK_BODY_BYTES, Number(record.chunkSize) + 1024));
      if (!body.length) return sendJson(res, 400, { error: '分片内容为空' });
      await fsp.writeFile(path.join(TMP_DIR, uploadId, `${idx}.part`), body);
      record.lastChunkAt = new Date().toISOString();
      if (!record.uploadedChunks.includes(idx)) {
        record.uploadedChunks.push(idx);
        record.uploadedChunks.sort((a, b) => a - b);
      }
      syncUploadRecord(record);
      await writeIndex(db);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && /\/api\/upload\/[^/]+\/complete/.test(url.pathname)) {
      const uploadId = url.pathname.split('/')[3];
      if (!isValidUploadId(uploadId)) return sendJson(res, 400, { error: 'uploadId 无效' });
      const db = await readIndex();
      const record = db.uploads[uploadId];
      if (!record) return sendJson(res, 404, { error: '上传任务不存在' });
      const expiredMessage = await purgeIfExpiredBeforeAccess(db, uploadId);
      if (expiredMessage) return sendJson(res, 404, { error: expiredMessage });
      if (record.complete) return sendJson(res, 200, { ok: true, code: record.code });
      if ((record.uploadedChunks || []).length < record.totalChunks) {
        return sendJson(res, 400, { error: '文件分片未全部上传完成' });
      }
      const filePath = path.join(FILE_DIR, `${record.code}.bin`);
      await mergeChunks(uploadId, record.totalChunks, filePath);
      const mergedStat = await fsp.stat(filePath);
      record.complete = true;
      record.filePath = filePath;
      record.storageBytes = mergedStat.size;
      record.completedAt = new Date().toISOString();
      syncUploadRecord(record);
      await removeDirSafe(path.join(TMP_DIR, uploadId));
      await writeIndex(db);
      await recordAnalyticsEvent('uploadCompleted');
      return sendJson(res, 200, { ok: true, code: record.code });
    }

    if (req.method === 'GET' && /\/api\/download\/[^/]+\/meta/.test(url.pathname)) {
      const code = url.pathname.split('/')[3].toUpperCase();
      if (!isValidCode(code)) return sendJson(res, 400, { error: '提取码格式无效' });
      const db = await readIndex();
      const uploadId = db.codes[code];
      if (!uploadId) return sendJson(res, 404, { error: '提取码不存在' });
      const expiredMessage = await purgeIfExpiredBeforeAccess(db, uploadId);
      if (expiredMessage) {
        return sendJson(res, 404, { error: expiredMessage });
      }
      const record = db.uploads[uploadId];

      if (!record || !record.complete || !record.filePath) {
        return sendJson(res, 404, { error: '文件不存在' });
      }

      const remainingDownloads = Math.max(0, (record.maxDownloads || 1) - (record.downloadCount || 0));
      if (remainingDownloads <= 0) {
        return sendJson(res, 404, { error: '文件下载次数已用完' });
      }

      return sendJson(res, 200, {
        code,
        fileName: record.fileName,
        fileSize: record.fileSize,
        mimeType: record.mimeType,
        remainingDownloads,
        maxDownloads: record.maxDownloads || 1,
      });
    }

    if (req.method === 'GET' && /\/api\/download\/[^/]+$/.test(url.pathname)) {
      const code = url.pathname.split('/')[3].toUpperCase();
      if (!isValidCode(code)) return sendJson(res, 400, { error: '提取码格式无效' });
      const db = await readIndex();
      const uploadId = db.codes[code];
      if (!uploadId) return sendJson(res, 404, { error: '提取码不存在' });
      const expiredMessage = await purgeIfExpiredBeforeAccess(db, uploadId);
      if (expiredMessage) {
        return sendJson(res, 404, { error: expiredMessage });
      }
      const record = db.uploads[uploadId];
      if (!record || !record.complete || !record.filePath) {
        return sendJson(res, 404, { error: '文件不存在' });
      }

      const remainingBefore = Math.max(0, (record.maxDownloads || 1) - (record.downloadCount || 0));
      if (remainingBefore <= 0) {
        return sendJson(res, 404, { error: '文件下载次数已用完' });
      }

      const filePath = record.filePath;
      const stat = await fsp.stat(filePath);
      const total = stat.size;
      const range = req.headers.range;

      const downloadTimestamp = new Date().toISOString();
      record.downloadCount = (record.downloadCount || 0) + 1;
      record.firstDownloadedAt = record.firstDownloadedAt || downloadTimestamp;
      record.lastDownloadedAt = downloadTimestamp;
      record.storageBytes = total;
      syncUploadRecord(record);
      await writeIndex(db);
      await recordAnalyticsEvent('downloadCompleted');

      const safeDownloadName = normalizeFileName(record.fileName) || 'download.bin';
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeDownloadName)}`);
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!match) return sendJson(res, 416, { error: 'Range 头无效' });
        let start = match[1] ? Number(match[1]) : NaN;
        let end = match[2] ? Number(match[2]) : NaN;
        if (Number.isNaN(start) && Number.isNaN(end)) return sendJson(res, 416, { error: 'Range 头无效' });

        if (Number.isNaN(start)) {
          const suffix = end;
          if (!Number.isInteger(suffix) || suffix <= 0) return sendJson(res, 416, { error: 'Range 头无效' });
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          if (!Number.isInteger(start) || start < 0) return sendJson(res, 416, { error: 'Range 头无效' });
          if (Number.isNaN(end)) end = total - 1;
          if (!Number.isInteger(end) || end < start) return sendJson(res, 416, { error: 'Range 头无效' });
        }

        if (start >= total) return sendJson(res, 416, { error: 'Range 超出文件范围' });
        end = Math.min(end, total - 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, { 'Content-Length': total });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    notFound(res);
  } catch (err) {
    const statusCode = err && err.statusCode ? err.statusCode : 500;
    if (!res.headersSent) {
      sendJson(res, statusCode, { error: statusCode >= 500 ? '服务器内部错误' : err.message });
      return;
    }
    res.end();
  }
}

(async () => {
  await ensureStorage();
  await backfillAnalyticsFromIndex();
  await runExpiredUploadCleanup();
  setInterval(() => {
    runExpiredUploadCleanup().catch((err) => {
      console.error('Failed to clean expired undownloaded uploads', err);
    });
  }, CLEANUP_INTERVAL_MS);
  const server = http.createServer((req, res) => {
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (!res.headersSent) sendJson(res, 408, { error: '请求超时' });
    });

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: '请求地址无效' });
      return;
    }

    if (parsedUrl.pathname.startsWith('/api/')) {
      handleApi(req, res, parsedUrl);
      return;
    }
    trackPageView(req, parsedUrl.pathname);
    if (parsedUrl.pathname === '/en' || parsedUrl.pathname === '/en/' || parsedUrl.pathname === '/en/index.html') {
      redirect(res, '/');
      return;
    }
    if (parsedUrl.pathname === '/zh') {
      redirect(res, '/zh/');
      return;
    }
    if (parsedUrl.pathname === '/zh/index.html') {
      redirect(res, '/zh/');
      return;
    }
    serveStatic(parsedUrl.pathname, res);
  });

  server.headersTimeout = 65 * 1000;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5 * 1000;
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen(PORT, () => {
    console.log(`Anonymous transfer app running at http://localhost:${PORT}`);
  });
})();
