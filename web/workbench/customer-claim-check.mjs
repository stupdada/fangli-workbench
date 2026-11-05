import { escapeHTML as e } from './model.mjs';

const labels = {
  not_checked:'公开来源尚未核对', candidates:'已找到候选出处，待核对原文',
  no_result:'本次搜索未返回出处', supported:'已找到公开依据', conflict:'公开出处与说法有冲突',
};
const sourceTypes = {manufacturer:'原厂',issuer:'发证机构',original:'原始资料'};

function date(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '';
}

function sourceLink(url, title) {
  try {
    const link = new URL(url);
    if (['http:','https:'].includes(link.protocol) && !link.username && !link.password) {
      return `<a href="${e(link.href)}" target="_blank" rel="noopener noreferrer">${e(title)}</a>`;
    }
  } catch { /* Invalid source links are shown as text. */ }
  return e(title);
}

function action(name, text, key) {
  return `<button type="button" class="button quiet" data-customer-action="${name}" data-id="${e(key)}">${text}</button>`;
}

export function renderClaimCheck(claim, configured) {
  const check = claim?.public_check;
  const status = check?.status || 'not_checked';
  const evidence = check?.evidence;
  const candidates = check?.candidates || [];
  const timestamp = date(evidence?.checked_at || check?.searched_at);
  const label = `<p><strong>${e(labels[status])}</strong>${timestamp ? ` <time datetime="${e(evidence?.checked_at || check.searched_at)}">${e(timestamp)}</time>` : ''}</p>`;
  const query = check?.query ? `<p class="helper">检索词 ${e(check.query)}</p>` : '';
  const entry = evidence?.candidate_url && evidence.candidate_url !== evidence.url
    ? `<dt>检索入口</dt><dd>${sourceLink(evidence.candidate_url,evidence.candidate_title)}</dd>` : '';
  const saved = evidence ? `<dl><dt>出处</dt><dd>${sourceLink(evidence.url,evidence.title)} · ${e(sourceTypes[evidence.source_type])}</dd>${entry}<dt>原文摘录</dt><dd><blockquote>${e(evidence.quote)}</blockquote></dd><dt>适用主体</dt><dd>${e(evidence.subject)}</dd><dt>适用条件</dt><dd>${e(evidence.conditions)}</dd></dl>` : '';
  let control = '';
  if (candidates.length) control = action('claim-review',evidence ? '编辑核对记录' : `核对 ${candidates.length} 个出处`,claim.claim_key);
  else if (!check && configured && claim?.claim_key) control = action('claim-search','查找公开出处',claim.claim_key);
  return `${label}${query}${saved}${control}`;
}

export function claimSearchForm(claim) {
  return `<p>${e(claim.text)}</p><label class="field"><span>公开检索词</span><input name="query" required maxlength="120" placeholder="公司、产品、发证机构或证书编号"></label><p class="helper">只发送这里填写的检索词。可以用原厂、发证机构或原始资料的名称缩小范围。</p>`;
}

export function claimReviewForm(claim) {
  const {evidence, candidates, status} = claim.public_check;
  const entry = evidence?.candidate_url || evidence?.url;
  const hasOriginal = evidence?.candidate_url && (evidence.candidate_url !== evidence.url || evidence.candidate_title !== evidence.title);
  const options = candidates.map(c => `<option value="${e(c.url)}" ${c.url === entry ? 'selected' : ''}>${e(c.title)}</option>`).join('');
  const sources = candidates.map(c => `<li><p>${sourceLink(c.url,c.title)}</p>${c.snippet ? `<p class="helper">${e(c.snippet)}</p>` : ''}</li>`).join('');
  return `<p>${e(claim.text)}</p><h3>候选出处</h3><p class="helper">打开出处核对原文，并确认它适用于该主体与条件。</p><ol class="claim-candidates">${sources}</ol>
    <label class="field"><span>检索入口</span><select name="url" required><option value="">请选择候选出处</option>${options}</select></label>
    <p class="helper">如果你从候选页打开了产品原页或技术资料，请填写实际核对的网址和标题。直接核对候选页时留空即可。</p>
    <label class="field"><span>原始出处网址（可选）</span><input name="source_url" type="url" maxlength="2000" value="${e(hasOriginal ? evidence.url : '')}"></label>
    <label class="field"><span>原始出处标题（可选）</span><input name="source_title" maxlength="300" value="${e(hasOriginal ? evidence.title : '')}"></label>
    <label class="field"><span>出处类型</span><select name="source_type" required><option value="">请选择</option>${Object.entries(sourceTypes).map(([key,label]) => `<option value="${key}" ${key === evidence?.source_type ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label class="field"><span>核对结论</span><select name="status" required><option value="">请选择</option><option value="supported" ${status === 'supported' ? 'selected' : ''}>已找到公开依据</option><option value="conflict" ${status === 'conflict' ? 'selected' : ''}>公开出处与说法有冲突</option></select></label>
    <label class="field"><span>原文摘录</span><textarea name="quote" rows="3" required maxlength="2000">${e(evidence?.quote)}</textarea></label>
    <label class="field"><span>适用主体</span><input name="subject" required maxlength="200" value="${e(evidence?.subject)}"></label>
    <label class="field"><span>适用条件</span><textarea name="conditions" rows="2" required maxlength="600" placeholder="例如证书有效期、型号或测试条件">${e(evidence?.conditions)}</textarea></label>`;
}
