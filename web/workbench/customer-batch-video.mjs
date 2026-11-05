import { escapeHTML as e, planSummary } from './model.mjs';

const MAX_VIDEOS = 3;
const videoStages = { waiting_article:'等待文章', script:'短脚本', render:'制作成片', done:'成片完成' };
export const batchVideoRetryable = video => ['error', 'interrupted'].includes(video?.status);

function button(action, label, attributes = '') {
  return `<button type="button" class="button quiet" data-customer-action="${action}" ${attributes}>${label}</button>`;
}

export function videoPlanner() {
  return `<div class="batch-video-planner"><div class="batch-video-line"><h3>视频安排</h3>${button('batch-video-add','添加视频')}</div><div data-batch-video-rows></div></div>`;
}

function videoFields() {
  return `<div class="batch-video-row" data-batch-video-row>
    <label class="field"><span>视频主题</span><input data-batch-video-topic maxlength="500" placeholder="例如：长毛猫洗护前要准备什么"></label>
    <div class="batch-video-fields">
      <label class="field"><span>内容来源</span><select data-batch-video-source><option value="documents">客户资料直出</option><option value="article">本批次文章</option></select></label>
      <label class="field" data-batch-article-index hidden><span>第几篇文章</span><input inputmode="numeric" data-batch-video-index disabled></label>
    </div>
    <div class="batch-video-line"><label class="check-label"><input type="checkbox" data-batch-video-narration checked>普通话配音</label>${button('batch-video-remove','移除视频')}</div>
  </div>`;
}

export function updateVideoSource(select) {
  const field = select.closest('[data-batch-video-row]').querySelector('[data-batch-article-index]');
  field.hidden = select.value !== 'article';
  field.querySelector('input').disabled = field.hidden;
}

export function updateVideoLimit(editor) {
  const count = editor.querySelectorAll('[data-batch-video-row]').length;
  editor.querySelector('[data-batch-video-limit]').textContent = `视频 ${count} / ${MAX_VIDEOS} 条`;
  for (const button of editor.querySelectorAll('[data-customer-action="batch-video-add"]')) button.disabled = count >= MAX_VIDEOS;
}

export function addBatchVideo(editor, planner) {
  if (editor.querySelectorAll('[data-batch-video-row]').length >= MAX_VIDEOS) return;
  const rows = planner.querySelector('[data-batch-video-rows]');
  rows.insertAdjacentHTML('beforeend', videoFields());
  updateVideoLimit(editor);
  rows.lastElementChild.querySelector('[data-batch-video-topic]').focus();
}

export function collectBatchVideos(customer, articleCount) {
  return Array.from(customer.querySelectorAll('[data-batch-video-row]'), (row, index) => {
    const value = selector => row.querySelector(selector).value.trim();
    const topic = value('[data-batch-video-topic]');
    const source = value('[data-batch-video-source]');
    if (!topic) throw new Error(`请填写第 ${index + 1} 条视频的主题`);
    const video = {topic, source, narration:row.querySelector('[data-batch-video-narration]').checked};
    if (source === 'article') {
      if (!articleCount) throw new Error(`第 ${index + 1} 条视频需要本批文章，请先安排文章或改用客户资料`);
      const valueIndex = value('[data-batch-video-index]');
      const articleIndex = Number(valueIndex);
      if (!/^\d+$/.test(valueIndex) || articleIndex < 1 || articleIndex > articleCount) {
        throw new Error(`第 ${index + 1} 条视频请选择第 1 到第 ${articleCount} 篇文章`);
      }
      video.article_index = articleIndex;
    }
    return video;
  });
}

export function assertBatchVideoLimit(items) {
  if (items.reduce((count, item) => count + (item.videos?.length || 0), 0) > MAX_VIDEOS) {
    throw new Error(`每批最多安排 ${MAX_VIDEOS} 条视频`);
  }
}

function sourceLabel(video) {
  return video.source === 'article' ? `本批第 ${video.article_index} 篇文章` : '客户资料直出';
}

export function batchConfirmation(check, clientName, platforms) {
  const items = check.items || [];
  const summary = check.ready
    ? `<p>共 ${items.length} 位客户，${Number(check.total || 0)} 篇文章、${Number(check.video_total || 0)} 条视频。提交后进入后台队列。</p>`
    : '<p class="error-text">请检查以下客户的生成安排。</p>';
  const issues = (check.issues || []).map(issue => `<p class="error-text">${e(clientName(issue.client_id))}：${e(issue.error)}</p>`);
  const rows = items.map(item => {
    const articleCount = Number(item.planned || 0);
    const videos = item.videos || [];
    const articles = articleCount ? ` · ${e(planSummary(item.options || {},platforms).text)}` : '';
    const videoList = videos.length ? `<ul>${videos.map(video => `<li><strong>${e(video.topic)}</strong><span>${e(sourceLabel(video))} · ${video.narration === false ? '无配音' : '普通话配音'}</span></li>`).join('')}</ul>` : '';
    return `<div class="batch-confirm-item"><strong>${e(item.name)}</strong><p>${articleCount} 篇文章、${videos.length} 条视频${articles}</p>${videoList}</div>`;
  });
  return [summary, ...issues, ...rows].join('');
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

export function batchVideoResults(batch, statusName) {
  const items = (batch.items || []).filter(item => item.videos?.length);
  if (!items.length) return '';
  const groups = items.map(item => {
    const videos = item.videos.map(video => {
      const draft = productionLink(item, video);
      const preview = video.status === 'done' ? previewLink(video.preview_url) : '';
      const open = video.status === 'done'
        ? link(preview || draft, '预览成片')
        : link(draft, '打开草稿');
      const retry = batchVideoRetryable(video) ? button('batch-video-retry', '重试此视频', `data-id="${e(video.id)}"`) : '';
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
