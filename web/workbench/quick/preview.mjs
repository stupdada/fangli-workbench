import { escapeHTML as e } from '../model.mjs';

const accounts = {official:'官方号', personal:'个人号'};

export function createBatchPreview(root) {
  const dialog = document.createElement('dialog');
  dialog.className = 'quick-preview-dialog';
  dialog.setAttribute('aria-labelledby','quick-preview-title');
  dialog.innerHTML = `<form novalidate>
    <header><h2 id="quick-preview-title">生成安排</h2><p data-preview-notice hidden></p></header>
    <div class="quick-preview-list"></div>
    <footer><span data-preview-total role="status"></span><div class="inline-actions">
      <button class="button quiet" type="button" data-preview-back>返回调整</button>
      <button class="button primary" type="submit">开始生成</button>
    </div></footer>
  </form>`;
  root.append(dialog);
  const form = dialog.querySelector('form');
  const notice = form.querySelector('[data-preview-notice]');
  const list = form.querySelector('.quick-preview-list');
  const total = form.querySelector('[data-preview-total]');
  const start = form.querySelector('[type="submit"]');
  const saved = new Map();
  let shown = [], inputs = new Map(), resolveReview, confirmation;

  function updateSelection() {
    let articles = 0, videos = 0;
    for (const group of shown) {
      for (const row of group.rows) {
        const {pick, edit, input, dependencyNote, element} = inputs.get(row);
        const dependency = group.byId.get(row.depends_on);
        pick.disabled = Boolean(dependency && !dependency.selected);
        if (pick.disabled) row.selected = false;
        pick.checked = row.selected;
        edit.disabled = input.disabled = !row.selected;
        if (dependencyNote) dependencyNote.hidden = !pick.disabled;
        element.classList.toggle('is-excluded',!row.selected);
        if (row.selected) row.kind === 'article' ? articles++ : videos++;
      }
    }
    total.textContent = `文章 ${articles} 篇 · 视频 ${videos} 条`;
    start.disabled = articles + videos === 0;
  }

  function rowMarkup(row, group, index) {
    const format = row.format === '短视频' ? '短视频文案' : row.format;
    const type = row.kind === 'article' ? `文章 · ${format}` : format;
    const platform = [row.platform_name,accounts[row.account_type]].filter(Boolean).join(' · ');
    const dependency = group.byId.get(row.depends_on);
    const facts = [
      row.keywords?.length ? `关键词 · ${row.keywords.join('、')}` : '',
      row.related_keywords?.length ? `串联词 · ${row.related_keywords.join('、')}` : '',
      row.style_name ? `写法 · ${row.style_name}` : '',
      row.length_hint ? `篇幅 · ${row.length_hint}` : '',
      row.kind === 'video' ? (dependency ? `来源 · 本客户第 ${dependency.position} 篇文章` : '来源 · 客户资料') : '',
    ].filter(Boolean);
    return `<li class="quick-preview-row">
      <label class="quick-preview-choice"><input type="checkbox" data-preview-pick aria-label="生成第 ${index} 条 ${e(row.topic)}">
        <span><strong data-preview-topic>${e(row.topic)}</strong><small>${e(platform)} · ${e(type)}</small></span></label>
      <button type="button" class="button quiet" data-preview-edit aria-expanded="false" aria-label="换题 第 ${index} 条">换题</button>
      <label data-preview-editor hidden><span class="sr-only">第 ${index} 条题目</span><input data-preview-input maxlength="500" required value="${e(row.topic)}"></label>
      ${dependency ? `<small data-preview-dependency hidden>来源文章已取消</small>` : ''}
      ${facts.length ? `<details class="quick-preview-source"><summary>查看依据</summary>${facts.map(text=>`<p>${e(text)}</p>`).join('')}</details>` : ''}
    </li>`;
  }

  function review(items, message = '') {
    shown = items.map(item=>{
      const plan = item.preview;
      const previous = saved.get(item.client_id);
      if (previous?.revision === plan.revision) return previous;
      const rows = plan.rows.map(row=>({...row, selected:true}));
      const group = {...plan, clientId:item.client_id, name:item.name, rows, byId:new Map(rows.map(row=>[row.id,row]))};
      saved.set(item.client_id,group);
      return group;
    });
    notice.textContent = message;
    notice.hidden = !message;
    let index = 0;
    list.innerHTML = shown.map(group=>`<section aria-label="${e(group.name)}"><h3>${e(group.name)}</h3>
      ${group.documents.length ? `<details class="quick-preview-documents"><summary>资料修订</summary><p>${group.documents.map(doc=>e(`${doc.filename}（修订 ${doc.revision}）`)).join('、')}</p></details>` : ''}
      <ol>${group.rows.map(row=>rowMarkup(row,group,++index)).join('')}</ol></section>`).join('');
    const elements = [...list.querySelectorAll('.quick-preview-row')];
    inputs = new Map(shown.flatMap(group=>group.rows).map((row,i)=>{
      const element = elements[i];
      const pick = element.querySelector('[data-preview-pick]');
      const edit = element.querySelector('[data-preview-edit]');
      const editor = element.querySelector('[data-preview-editor]');
      const input = element.querySelector('[data-preview-input]');
      const dependencyNote = element.querySelector('[data-preview-dependency]');
      const title = element.querySelector('[data-preview-topic]');
      pick.addEventListener('change',()=>{
        row.selected = pick.checked;
        updateSelection();
      });
      edit.addEventListener('click',()=>{
        editor.hidden = !editor.hidden;
        edit.setAttribute('aria-expanded',String(!editor.hidden));
        if (!editor.hidden) input.focus();
      });
      input.addEventListener('input',()=>{
        row.topic = input.value;
        title.textContent = row.topic;
        pick.setAttribute('aria-label',`生成第 ${i + 1} 条 ${row.topic}`);
        input.removeAttribute('aria-invalid');
      });
      return [row,{pick,edit,input,dependencyNote,element}];
    }));
    updateSelection();
    confirmation = null;
    return new Promise(resolve=>{
      resolveReview = resolve;
      dialog.showModal();
    });
  }

  form.addEventListener('submit',event=>{
    event.preventDefault();
    if (start.disabled) return;
    for (const [row, {input,element,edit}] of inputs) {
      if (!row.selected || row.topic.trim()) continue;
      element.querySelector('[data-preview-editor]').hidden = false;
      edit.setAttribute('aria-expanded','true');
      input.setAttribute('aria-invalid','true');
      input.focus();
      return;
    }
    confirmation = shown.map(group=>({
      clientId:group.clientId, revision:group.revision,
      rows:group.rows.filter(row=>row.selected).map(row=>({id:row.id,topic:row.topic.trim()})),
    })).filter(group=>group.rows.length);
    dialog.close();
  });
  form.querySelector('[data-preview-back]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{
    resolveReview?.(confirmation);
    resolveReview = null;
  });
  return {review, clear:()=>saved.clear(), close:()=>{if (dialog.open) dialog.close();}};
}
