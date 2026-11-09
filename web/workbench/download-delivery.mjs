export const LOCAL_DOWNLOAD_HEADERS = { 'X-Fangli-Local-Download': '1' };

export function localDownloadHeaders(hostname = globalThis.location?.hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' ? LOCAL_DOWNLOAD_HEADERS : {};
}

function decodeHeader(value) {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch { return value; }
}

export async function fetchDelivery(url, fallbackName, { saveLocal = false, fetcher = globalThis.fetch } = {}) {
  const response = saveLocal ? await fetcher(url, {
    method: 'POST',
    headers: { ...LOCAL_DOWNLOAD_HEADERS, 'Content-Type': 'application/json' },
    body: '{}',
  }) : await fetcher(url);
  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { /* Some gateway errors are plain text. */ }
    throw new Error(data?.error || '下载失败，请核对当前状态');
  }
  const disposition = response.headers.get('Content-Disposition');
  if (saveLocal && !disposition) {
    const data = await response.json();
    if (data.ok && data.path) return { saved: data.path, name: data.name || fallbackName };
    throw new Error('保存结果不完整，请重试');
  }
  const name = decodeHeader(disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]) || fallbackName;
  return { name, warning: decodeHeader(response.headers.get('X-Download-Error')), blob: await response.blob() };
}

export function startBrowserDownload({ blob, name }) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
