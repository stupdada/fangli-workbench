import { escapeHTML as e, PROFILE_FIELDS, clone } from './model.mjs';
import { renderClaimCheck } from './customer-claim-check.mjs';

export function intakeDraft(record) {
  const adopted = record.adoption?.editorial;
  return { name:record.proposed_client.name, profile:clone(record.proposed_client.profile),
    editorial:clone(adopted || record.result), expected_profile_version:record.expected_profile_version,
    expected_adoption_id:record.expected_adoption_id };
}

export function updateIntakeDraft(draft, field, value) {
  if (field === 'name') draft.name = value;
  else if (field.startsWith('profile:')) draft.profile[field.slice(8)] = value;
  else if (field === 'overview') draft.editorial.overview.text = value;
  else if (field.startsWith('keyword:')) draft.editorial.keywords[Number(field.slice(8))].text = value;
  else if (field.startsWith('claim:')) draft.editorial.important_claims[Number(field.slice(6))].text = value;
  else if (field.startsWith('conflict:')) draft.editorial.conflicts[Number(field.slice(9))].detail = value;
  return draft;
}

const button = (action, label, extra = '', primary = false) => `<button type="button" class="button ${primary ? 'primary' : 'quiet'}" data-customer-action="${action}" ${extra}>${label}</button>`;
function references(items = []) {
  if (!items.length) return '';
  return `<details class="intake-references"><summary>查看来源 · ${items.length}</summary>${items.map(r => `<div><span>${e(r.filename)} · 修订 ${e(r.revision)}</span><blockquote>${e(r.quote)}</blockquote></div>`).join('')}</details>`;
}

function savedClaims(record) {
  return (record.adoption?.editorial || record.result).important_claims;
}

const intakeSteps = [
  ['prepare', '准备资料', '正在准备本次选用的资料…'],
  ['organize', '整理档案', '正在提取档案信息、业务概览和关键词…'],
  ['verify', '校验来源', '正在核对摘录与原文…'],
];

function renderIntakeProgress(progress) {
  const current = intakeSteps.findIndex(([stage]) => stage === progress?.stage);
  if (current < 0) return '';
  const steps = intakeSteps.map(([,label], index) => {
    const state = index < current ? ' class="is-complete"' : index === current ? ' aria-current="step"' : '';
    return `<li${state}>${label}${index < current ? '<span class="sr-only">，已完成</span>' : ''}</li>`;
  }).join('');
  return `<div class="intake-progress">
    <div class="intake-progress-status"><p role="status">第 ${current + 1} 步，共 ${intakeSteps.length} 步 · ${intakeSteps[current][2]}</p><span>已用时 ${e(progress.elapsed_seconds)} 秒</span></div>
    <ol class="intake-progress-steps" aria-label="客户资料整理进度">${steps}</ol>
  </div>`;
}

