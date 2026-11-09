function publicEvidenceMarkup(check, escape) {
  if (!check) return '';
  const link = source => {
    try {
      const url = new URL(source.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(source.title || source.url)}</a>`;
    } catch {
      return '';
    }
  };
  const evidence = check.evidence;
  if (evidence) {
    const kinds = { manufacturer: '原厂资料', issuer: '发证机构', original: '原始资料' };
    return `<p>${escape(kinds[evidence.source_type] || '公开出处')} · ${link(evidence)}</p>
      <blockquote>${escape(evidence.quote)}</blockquote>
      <dl class="plain-dl">
        <div><dt>适用主体</dt><dd>${escape(evidence.subject)}</dd></div>
        <div><dt>适用条件</dt><dd>${escape(evidence.conditions)}</dd></div>
        <div><dt>核对时间</dt><dd>${escape(evidence.checked_at)}</dd></div>
      </dl>`;
  }
  const candidates = (check.candidates || []).map(link).filter(Boolean);
  return `<p class="helper">检索时间 ${escape(check.searched_at || '')}</p>
    ${candidates.length ? `<details><summary>待核对的公开候选</summary><ul>${candidates.map(item => `<li>${item}</li>`).join('')}</ul></details>` : ''}`;
}

export function articleEditorialMarkup(value, escape, { blocked, historical, candidate, activity = '' }) {
  const documents = value.documents || [];
  const statusLabels = {
    client_provided: '客户提供', editor_edited: '编辑修订', not_checked: '未做公开核对',
    candidates: '有公开候选，待人工核对', no_result: '未找到公开候选',
    supported: '编辑已核对公开依据', conflict: '编辑发现公开出处有冲突',
  };
  const refs = items => (items || []).map(ref => {
    const index = documents.findIndex(doc => doc.id === ref.document_id &&
      doc.revision === ref.revision && doc.digest === ref.digest);
    const doc = documents[index];
    return `<blockquote>${escape(ref.quote || '')}</blockquote>
      <p class="helper">${escape(doc?.filename || ref.filename || '来源资料')}${ref.revision == null ? '' : ` · 版本 ${escape(ref.revision)}`}
      ${doc ? `<button type="button" class="button quiet sm" data-editorial-source="${index}">查看本版来源</button>` : ''}</p>`;
  }).join('');
  const sections = [
    ['所选资料中的关键说法', value.important_claims, claim => {
      const status = [claim.check_status, claim.public_check_status].filter(Boolean)
        .map(item => statusLabels[item] || item).join(' · ');
      return `<p>${escape(claim.text)}</p>${status ? `<small>${escape(status)}</small>` : ''}
        ${publicEvidenceMarkup(claim.public_check, escape)}${refs(claim.source_refs)}`;
    }, '本版资料没有留存关键说法记录。'],
    ['所选资料中的冲突', value.conflicts, conflict =>
      `<p><strong>${escape(conflict.topic || '')}</strong></p><p>${escape(conflict.detail || '')}</p>${refs(conflict.source_refs)}`,
    '本版资料没有留存冲突记录。'],
    [value.risk_tips_inherited ? '沿用的原稿处理说明' : '生成时记录的处理说明', value.risk_tips, note =>
      `<p>${escape(typeof note === 'string' ? note : JSON.stringify(note))}</p>`, '本版没有留存处理说明。'],
  ];
  const issues = value.fact_issues || [];
  const pending = issues.filter(issue => issue.state === 'pending');
  const repaired = [...issues.filter(issue => issue.state === 'resolved'), ...(value.fact_repairs || [])];
  const state = { unchecked:'未核查', failed:'核查未完成', unverified:'待复核', pass:'复核完成', needs_review:'待处理',
    checked:pending.length ? '核查完成，仍有待处理问题' : '核查完成' }[value.fact_status] || '待复核';
  const button = (action, label, attr = '', disabled = false) => `<button type="button" class="button quiet sm" data-action="${action}" ${attr} ${disabled ? 'disabled' : ''}>${label}</button>`;
  const beforeAfter = item => `<div class="fact-change"><small>原句</small><blockquote>${escape(item.quote || '')}</blockquote><small>修订句</small><p>${escape(item.revised || '已移除此处表述')}</p></div>`;
  const candidateCheck = candidate?.fact_check;
  const checkLabel = {pass:'修订句已复核',needs_review:'修订句仍有待核问题',unverified:'修订句复核未完成'};
  return `<div class="editorial-details"><p class="helper">版本 ${escape(value.version_id)} · ${historical ? '历史版 · ' : ''}${value.fact_scope === 'repaired_sentences' ? '修订句复核 · ' : ''}${state}</p>
    ${value.fact_summary ? `<p class="helper">${escape(value.fact_summary)}</p>` : ''}
    ${activity}
    ${candidate ? `<section class="fact-candidate"><h3>修订候选 · 版本 ${escape(candidate.candidate_version)}</h3>
      ${candidateCheck ? `<p class="helper">${escape(checkLabel[candidateCheck.status] || '')}${candidateCheck.summary ? ` · ${escape(candidateCheck.summary)}` : ''}</p>` : ''}
      ${candidate.repairs.map(beforeAfter).join('')}
      ${button('adopt-fact-repair','采用修订',`data-version="${escape(candidate.candidate_version)}"`,blocked)}</section>` : ''}
    <section aria-label="待处理事实问题"><div class="spread"><h3>待处理问题</h3>
      ${!historical && pending.some(issue => issue.repairable) ? button('repair-facts','一键修正','',blocked) : ''}</div>
      ${pending.map(issue => `<div class="fact-issue"><strong>${escape(issue.kind || issue.why || '请核对事实')}</strong>
        <blockquote>${escape(issue.quote || '未留存原句')}</blockquote>${issue.kind && issue.why ? `<p>${escape(issue.why)}</p>` : ''}
        <div class="inline-actions">${!historical && issue.repairable ? button('locate-fact','定位原句',`data-issue="${issue.id}"`) + button('repair-facts','修正此项',`data-issue="${issue.id}"`,blocked) : ''}</div>
        ${!issue.repairable ? '<p class="helper">原句无法唯一定位，请对照正文核对。</p>' : ''}
        ${issue.source_refs?.length ? `<details><summary>查看依据</summary>${refs(issue.source_refs)}</details>` : ''}</div>`).join('') || '<p class="helper">本版无待处理问题记录。</p>'}</section>
    ${repaired.length ? `<details class="inspector-disclosure"><summary>已处理 · ${repaired.length} 条</summary>${repaired.map(beforeAfter).join('')}</details>` : ''}
    ${sections.map(([title, items, markup, empty]) => `<details class="inspector-disclosure"><summary>${title}</summary>${items?.length ? items.map(markup).join('') : `<p class="helper">${empty}</p>`}</details>`).join('')}
    <details class="inspector-disclosure" data-editorial-sources><summary>本版资料原文</summary>${documents.map((doc, index) =>
      `<details data-editorial-document="${index}"><summary>${escape(doc.filename)}${doc.revision == null ? '' : ` · 版本 ${escape(doc.revision)}`}</summary>
        <pre class="diff-text">${escape(doc.text || '')}</pre></details>`).join('') || '<p class="helper">本版没有留存资料原文。</p>'}</details></div>`;
}
