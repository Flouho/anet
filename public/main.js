const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DOWNLOADS = 10;
const DEFAULT_MAX_DOWNLOADS = 3;
const FETCH_TIMEOUT_MS = 30000;
const LANG = (document.documentElement.lang || 'zh-CN').toLowerCase();
const IS_EN = LANG.startsWith('en');

const COPY = IS_EN ? {
  selectedFile: 'Selected: {name} ({size})',
  sizeLimit: 'File size must be smaller than 2GB',
  initTimeout: 'Initialization timed out. Please try again.',
  initNetworkError: 'Network error. Failed to initialize upload.',
  initFailed: 'Failed to initialize upload',
  chunkTimeout: 'Chunk {index} upload timed out. Please retry.',
  chunkNetworkError: 'Chunk {index} upload hit a network error.',
  chunkFailed: 'Chunk {index} upload failed. Please retry.',
  uploadProgress: 'Upload progress: {percent}% ({done}/{total})',
  mergeTimeout: 'Merge request timed out. Please retry.',
  mergeNetworkError: 'Network error. Failed to merge file.',
  mergeFailed: 'Failed to merge file. Please retry.',
  uploadComplete: 'Upload complete',
  uploadCodeHint: 'This file can be downloaded {count} time(s)',
  lookupTimeout: 'Lookup timed out. Please retry.',
  lookupNetworkError: 'Network error. Failed to look up file.',
  invalidCode: 'Invalid code or file not found',
  downloadInfo: 'File: {name} ({size}), remaining downloads: {count}',
  downloadTimeout: 'Download request timed out. Please retry.',
  downloadNetworkError: 'Network error. Download failed.',
  downloadFailed: 'Download failed',
  downloadProgress: 'Download progress: {percent}%',
  downloadCompleteRemaining: 'Download complete. Remaining downloads: {count}',
  downloadCompleteExhausted: 'Download complete. The file has reached its download limit.',
  statsUnavailable: 'Live stats are temporarily unavailable.',
  statsUpdatedAt: 'Updated {time}',
  statsChartNoData: 'Traffic bars will appear here after recent activity is recorded.'
} : {
  selectedFile: '已选择：{name}（{size}）',
  sizeLimit: '文件大小必须小于 2GB',
  initTimeout: '初始化超时，请重试',
  initNetworkError: '网络异常，初始化失败',
  initFailed: '初始化失败',
  chunkTimeout: '分片 {index} 上传超时，请重试',
  chunkNetworkError: '分片 {index} 上传网络异常',
  chunkFailed: '分片 {index} 上传失败，请重试',
  uploadProgress: '上传进度：{percent}% ({done}/{total})',
  mergeTimeout: '合并请求超时，请重试',
  mergeNetworkError: '网络异常，合并失败',
  mergeFailed: '合并文件失败，请重试',
  uploadComplete: '上传完成',
  uploadCodeHint: '当前文件可下载 {count} 次',
  lookupTimeout: '查询超时，请重试',
  lookupNetworkError: '网络异常，查询失败',
  invalidCode: '提取码无效或文件不存在',
  downloadInfo: '文件：{name}（{size}），剩余可下载次数：{count}',
  downloadTimeout: '下载请求超时，请重试',
  downloadNetworkError: '网络异常，下载失败',
  downloadFailed: '下载失败',
  downloadProgress: '下载进度：{percent}%',
  downloadCompleteRemaining: '下载完成，剩余可下载次数：{count}',
  downloadCompleteExhausted: '下载完成，下载次数已用完',
  statsUnavailable: '实时统计暂时不可用',
  statsUpdatedAt: '更新于 {time}',
  statsChartNoData: '有访问数据后，这里会显示最近 7 天的趋势图。'
};

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

const fileInput = document.getElementById('fileInput');
const maxDownloadsInput = document.getElementById('maxDownloadsInput');
const fileInfo = document.getElementById('fileInfo');
const uploadBtn = document.getElementById('uploadBtn');
const uploadProgressWrap = document.getElementById('uploadProgressWrap');
const uploadProgress = document.getElementById('uploadProgress');
const uploadText = document.getElementById('uploadText');
const codeBox = document.getElementById('codeBox');
const codeText = document.getElementById('codeText');
const codeHint = document.getElementById('codeHint');

const codeInput = document.getElementById('codeInput');
const fetchMetaBtn = document.getElementById('fetchMetaBtn');
const downloadInfo = document.getElementById('downloadInfo');
const downloadBtn = document.getElementById('downloadBtn');
const downloadProgressWrap = document.getElementById('downloadProgressWrap');
const downloadProgress = document.getElementById('downloadProgress');
const downloadText = document.getElementById('downloadText');
const statsMeta = document.getElementById('statsMeta');
const statValueNodes = document.querySelectorAll('[data-stat-key]');
const statsChart = document.getElementById('statsChart');
const statsChartEmpty = document.getElementById('statsChartEmpty');

let currentFile = null;
let currentDownloadMeta = null;