export function renderIntake(record, draft, { busy = false, message = '', compact = false, statusUnavailable = false } = {}) {
  if (!record) return '<div class="empty"><h2>整理客户资料</h2><p>在资料页选择文件，生成档案建议、业务概览和关键词。</p></div>';
  if (record.status !== 'ready') {
    const running = record.status === 'running';
    const progress = running && !statusUnavailable ? renderIntakeProgress(record.progress) : '';
    return `<section class="customer-intake">
      <header><h2>整理客户资料</h2>${running && statusUnavailable ? button('intake-refresh','读取状态') : ''}</header>
      ${progress || `<p role="status">${e(message || (running ? '正在整理客户档案…' : record.error || '整理尚未完成'))}</p>`}
      ${['error','interrupted'].includes(record.status) ? button('intake-retry','重新整理') : ''}
      <p class="muted">${record.sources.map(d => `${e(d.filename)} · 修订 ${e(d.revision)}`).join('；')}</p>
    </section>`;
  }
  const result = draft.editorial;
  const fields = PROFILE_FIELDS.map(([key, label]) => {
    const current = key === 'name' ? record.current_client.name : record.current_client.profile[key];
    const suggestion = record.result.profile_suggestion[key];
    const value = key === 'name' ? draft.name : draft.profile[key];
    const differs = suggestion && suggestion !== current;
    return `<div class="intake-field"><label class="field"><span>${e(label)}</span><input data-intake-field="${key === 'name' ? 'name' : `profile:${key}`}" value="${e(value)}" maxlength="${key === 'name' ? 100 : 4000}"></label>${differs ? `<p class="intake-suggestion">资料建议：${e(suggestion)} ${suggestion !== value ? button('intake-use-field','使用建议',`data-field="${e(key)}"`) : ''}</p>` : ''}${current && differs ? `<p class="intake-field-conflict">当前档案：${e(current)}</p>` : ''}${references(record.result.profile_sources[key])}</div>`;
  });
  const profile = compact
    ? `<div class="intake-profile-grid">${fields.slice(0,5).join('')}</div><details class="intake-references"><summary>联系方式</summary><div class="intake-profile-grid">${fields.slice(5).join('')}</div></details>`
    : `<div class="intake-profile-grid">${fields.join('')}</div>`;
  const claims = result.important_claims.map((claim,i) => {
    const saved = savedClaims(record)[i];
    const changed = claim.text !== saved?.text;
    return `<div class="intake-editorial-row"><label class="field"><span>说法 ${i+1}</span><textarea data-intake-field="claim:${i}" rows="2" maxlength="4000">${e(claim.text)}</textarea></label>${references(claim.source_refs)}
      ${compact ? '' : `<div class="intake-claim-check" data-claim-check ${changed ? 'hidden' : ''}>${renderClaimCheck(saved,record.public_search_configured)}</div>
      <p class="helper" data-claim-check-draft ${changed ? '' : 'hidden'}>保存改动后可核对这条说法。</p>`}</div>`;
  }).join('');
  const searchNote = record.public_search_configured === false ? '<p class="intake-status-note">当前工作台未配置公开搜索。</p>' : '';
  const conflicts = `<h3>资料内部冲突</h3>${result.conflicts.length ? result.conflicts.map((c,i) => `<div class="intake-editorial-row"><label class="field"><span>${e(c.topic)}</span><textarea data-intake-field="conflict:${i}" rows="3" maxlength="4000">${e(c.detail)}</textarea></label>${references(c.source_refs)}</div>`).join('') : '<p class="muted">本次整理未识别到内部冲突。</p>'}`;
  const claimsSection = compact ? (result.important_claims.length ? `<details class="intake-references"><summary>重要说法 · ${result.important_claims.length}</summary>${claims}</details>` : '') : `<h3>重要说法</h3>${searchNote}${claims}`;
  const footer = compact ? '' : `<footer class="intake-footer"><span>确认后更新客户档案并保存整理结果。</span>${button('intake-save',busy ? '正在保存…' : '确认保存',busy ? 'disabled' : '',true)}</footer>`;
  return `<section class="customer-intake" data-intake-editor="${e(record.id)}"><header><div><h2>整理结果</h2><p>${record.sources.map(d => `${e(d.filename)} · 修订 ${e(d.revision)}`).join('；')}</p></div><span class="intake-save-state" role="status">${e(message || (record.adoption ? '已保存，可继续修改' : '待确认保存'))}</span></header>${compact && result.conflicts.length ? conflicts : ''}<h3>客户档案</h3>${profile}<h3>业务概览</h3><label class="field"><span class="sr-only">业务概览</span><textarea data-intake-field="overview" rows="${compact ? 3 : 6}" maxlength="6000">${e(result.overview.text)}</textarea></label>${references(result.overview.source_refs)}<h3>关键词</h3><div class="intake-keywords">${result.keywords.map((k,i) => `<label class="field"><span class="sr-only">关键词 ${i+1}</span><input data-intake-field="keyword:${i}" value="${e(k.text)}" maxlength="4000"></label>`).join('')}</div><details class="intake-references"><summary>关键词来源</summary>${result.keywords.map(k => `<div><strong>${e(k.text)}</strong>${references(k.source_refs)}</div>`).join('')}</details>${claimsSection}${!compact || !result.conflicts.length ? conflicts : ''}${footer}</section>`;
}

