let pdfModule;
const decode = value => { try { return decodeURIComponent(value); } catch { return value || ''; } };
export const saveUrl = url => `${url}${url.includes('?') ? '&' : '?'}save=1`;

// Finished files go straight to the folder set in 工作台设置. A rejected folder must not lose
// the export: the response is then the same bytes plus a reason, and the browser downloads them.
export async function fetchDelivery(url, filename, { fetcher = globalThis.fetch } = {}) {
  const response = await fetcher(saveUrl(url));
  if (!response.ok) {
    let data; try { data = await response.json(); } catch {}
    throw new Error(data?.error || '下载失败，请核对当前状态');
  }
  if ((response.headers?.get?.('content-type') || '').includes('application/json')) {
    const data = await response.json();
    if (data?.path) return { saved: data.path, name: data.name || filename };
    throw new Error('保存结果不完整，请重试');
  }
  return { saved: null, warning: decode(response.headers?.get?.('x-download-error')), blob: await response.blob() };
}

export async function parseFile(file, api) {
  if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 超过 8 MB，请拆分后添加`);
  if (file.name.toLowerCase().endsWith('.pdf')) {
    pdfModule ||= import('/assets/vendor/pdf.min.mjs');
    const pdfjs = await pdfModule;
    pdfjs.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdf.worker.min.mjs';
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false,
      cMapUrl: '/assets/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/assets/vendor/standard_fonts/', useSystemFonts: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 100) throw new Error('PDF 超过 100 页，请选取相关页面后添加');
      const pages = []; let chars = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i); const content = await page.getTextContent();
        const text = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim(); page.cleanup();
        if (!text) throw new Error(`PDF 第 ${i} 页没有文字，请先做 OCR 并核对`);
        chars += text.length; if (chars > 200000) throw new Error('PDF 正文超过 20 万字，请选取相关页面');
        pages.push(`【第 ${i} 页】\n${text}`);
      }
      return { filename: file.name, kind: 'PDF 文档', text: pages.join('\n\n') };
    } finally { await task.destroy(); }
  }
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const result = await api('/api/parse', 'POST', { filename: file.name, content_b64: btoa(binary) });
  // Native ZIP parser returns fields directly, never replaced with a browser-only parser.
  const parsed = result.material || result.document || result;
  if (!parsed.text?.trim()) throw new Error(`${file.name} 未解析到正文`);
  return { filename: file.name, kind: parsed.kind || '文件', text: parsed.text, warning: parsed.warning || '' };
}