function text(key, params = {}) {
  return Object.entries(params).reduce((result, [name, value]) => (
    result.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
  ), COPY[key] || '');
}

function formatNumber(value) {
  return new Intl.NumberFormat(IS_EN ? 'en-US' : 'zh-CN').format(Number(value) || 0);
}

function getByPath(source, keyPath) {
  return keyPath.split('.').reduce((result, key) => (
    result && Object.prototype.hasOwnProperty.call(result, key) ? result[key] : undefined
  ), source);
}

function renderStatsChart(days) {
  if (!statsChart) return;
  const chartDays = Array.isArray(days) ? days : [];
  const maxValue = chartDays.reduce((max, day) => Math.max(max, Number(day.pageViews) || 0), 0);
  if (!chartDays.length || maxValue === 0) {
    statsChart.innerHTML = '';
    if (statsChartEmpty) {
      statsChartEmpty.textContent = text('statsChartNoData');
      statsChartEmpty.classList.remove('hidden');
    }
    return;
  }

  if (statsChartEmpty) {
    statsChartEmpty.classList.add('hidden');
  }

  statsChart.innerHTML = chartDays.map((day) => {
    const value = Number(day.pageViews) || 0;
    const height = Math.max(12, Math.round((value / maxValue) * 100));
    return `
      <div class="chart-bar-wrap">
        <div class="chart-bar-value">${formatNumber(value)}</div>
        <div class="chart-bar-track">
          <div class="chart-bar-fill" style="height:${height}%"></div>
        </div>
        <div class="chart-bar-label">${day.label}</div>
      </div>
    `;
  }).join('');
}

async function loadPublicStats() {
  if (!statValueNodes.length) return;
  try {
    const response = await fetchWithTimeout('/api/stats/public');
    if (!response.ok) {
      throw new Error('stats request failed');
    }
    const payload = await response.json();
    statValueNodes.forEach((node) => {
      const value = getByPath(payload, node.dataset.statKey);
      node.textContent = typeof value === 'number' ? formatNumber(value) : '--';
    });
    renderStatsChart(payload.recentDays);
    if (statsMeta) {
      const updatedAt = payload.updatedAt ? new Date(payload.updatedAt) : null;
      const formattedTime = updatedAt && !Number.isNaN(updatedAt.getTime())
        ? updatedAt.toLocaleString(IS_EN ? 'en-US' : 'zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
        : '--';
      statsMeta.textContent = text('statsUpdatedAt', { time: formattedTime });
    }
  } catch (_err) {
    statValueNodes.forEach((node) => {
      node.textContent = '--';
    });
    renderStatsChart([]);
    if (statsMeta) {
      statsMeta.textContent = text('statsUnavailable');
    }
  }
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tabs.forEach((t) => t.setAttribute('aria-selected', 'false'));
    panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

function fingerprintOf(file) {
  return `${file.name}_${file.size}_${file.lastModified}`;
}

function normalizeMaxDownloads(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return DEFAULT_MAX_DOWNLOADS;
  return Math.min(MAX_DOWNLOADS, Math.max(1, Math.floor(numericValue)));
}

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
});

if (maxDownloadsInput) {
  maxDownloadsInput.max = String(MAX_DOWNLOADS);
  maxDownloadsInput.value = String(normalizeMaxDownloads(maxDownloadsInput.value || DEFAULT_MAX_DOWNLOADS));
  maxDownloadsInput.addEventListener('input', () => {
    maxDownloadsInput.value = String(normalizeMaxDownloads(maxDownloadsInput.value));
  });
}

fileInput.addEventListener('change', () => {
  currentFile = fileInput.files[0];
  if (!currentFile) return;
  fileInfo.textContent = text('selectedFile', { name: currentFile.name, size: formatSize(currentFile.size) });
  if (currentFile.size >= MAX_FILE_SIZE_BYTES) {
    uploadText.textContent = text('sizeLimit');
    uploadBtn.disabled = true;
    codeBox.classList.add('hidden');
    return;
  }
  uploadText.textContent = '';
  uploadBtn.disabled = false;
  codeBox.classList.add('hidden');
});

