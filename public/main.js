const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

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

let currentFile = null;
let currentDownloadMeta = null;

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
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

fileInput.addEventListener('change', () => {
  currentFile = fileInput.files[0];
  if (!currentFile) return;
  fileInfo.textContent = `已选择：${currentFile.name}（${formatSize(currentFile.size)}）`;
  if (currentFile.size >= MAX_FILE_SIZE_BYTES) {
    uploadText.textContent = '文件大小必须小于 5GB';
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

  const maxDownloads = Math.max(1, Number(maxDownloadsInput.value) || 1);
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
    uploadText.textContent = err.name === 'AbortError' ? '初始化超时，请重试' : '网络异常，初始化失败';
    uploadBtn.disabled = false;
    return;
  }

  if (!initRes.ok) {
    let text = '初始化失败';
    try {
      const err = await initRes.json();
      text = err.error || text;
    } catch {
      // ignore
    }
    uploadText.textContent = text;
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
        uploadText.textContent = err.name === 'AbortError' ? `分片 ${i + 1} 上传超时，请重试` : `分片 ${i + 1} 上传网络异常`;
        uploadBtn.disabled = false;
        return;
      }
      if (!resp.ok) {
        uploadText.textContent = `分片 ${i + 1} 上传失败，请重试`;
        uploadBtn.disabled = false;
        return;
      }
      uploadedSet.add(i);
    }

    const percent = Math.round((uploadedSet.size / totalChunks) * 100);
    uploadProgress.style.width = `${percent}%`;
    uploadText.textContent = `上传进度：${percent}% (${uploadedSet.size}/${totalChunks})`;
  }

  let completeRes;
  try {
    completeRes = await fetchWithTimeout(`/api/upload/${uploadId}/complete`, { method: 'POST' });
  } catch (err) {
    uploadText.textContent = err.name === 'AbortError' ? '合并请求超时，请重试' : '网络异常，合并失败';
    uploadBtn.disabled = false;
    return;
  }
  if (!completeRes.ok) {
    uploadText.textContent = '合并文件失败，请重试';
    uploadBtn.disabled = false;
    return;
  }

  localStorage.removeItem(`upload_${fingerprint}`);
  codeText.textContent = code;
  codeHint.textContent = `当前文件可下载 ${maxDownloads} 次`;
  codeBox.classList.remove('hidden');
  uploadText.textContent = '上传完成';
});

fetchMetaBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return;

  let resp;
  try {
    resp = await fetchWithTimeout(`/api/download/${code}/meta`);
  } catch (err) {
    downloadInfo.textContent = err.name === 'AbortError' ? '查询超时，请重试' : '网络异常，查询失败';
    downloadBtn.classList.add('hidden');
    return;
  }
  if (!resp.ok) {
    let text = '提取码无效或文件不存在';
    try {
      const err = await resp.json();
      text = err.error || text;
    } catch {
      // ignore
    }
    downloadInfo.textContent = text;
    downloadBtn.classList.add('hidden');
    return;
  }

  currentDownloadMeta = await resp.json();
  downloadInfo.textContent = `文件：${currentDownloadMeta.fileName}（${formatSize(currentDownloadMeta.fileSize)}），剩余可下载次数：${currentDownloadMeta.remainingDownloads}`;
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
    downloadText.textContent = err.name === 'AbortError' ? '下载请求超时，请重试' : '网络异常，下载失败';
    return;
  }
  if (!resp.ok || !resp.body) {
    let text = '下载失败';
    try {
      const err = await resp.json();
      text = err.error || text;
    } catch {
      // ignore
    }
    downloadText.textContent = text;
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
    downloadText.textContent = `下载进度：${percent}%`;
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
  downloadText.textContent = remaining > 0 ? `下载完成，剩余可下载次数：${remaining}` : '下载完成，下载次数已用完';
});
