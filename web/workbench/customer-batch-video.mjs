import { escapeHTML as e } from './model.mjs';

export const MAX_BATCH_VIDEOS = 3;
const videoStages = { waiting_article:'等待文章', script:'短脚本', render:'制作成片', done:'成片完成' };
export const batchVideoRetryable = video => ['error', 'interrupted'].includes(video?.status);

function button(action, label, attributes = '') {
  return `<button type="button" class="button quiet" data-customer-action="${action}" ${attributes}>${label}</button>`;
}

export function assertBatchVideoLimit(items) {
  if (items.reduce((count, item) => count + (item.videos?.length || 0), 0) > MAX_BATCH_VIDEOS) {
    throw new Error(`每批最多安排 ${MAX_BATCH_VIDEOS} 条视频`);
  }
}

function sourceLabel(video) {
  return video.source === 'article' ? `本批第 ${video.article_index} 篇文章` : '客户资料直出';
}

function productionLink(item, video) {
  if (!item.client_id || !video.production_id) return '';
  const query = new URLSearchParams({client_id:item.client_id, production_id:video.production_id});
  return `/video/narrated/?${query}`;
}

function previewLink(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '';
  try {
    const origin = 'http://workbench.local';
    const url = new URL(value, origin);
    if (url.origin === origin && (url.pathname.startsWith('/api/video/') || url.pathname.startsWith('/video/'))) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch { return ''; }
  return '';
}

function link(href, label) {
  return href ? `<a class="button quiet" href="${e(href)}" target="_blank" rel="noopener">${label}</a>` : '';
}

export function batchVideoResults(batch, statusName, {retryInBatch = false} = {}) {
  const items = (batch.items || []).filter(item => item.videos?.length);
  if (!items.length) return '';
  const groups = items.map(item => {
    const videos = item.videos.map(video => {
      const draft = productionLink(item, video);
      const preview = video.status === 'done' ? previewLink(video.preview_url) : '';
      const open = video.status === 'done'
        ? link(preview || draft, '预览成片')
        : link(draft, '打开草稿');
      const retry = batchVideoRetryable(video) ? retryInBatch
        ? `<a class="button quiet" href="/workbench/zip/index.html?area=customers&amp;batch=${encodeURIComponent(batch.id)}">到批次管理重试</a>`
        : button('batch-video-retry', '重试此视频', `data-id="${e(video.id)}"`) : '';
      const stage = video.status !== 'done' ? videoStages[video.stage] : '';
      const details = [sourceLabel(video), statusName(video.status), stage].filter(Boolean);
      return `<li class="batch-video-result"><div><strong>${e(video.topic)}</strong><p>${details.map(e).join(' · ')}</p>${video.error ? `<p class="error-text">${e(video.error)}</p>` : ''}</div><div class="batch-video-actions">${open}${retry}</div></li>`;
    });
    return `<div class="batch-video-group"><h3>${e(item.name)}</h3><ul>${videos.join('')}</ul></div>`;
  });
  return `<section class="batch-video-results" aria-label="视频进度"><h2 class="section-title">视频</h2>${groups.join('')}</section>`;
}

export function installBatchVideoStyles() {
  if (document.querySelector('link[data-batch-video-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./customer-batch-video.css', import.meta.url).href;
  link.dataset.batchVideoStyle = '';
  document.head.append(link);
}
