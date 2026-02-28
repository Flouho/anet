const CHUNK_SIZE = 5 * 1024 * 1024;
const LOGIN_SECRET = 'Welcome!2026';

const LOGIN_COOKIE_NAME = 'anet_login';
const LOGIN_COOKIE_VALUE = 'ok';
const LOGIN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

function setLoginCookie() {
  document.cookie = `${LOGIN_COOKIE_NAME}=${LOGIN_COOKIE_VALUE}; Max-Age=${LOGIN_COOKIE_MAX_AGE}; Path=/; SameSite=Lax`;
}

function clearLoginCookie() {
  document.cookie = `${LOGIN_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
}

function hasLoginCookie() {
  const key = `${LOGIN_COOKIE_NAME}=${LOGIN_COOKIE_VALUE}`;
  return document.cookie.split(';').some((item) => item.trim() === key);
}

const welcomePage = document.getElementById('welcomePage');
const appPage = document.getElementById('appPage');
const loginToggleBtn = document.getElementById('loginToggleBtn');

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

function showWelcome() {
  welcomePage.classList.remove('hidden');
  appPage.classList.add('hidden');
}

function showApp() {
  welcomePage.classList.add('hidden');
  appPage.classList.remove('hidden');
}

loginToggleBtn.addEventListener('click', () => {
  if (hasLoginCookie()) {
    clearLoginCookie();
    showWelcome();
    return;
  }

  const input = window.prompt('请输入登录口令');
  if (input === LOGIN_SECRET) {
    setLoginCookie();
    showApp();
    return;
  }
  window.alert('口令错误，返回欢迎页面');
  showWelcome();
});

if (hasLoginCookie()) {
  showApp();
} else {
  showWelcome();
}

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

  const initRes = await fetch('/api/upload/init', {
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

  if (!initRes.ok) {
    uploadText.textContent = '初始化失败';
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

      const resp = await fetch(`/api/upload/${uploadId}/chunk?index=${i}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
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

  const completeRes = await fetch(`/api/upload/${uploadId}/complete`, { method: 'POST' });
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

  const resp = await fetch(`/api/download/${code}/meta`);
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

  const resp = await fetch(`/api/download/${code}`);
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
  URL.revokeObjectURL(url);

  const remaining = Math.max(0, Number(currentDownloadMeta.remainingDownloads || 1) - 1);
  currentDownloadMeta.remainingDownloads = remaining;
  downloadText.textContent = remaining > 0 ? `下载完成，剩余可下载次数：${remaining}` : '下载完成，下载次数已用完';
});