export class CustomerIntake {
  constructor(service, onChange) {
    this.service = service; this.onChange = onChange; this.drafts = new Map(); this.generation = 0;
    this.statusUnavailable = false;
  }
  stop() { clearTimeout(this.timer); this.generation++; }
  switchClient(cid) { if (this.cid !== cid) { this.stop(); this.cid = cid; this.record = null; this.draft = null; this.message = ''; } }
  accept(record, message) {
    if (message !== undefined) this.message = message;
    else if (this.statusUnavailable || this.record?.id !== record?.id || this.record?.status === 'running' && record?.status !== 'running') this.message = '';
    this.statusUnavailable = false;
    this.record = record;
    if (record?.status === 'ready') {
      const key = `${record.id}:${record.expected_profile_version}:${record.expected_adoption_id || ''}`;
      this.draft = this.drafts.get(key) || intakeDraft(record); this.drafts.set(key,this.draft); this.key = key;
    }
    this.onChange();
  }
  async load(cid) { this.switchClient(cid); const generation = this.generation; const {intake} = await this.service.latestIntake(cid); if (generation === this.generation) this.accept(intake); }
  async start(cid, ids, retry = false) {
    this.switchClient(cid); this.stop(); const generation = this.generation;
    const data = await this.service.startIntake(cid,{document_ids:ids,retry});
    if (generation !== this.generation) return;
    this.accept(data.intake,data.reused && data.intake.status === 'ready' ? '已复用本次资料的整理结果' : '');
    if (data.intake.status === 'running') this.watch(60);
  }
  watch(remaining) {
    const generation = this.generation;
    this.timer = setTimeout(async () => {
      if (generation !== this.generation) return;
      try { await this.refresh(); }
      catch (error) {
        if (generation === this.generation) this.reportUnavailable(error.message);
        return;
      }
      if (generation !== this.generation || this.record?.status !== 'running') return;
      if (remaining > 1) this.watch(remaining-1);
      else this.reportUnavailable('暂未收到整理结果，可手动读取状态。');
    },5000);
  }
  reportUnavailable(message) {
    this.statusUnavailable = true;
    this.message = message;
    this.onChange();
  }
  async refresh({resume = false} = {}) {
    if (!this.record) return this.load(this.cid);
    const cid = this.cid, id = this.record.id, generation = this.generation;
    const {intake} = await this.service.intake(cid,id);
    if (generation !== this.generation || this.record?.id !== id) return;
    this.accept(intake);
    if (resume && intake.status === 'running') this.watch(60);
  }
  change(field,value) { updateIntakeDraft(this.draft,field,value); this.message = '有修改待保存'; }
  claimChanged(index) { return this.draft.editorial.important_claims[index]?.text !== savedClaims(this.record)[index]?.text; }
  claimForCheck(key) {
    const claims = savedClaims(this.record);
    const index = claims.findIndex(claim => claim.claim_key === key);
    if (index < 0 || this.claimChanged(index)) throw new Error('请先保存改动，再核对这条说法');
    return claims[index];
  }
  useField(key) {
    this.change(key === 'name' ? key : `profile:${key}`,this.record.result.profile_suggestion[key]);
    this.onChange();
  }
  async save() {
    const data = await this.service.adoptIntake(this.cid,this.record.id,clone(this.draft));
    this.drafts.delete(this.key); this.accept(data.intake,'已保存'); return data.client;
  }
  view() { return renderIntake(this.record,this.draft,{busy:this.busy,message:this.message,statusUnavailable:this.statusUnavailable}); }
}

export function installIntakeStyles() {
  if (document.querySelector('link[data-customer-intake-style]')) return;
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = new URL('./customer-intake.css',import.meta.url).href;
  style.dataset.customerIntakeStyle = ''; document.head.append(style);
}
