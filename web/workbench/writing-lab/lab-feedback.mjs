export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const ratings = {ready: '可交付', revise: '需修改', rewrite: '建议重写'};
export const sideLabel = {left: 'A', right: 'B'};

export function selectionTools(side) {
  return `<div class="lab-selection" data-selection-side="${side}" hidden>
    <button class="button quiet" type="button" data-mark="like">喜欢这段</button>
    <button class="button quiet" type="button" data-mark="issue">这段有问题</button></div>`;
}

export function markList(marks) {
  return marks.map((mark, index) => `<li><span>${sideLabel[mark.side]} · ${mark.kind === 'like' ? '喜欢' : '有问题'}</span>
    <q>${escape(mark.text)}</q><button type="button" class="button quiet" data-remove-mark="${index}" aria-label="移除第 ${index + 1} 处选段">移除</button></li>`).join('');
}

export function feedbackFields(feedback, full) {
  const select = side => `<label class="field"><span>${sideLabel[side]} 稿能否交付</span><select class="input" data-publish="${side}">
    <option value="">暂不判断</option>${Object.entries(ratings).map(([value, label]) => `<option value="${value}"${feedback.publish?.[side] === value ? ' selected' : ''}>${label}</option>`).join('')}
    </select></label>`;
  return `<details class="lab-feedback" id="lab-feedback"${Object.keys(feedback).length ? ' open' : ''}>
    <summary>写细评 <span>可选</span></summary>
    <div class="lab-feedback-fields">
      <p class="lab-help">选中 A 或 B 的原文，可以标记喜欢或有问题的段落。</p>
      <ul class="lab-marks" data-marks>${markList(feedback.marks || [])}</ul>
      ${full ? `<div class="lab-form-row">${select('left')}${select('right')}</div>` : ''}
      <label class="field"><span>自由评语</span><textarea class="input" data-note maxlength="1000" rows="3" placeholder="A 的开头更好，B 的正文更实用…">${escape(feedback.note)}</textarea></label>
      <label class="field"><span>你的写法</span><textarea class="input" data-rewrite maxlength="1800" rows="3" placeholder="可贴上你会用的一句话或一段改写。">${escape(feedback.rewrite)}</textarea></label>
      <div><button class="button outline" type="button" data-vote="feedback">只保存细评，下一题</button></div>
    </div></details>`;
}

export function collectFeedback(root, marks) {
  const feedback = {note: root.querySelector('[data-note]')?.value.trim() || '',
    rewrite: root.querySelector('[data-rewrite]')?.value.trim() || '', marks,
    publish: Object.fromEntries([...root.querySelectorAll('[data-publish]')]
      .filter(select => select.value).map(select => [select.dataset.publish, select.value]))};
  return feedback;
}

function supportingFeedback(sample) {
  const feedback = sample.feedback;
  return `<li><strong>${escape(sample.topic)}</strong>
    ${sample.reason ? `<p>${escape(sample.reason)}</p>` : ''}${feedback.note ? `<p>${escape(feedback.note)}</p>` : ''}
    ${(feedback.marks || []).map(mark => `<p>${sideLabel[mark.side]} · ${mark.kind === 'like' ? '喜欢' : '有问题'} <q>${escape(mark.text)}</q></p>`).join('')}
    ${feedback.rewrite ? `<p>你的写法 <q>${escape(feedback.rewrite)}</q></p>` : ''}</li>`;
}

export function analysisMarkup({current, useful, voted}) {
  const active = current && ['queued', 'running'].includes(current.status);
  const result = current?.result;
  const evidence = new Map((current?.evidence || []).map(item => [item.id, item]));
  const start = useful && !active && (!current || current.stale || current.status === 'error');
  const action = current?.status === 'error' && !current.stale ? '重试分析' : current ? '分析更新后的反馈' : '分析已选反馈';
  let status = '选过一些题后，可以先分析这部分反馈。片段和全文评完后会自动分析。';
  if (active) status = current.status === 'queued' ? '分析已排队。' : `正在分析 ${current.votes} 道题的反馈…`;
  else if (current?.status === 'error') status = current.error || '本次分析未完成。';
  else if (current) status = `${current.final ? '整轮分析' : '阶段分析'} · 基于 ${current.votes} 道已评题${current.stale ? ' · 有新的反馈待分析' : ''}`;
  else if (voted && !useful) status = '当前只有跳过记录。完成一道有选择或评语的题目后即可分析。';

  return `<section class="lab-analysis" aria-label="反馈分析">
    <div class="lab-analysis-head"><div><h2>反馈分析</h2><p class="${current?.status === 'error' ? 'error-text' : 'lab-help'}" role="status">${escape(status)}</p></div>
      ${start ? `<button type="button" class="button primary" data-analyze="${current?.status === 'error' && !current.stale ? 'retry' : 'start'}">${action}</button>` : ''}</div>
    ${result ? `<div class="lab-analysis-content"><p>${escape(result.summary)}</p>
      ${result.findings.map(item => {
        const samples = item.evidence.map(id => evidence.get(id)).filter(Boolean);
        return `<article class="lab-finding"><h3>${escape(item.scope || '反馈发现')}</h3><p>${escape(item.observation)}</p>
          ${samples.length ? `<details><summary>查看 ${samples.length} 条样本依据</summary><ul>${samples.map(supportingFeedback).join('')}</ul></details>` : ''}</article>`;
      }).join('')}
      ${result.proposal ? `<div class="lab-proposal"><p class="lab-help">候选提示词</p><h3>${escape(result.proposal.title)}</h3>
        <p class="lab-help">建议范围 · ${escape(result.proposal.scope)}</p><p class="lab-rule">${escape(result.proposal.rule)}</p>
        <button type="button" class="button outline" data-next-round="${escape(current.id)}">用这条建议开下一轮</button></div>` : ''}
      ${result.checks.length ? `<div class="lab-finding"><h3>下一轮核对项</h3><ul>${result.checks.map(check => `<li>${escape(check)}</li>`).join('')}</ul></div>` : ''}
    </div>` : ''}</section>`;
}