uploadBtn.addEventListener('click', async () => {
  if (!currentFile) return;
  uploadBtn.disabled = true;
  uploadProgressWrap.classList.remove('hidden');

  const maxDownloads = normalizeMaxDownloads(maxDownloadsInput.value);
  maxDownloadsInput.value = String(maxDownloads);
  const totalChunks = Math.ceil(currentFile.size / CHUNK_SIZE);
  const fingerprint = fingerprintOf(currentFile);
  const savedUploadId = localStorage.getItem(`upload_${fingerprint}`);

  let initRes;
  try {
    initRes = await fetchWithTimeout('/api/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: currentFile.name,
      fileSize: currentFile.size,
      mimeType: currentFile.type || 'application/octet-stream',
      totalChunks,
      chunkSize: CHUNK_SIZE,
      fingerprint,
      maxDownloads,
      uploadId: savedUploadId,
    }),
    });
  } catch (err) {
    uploadText.textContent = err.name === 'AbortError' ? text('initTimeout') : text('initNetworkError');
    uploadBtn.disabled = false;
    return;
  }

  if (!initRes.ok) {
    let errorText = text('initFailed');
    try {
      const err = await initRes.json();
      errorText = err.error || errorText;
    } catch {
      // ignore
    }
    uploadText.textContent = errorText;
    uploadBtn.disabled = false;
    return;
  }

  const initData = await initRes.json();
  const { uploadId, code } = initData;
  const uploadedSet = new Set(initData.uploadedChunks || []);
  localStorage.setItem(`upload_${fingerprint}`, uploadId);

  for (let i = 0; i < totalChunks; i += 1) {
    if (!uploadedSet.has(i)) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(currentFile.size, start + CHUNK_SIZE);
      const chunk = currentFile.slice(start, end);

      let resp;
      try {
        resp = await fetchWithTimeout(`/api/upload/${uploadId}/chunk?index=${i}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
        }, 120000);
      } catch (err) {
        uploadText.textContent = err.name === 'AbortError'
          ? text('chunkTimeout', { index: i + 1 })
          : text('chunkNetworkError', { index: i + 1 });
        uploadBtn.disabled = false;
        return;
      }
      if (!resp.ok) {
        uploadText.textContent = text('chunkFailed', { index: i + 1 });
        uploadBtn.disabled = false;
        return;
      }
      uploadedSet.add(i);
    }

    const percent = Math.round((uploadedSet.size / totalChunks) * 100);
    uploadProgress.style.width = `${percent}%`;
    uploadText.textContent = text('uploadProgress', {
      percent,
      done: uploadedSet.size,
      total: totalChunks,
    });
  }

  let completeRes;
  try {
    completeRes = await fetchWithTimeout(`/api/upload/${uploadId}/complete`, { method: 'POST' });
  } catch (err) {
    uploadText.textContent = err.name === 'AbortError' ? text('mergeTimeout') : text('mergeNetworkError');
    uploadBtn.disabled = false;
    return;
  }
  if (!completeRes.ok) {
    uploadText.textContent = text('mergeFailed');
    uploadBtn.disabled = false;
    return;
  }

  localStorage.removeItem(`upload_${fingerprint}`);
  codeText.textContent = code;
  codeHint.textContent = text('uploadCodeHint', { count: maxDownloads });
  codeBox.classList.remove('hidden');
  uploadText.textContent = text('uploadComplete');
});

fetchMetaBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return;

  let resp;
  try {
    resp = await fetchWithTimeout(`/api/download/${code}/meta`);
  } catch (err) {
    downloadInfo.textContent = err.name === 'AbortError' ? text('lookupTimeout') : text('lookupNetworkError');
    downloadBtn.classList.add('hidden');
    return;
  }
  if (!resp.ok) {
    let errorText = text('invalidCode');
    try {
      const err = await resp.json();
      errorText = err.error || errorText;
    } catch {
      // ignore
    }
    downloadInfo.textContent = errorText;
    downloadBtn.classList.add('hidden');
    return;
  }

  currentDownloadMeta = await resp.json();
  downloadInfo.textContent = text('downloadInfo', {
    name: currentDownloadMeta.fileName,
    size: formatSize(currentDownloadMeta.fileSize),
    count: currentDownloadMeta.remainingDownloads,
  });
  downloadBtn.classList.remove('hidden');
});

downloadBtn.addEventListener('click', async () => {
  if (!currentDownloadMeta) return;
  const code = currentDownloadMeta.code;
  downloadProgressWrap.classList.remove('hidden');
  downloadProgress.style.width = '0%';

  let resp;
  try {
    resp = await fetchWithTimeout(`/api/download/${code}`, {}, 120000);
  } catch (err) {
    downloadText.textContent = err.name === 'AbortError' ? text('downloadTimeout') : text('downloadNetworkError');
    return;
  }
  if (!resp.ok || !resp.body) {
    let errorText = text('downloadFailed');
    try {
      const err = await resp.json();
      errorText = err.error || errorText;
    } catch {
      // ignore
    }
    downloadText.textContent = errorText;
    return;
  }

  const total = Number(resp.headers.get('Content-Length')) || currentDownloadMeta.fileSize;
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const percent = Math.round((received / total) * 100);
    downloadProgress.style.width = `${percent}%`;
    downloadText.textContent = text('downloadProgress', { percent });
  }

  const blob = new Blob(chunks, { type: currentDownloadMeta.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentDownloadMeta.fileName;
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  const remaining = Math.max(0, Number(currentDownloadMeta.remainingDownloads || 1) - 1);
  currentDownloadMeta.remainingDownloads = remaining;
  downloadText.textContent = remaining > 0
    ? text('downloadCompleteRemaining', { count: remaining })
    : text('downloadCompleteExhausted');
});

loadPublicStats();
