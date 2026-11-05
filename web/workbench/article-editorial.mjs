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

export function articleEditorialMarkup(value, escape) {
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
    ['生成后的事实核查问题', value.fact_issues, issue =>
      `<blockquote>${escape(issue.quote || '')}</blockquote><p>${escape([issue.kind, issue.why].filter(Boolean).join(' · '))}</p>
       ${issue.revised != null ? `<p>核查后表述：${escape(issue.revised)}</p>` : ''}${refs(issue.source_refs)}`,
    '本版没有留存事实问题。'],
    [value.risk_tips_inherited ? '沿用的原稿处理说明' : '生成时记录的处理说明', value.risk_tips, note =>
      `<p>${escape(typeof note === 'string' ? note : JSON.stringify(note))}</p>`, '本版没有留存处理说明。'],
  ];
  return `<p class="helper">版本 ${escape(value.version_id)} · 资料说法和冲突供审阅，稿件实际采用情况以正文和核查记录为准。</p>
    ${sections.map(([title, items, markup, empty]) =>
      `<section><h3>${title}</h3>${items?.length ? items.map(markup).join('') : `<p class="helper">${empty}</p>`}</section>`).join('')}
    <section><h3>本版资料原文</h3>${documents.map((doc, index) =>
      `<details data-editorial-document="${index}"><summary>${escape(doc.filename)}${doc.revision == null ? '' : ` · 版本 ${escape(doc.revision)}`}</summary>
        <pre class="diff-text">${escape(doc.text || '')}</pre></details>`).join('') || '<p class="helper">本版没有留存资料原文。</p>'}</section>`;
}
