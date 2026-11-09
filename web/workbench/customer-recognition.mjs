import { escapeHTML as e } from './model.mjs';

const labels = {waiting:'待识别', ready:'可校对', no_text:'未识别到文字', error:'识别失败'};
const mediaURL = value => typeof value === 'string' && value.startsWith('/api/workbench/clients/') ? e(value) : '';

function imageGallery(images) {
  const items = images.map(image => {
    const preview = mediaURL(image.preview_url);
    const download = mediaURL(image.download_url);
    if (!preview || !download) return '';
    return `<li><a href="${preview}" target="_blank" rel="noopener" aria-label="查看 ${e(image.filename)}">
      <img src="${preview}" alt="" loading="lazy"></a>
      <div><span>第 ${e(image.page)} 页 · ${e(image.filename)}</span>
      <a href="${download}" download>下载</a></div></li>`;
  }).filter(Boolean);
  if (!items.length) return '';
  return `<details class="recognition-gallery"><summary>提取的图片（${items.length} 张）</summary>
    <ul>${items.join('')}</ul></details>`;
}

export class RecognitionReview {
  constructor(service, clientId, doc, report, {editable = true} = {}) {
    Object.assign(this, {service, clientId, doc, report, editable});
    this.currentPage = report.pages[0]?.page;
    this.edits = new Map();
    if (editable) {
      try {
        this.edits = new Map(JSON.parse(sessionStorage.getItem(this.storageKey) || '[]'));
      } catch {}
    }
  }

  get storageKey() { return `fangli.recognition.${this.clientId}.${this.doc.id}`; }
  get waiting() { return this.report.pages.filter(page => page.status === 'waiting'); }

  remember(page, value) {
    if (value == null) this.edits.delete(page);
    else this.edits.set(page, value);
    try { sessionStorage.setItem(this.storageKey, JSON.stringify([...this.edits])); } catch {}
  }

  forget() {
    try { sessionStorage.removeItem(this.storageKey); } catch {}
  }

  markup() {
    const {report} = this;
    return `<section class="customer-recognition">
      ${report.error ? `<p class="error-text">${e(report.error)}</p>` : ''}
      ${report.pages.length ? `<label class="field recognition-page-picker"><span>原件页码</span>
        <select data-ocr-page-select>${report.pages.map(page => `<option value="${e(page.page)}" ${page.page === this.currentPage ? 'selected' : ''}>第 ${e(page.page)} 页 · ${labels[page.status] || '可查看'}</option>`).join('')}</select>
      </label><div data-ocr-page></div>` : '<p class="helper">此文件没有可查看的页面。</p>'}
      ${imageGallery(report.images || [])}
    </section>`;
  }

  bind(container, onRetry) {
    this.root = container.querySelector('.customer-recognition');
    const picker = this.root.querySelector('[data-ocr-page-select]');
    if (!picker) return;
    this.onRetry = onRetry;
    picker.addEventListener('change', () => this.selectPage(Number(picker.value)));
    this.selectPage(this.currentPage);
  }

  selectPage(number) {
    this.currentPage = number;
    this.root.querySelector('[data-ocr-page-select]').value = String(number);
    const page = this.report.pages.find(page => page.page === number);
    const preview = mediaURL(page.preview_url);
    const editable = this.editable && page.status !== 'waiting';
    const failed = page.status === 'error';
    const slot = this.root.querySelector('[data-ocr-page]');
    const value = this.edits.get(number) ?? page.text ?? '';
    slot.innerHTML = `<div class="recognition-page-grid">
      <div class="recognition-source">${preview ? `<a href="${preview}" target="_blank" rel="noopener" aria-label="打开第 ${e(number)} 页原件预览">
        <img src="${preview}" alt="第 ${e(number)} 页原件预览"><span>在新标签打开原页</span></a>` :
        '<p class="helper">原页预览暂不可用。</p>'}</div>
      <div class="recognition-transcript">
        ${page.error ? `<p class="error-text">${e(page.error)}</p>` : ''}
        ${page.status === 'no_text' ? '<p class="helper">这页没有识别到文字，可以手动补录。</p>' : ''}
        ${page.status === 'waiting' ? '<p class="helper">这页等待识别。</p>' :
          `<label class="field"><span>${editable ? '校对文字' : '已识别文字'}</span>
          <textarea rows="10" maxlength="200000" data-ocr-text ${editable ? '' : 'readonly'}>${e(value)}</textarea></label>`}
        ${editable && failed ? `<label class="check-label"><input type="checkbox" data-ocr-skip ${this.edits.get(number) === '' ? 'checked' : ''}>此页仅保留原图</label>
          <div class="inline-actions"><button type="button" class="button outline" data-ocr-retry>重试这页</button>
          ${page.text?.trim() ? '<button type="button" class="button quiet" data-ocr-accept>保留已有文字</button>' : ''}</div>` : ''}
      </div></div>`;
    const field = slot.querySelector('[data-ocr-text]');
    const skip = slot.querySelector('[data-ocr-skip]');
    if (editable) field.addEventListener('input', () => {
      this.remember(number, failed && !field.value.trim() ? null : field.value);
      if (skip) skip.checked = false;
    });
    if (skip) skip.addEventListener('change', () => {
      if (skip.checked) field.value = '';
      this.remember(number, skip.checked ? '' : null);
    });
    slot.querySelector('[data-ocr-accept]')?.addEventListener('click', event => {
      field.value = page.text;
      skip.checked = false;
      this.remember(number,page.text);
      event.currentTarget.textContent = '已保留原有文字';
    });
    slot.querySelector('[data-ocr-retry]')?.addEventListener('click', () => this.onRetry(number));
  }

  async retry(page) {
    await this.service.retryDocument(this.clientId,this.doc.id,{retry_pages:page == null ? [] : [page]});
    await this.reload();
  }

  async processWaiting(onProgress, paused = () => false) {
    const pages = this.waiting;
    if (!pages.length) return;
    const total = this.report.pages.length;
    let done = total - pages.length;
    onProgress(done, total);
    try {
      for (const page of pages) {
        if (paused()) break;
        await this.service.retryDocument(this.clientId,this.doc.id,{retry_pages:[page.page]});
        done++;
        onProgress(done, total);
      }
    } finally { await this.reload(); }
  }

  async reload() {
    this.report = await this.service.recognition(this.clientId,this.doc.id);
    if (!this.report.pages.some(page => page.page === this.currentPage)) this.currentPage = this.report.pages[0]?.page;
  }

  confirmation() {
    if (this.waiting.length) throw new Error('请先识别剩余页面');
    const unresolved = this.report.pages.find(page => page.status === 'error' && !this.edits.has(page.page));
    if (unresolved) {
      this.selectPage(unresolved.page);
      throw new Error(`请补录第 ${unresolved.page} 页文字、重试识别或选择仅保留原图`);
    }
    return this.report.pages.map(page => ({page:page.page,text:this.edits.get(page.page) ?? page.text ?? ''}));
  }

  async confirm() {
    if (!this.report.pages.length) throw new Error('请移出这个文件后重新上传');
    const {document} = await this.service.retryDocument(this.clientId,this.doc.id,{pages:this.confirmation()});
    if (document?.status !== 'ready') throw new Error(document?.error || '识别结果还未确认，请查看资料状态');
    this.forget();
    return document;
  }
}
