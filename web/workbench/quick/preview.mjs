import { escapeHTML as e } from '../model.mjs';
import { createTopicHistory, TopicChoice } from '../topic-recommendation.mjs';
import { readBrowserDraft, writeBrowserDraft } from '../browser-draft.mjs';

const accounts = {official:'官方号', personal:'个人号'};
const kinds = {article:'文章选题', video:'视频选题'};
const draftKey = 'fangli.quick-preview.draft.v1';
const countLabel = (articles, videos) => [articles && `${articles} 篇文章`, videos && `${videos} 条视频`].filter(Boolean).join('和 ');

export function createBatchPreview(root, recommend) {
  const dialog = document.createElement('dialog');
  dialog.className = 'quick-preview-dialog';
  dialog.setAttribute('aria-labelledby','quick-preview-title');
  dialog.innerHTML = `<form novalidate>
    <header><h2 id="quick-preview-title">生成安排</h2><p>每项推荐 3 题，默认选第 1 题。可查看备选或取消生成。</p><p data-preview-notice role="status" hidden></p></header>
    <div class="quick-preview-list"></div>
    <footer><span data-preview-total role="status"></span><div class="inline-actions">
      <button class="button quiet" type="button" data-preview-back>返回调整</button>
      <button class="button primary" type="submit">确认生成</button>
    </div></footer>
  </form>`;
  root.append(dialog);
  const form = dialog.querySelector('form');
  const notice = form.querySelector('[data-preview-notice]');
  const list = form.querySelector('.quick-preview-list');
  const total = form.querySelector('[data-preview-total]');
  const start = form.querySelector('[type="submit"]');
  const saved = new Map();
  const drafts = new Map(Object.entries(readBrowserDraft(draftKey) || {}));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let shown = [], resolveReview, confirmation, generation = 0, loading = false, reviewMessage = '';

  const included = row => row.choice.topic && !row.choice.excluded;
  const canRefresh = row => !row.choice.manual && !row.choice.excluded;
  const optionButtons = choice => choice.options.map(topic=>`<button type="button" class="button quiet" data-preview-select value="${e(topic)}" aria-pressed="${choice.topic === topic}">${e(topic)}</button>`).join('');

  function updateSelection() {
    const selected = shown.flatMap(group=>group.rows.filter(included));
    const articles = selected.filter(row=>row.kind === 'article').length;
    const videos = selected.length - articles;
    total.textContent = `已选 ${countLabel(articles, videos) || '0 条'}`;
    start.textContent = selected.length ? `生成 ${countLabel(articles, videos)}` : '确认生成';
    start.disabled = loading || !selected.length || shown.some(group=>group.rows.some(row=>!row.choice.recommended));
    for (const section of list.querySelectorAll('[data-preview-kind]')) {
      const group = shown[Number(section.dataset.group)];
      const rows = group.rows.filter(row=>row.kind === section.dataset.previewKind);
      section.querySelector('[data-preview-refresh]').disabled = loading || !rows.some(canRefresh);
      const select = section.querySelector('[data-preview-select-all]');
      select.disabled = loading || !rows.some(row=>row.choice.topic);
      select.textContent = rows.every(included) ? '取消全选' : '全选';
      for (const field of section.querySelectorAll('[data-preview-include],[data-preview-select],[data-preview-more],[data-preview-alternatives]')) {
        const row = group.byId.get(field.closest('[data-preview-row]').dataset.previewRow);
        field.disabled = loading || !row.choice.topic;
      }
    }
  }

  function rowMarkup(row) {
    const choice = row.choice;
    const format = row.format === '短视频' ? '短视频文案' : row.format;
    const metadata = row.kind === 'article' ? [row.platform_name, accounts[row.account_type], format].filter(Boolean).join(' · ') : '成片 30—45 秒';
    const facts = [row.keywords?.length ? `关键词 · ${row.keywords.join('、')}` : '',
      row.related_keywords?.length ? `串联词 · ${row.related_keywords.join('、')}` : '',
      row.style_name ? `写法 · ${row.style_name}` : '', row.length_hint ? `篇幅 · ${row.length_hint}` : ''].filter(Boolean);
    return `<li class="quick-preview-row${choice.excluded ? ' is-excluded' : ''}" data-preview-row="${e(row.id)}">
      <label class="quick-preview-choice">
        <input type="checkbox" data-preview-include ${included(row) ? 'checked' : ''}>
        <span><small>${e(metadata)}</small><strong>${e(choice.topic || '等待推荐')}</strong></span>
      </label>
      <button type="button" class="button quiet" data-preview-more aria-expanded="${choice.expanded}">${choice.expanded ? '收起备选' : '看备选'}</button>
      <div class="quick-preview-candidates" ${choice.expanded ? '' : 'inert'}><div class="quick-preview-candidate-inner">
        <div data-preview-options>${optionButtons(choice)}</div>
        <div class="quick-preview-option-tools">
          ${facts.length ? `<details class="quick-preview-source"><summary>查看依据</summary>${facts.map(text=>`<p>${e(text)}</p>`).join('')}</details>` : ''}
          <button type="button" class="button quiet" data-preview-alternatives>换两题</button>
        </div>
        <p class="error-text" data-preview-row-error role="status" hidden></p>
      </div></div>
    </li>`;
  }

  function syncDisclosure(node, choice) {
    const more = node.querySelector('[data-preview-more]');
    more.setAttribute('aria-expanded',String(choice.expanded));
    more.textContent = choice.expanded ? '收起备选' : '看备选';
    node.querySelector('.quick-preview-candidates').inert = !choice.expanded;
    return more;
  }

  function replaceAlternatives(node, choice) {
    const options = node.querySelector('[data-preview-options]');
    const previous = options.getBoundingClientRect().height;
    options.getAnimations().forEach(animation=>animation.cancel());
    options.innerHTML = optionButtons(choice);
    if (reduceMotion.matches) return;
    const height = options.getBoundingClientRect().height;
    options.animate([{height:`${previous}px`,opacity:.38},{height:`${height}px`,opacity:1}],
      {duration:210,easing:'cubic-bezier(.2,.75,.25,1)'});
  }

  function render() {
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const rowId = focused?.closest('[data-preview-row]')?.dataset.previewRow;
    const section = focused?.closest('[data-preview-kind]');
    const control = focused?.getAttributeNames().find(name=>name.startsWith('data-preview-'));
    const scrollTop = list.scrollTop;
    list.innerHTML = shown.map((group, index)=>`<section aria-label="${e(group.name)}"><h3>${e(group.name)}</h3>
      ${group.documents.length ? `<details class="quick-preview-documents"><summary>资料修订</summary><p>${group.documents.map(doc=>e(`${doc.filename}（修订 ${doc.revision}）`)).join('、')}</p></details>` : ''}
      ${Object.entries(kinds).map(([kind, label])=>{
        const rows = group.rows.filter(row=>row.kind === kind);
        return rows.length ? `<div class="quick-preview-kind" data-preview-kind="${kind}" data-group="${index}">
          <div class="quick-preview-kind-head"><h4>${label}</h4><div class="inline-actions">
            <button type="button" class="button quiet" data-preview-select-all aria-label="全选或取消${label}">全选</button>
            <button type="button" class="button outline" data-preview-refresh aria-label="换一批${label}">换一批</button>
          </div></div><ol>${rows.map(rowMarkup).join('')}</ol></div>` : '';
      }).join('')}</section>`).join('');
    updateSelection();
    list.scrollTop = scrollTop;
    if (section && control) {
      const next = list.querySelector(`[data-group="${section.dataset.group}"][data-preview-kind="${section.dataset.previewKind}"]`);
      const scope = rowId ? next?.querySelector(`[data-preview-row="${CSS.escape(rowId)}"]`) : next;
      scope?.querySelector(control === 'data-preview-select' ? '[data-preview-more]' : `[${control}]`)?.focus({preventScroll:true});
    }
  }

  function load(group, rows, count = 3, keep = []) {
    const ids = rows.map(row=>row.id);
    return group.history(async (seen,n)=>(await recommend(group.item,group.revision,ids,seen,n)).topics,ids,count,keep);
  }

  async function loadDefaults(group, rows, active = ()=>true) {
    for (let index = 0; index < rows.length; index += 8) {
      const chunk = rows.slice(index,index + 8);
      const topics = await load(group,chunk);
      if (!active()) return;
      for (const row of chunk) row.choice.setRecommended(topics[row.id]);
      if (dialog.open) render();
    }
  }

  async function withLoading(work, rowNode) {
    if (loading) return;
    const run = generation, active = ()=>run === generation;
    const status = rowNode?.querySelector('[data-preview-row-error]') || notice;
    const refresh = rowNode?.querySelector('[data-preview-alternatives]');
    const focused = rowNode?.contains(document.activeElement) ? document.activeElement : null;
    loading = true;
    status.hidden = Boolean(refresh);
    status.textContent = refresh ? '' : '正在推荐选题…';
    if (refresh) {
      refresh.setAttribute('aria-busy','true');
      refresh.textContent = '正在换题…';
    }
    updateSelection();
    try {
      await work(active);
      if (active()) {
        status.textContent = refresh ? '' : reviewMessage;
        status.hidden = !status.textContent;
      }
    } catch (error) {
      if (active()) {
        status.textContent = error.message;
        status.hidden = false;
      }
    } finally {
      if (active()) {
        loading = false;
        if (refresh) {
          refresh.removeAttribute('aria-busy');
          refresh.textContent = '换两题';
        }
        updateSelection();
        if (focused && document.activeElement === document.body) focused.focus({preventScroll:true});
      }
    }
  }

  function rememberChoices(group) {
    const rows = Object.fromEntries(group.rows
      .filter(({choice})=>choice.manual || choice.excluded || choice.alternativesEdited)
      .map(({id,choice})=>[id,{
        recommended:choice.recommended, manual:choice.manual, excluded:choice.excluded,
        options:choice.options, expanded:choice.expanded, alternativesEdited:choice.alternativesEdited,
      }]));
    if (Object.keys(rows).length) drafts.set(group.clientId,{revision:group.revision,rows});
    else drafts.delete(group.clientId);
    if (!writeBrowserDraft(draftKey,drafts.size ? Object.fromEntries(drafts) : null)) {
      reviewMessage = '当前浏览器未能保存选题取舍。';
      notice.textContent = reviewMessage;
      notice.hidden = false;
    }
  }

  function prepare(items, requestItems) {
    const requests = new Map(requestItems.map(item=>[item.client_id,item]));
    return items.map(item=>{
      const plan = item.preview;
      const previous = saved.get(item.client_id);
      if (previous?.revision === plan.revision) return previous;
      const draft = drafts.get(item.client_id);
      const restored = draft?.revision === plan.revision ? draft.rows : null;
      const rows = plan.rows.map(row=>({
        ...row, choice:Object.assign(new TopicChoice(),restored?.[row.id]),
      }));
      const known = rows.flatMap(({choice})=>[choice.recommended,choice.manual,...choice.options]).filter(Boolean);
      const group = {...plan, item:requests.get(item.client_id), clientId:item.client_id, name:item.name, rows,
        byId:new Map(rows.map(row=>[row.id,row])), history:createTopicHistory(known)};
      saved.set(item.client_id,group);
      return group;
    });
  }

  function choicesFor(groups, defaults = false) {
    return groups.map(group=>({
      clientId:group.clientId, revision:group.revision,
      rows:group.rows.filter(row=>defaults || included(row))
        .map(row=>({id:row.id,topic:defaults ? row.choice.recommended : row.choice.topic})),
    })).filter(group=>group.rows.length);
  }

  async function useDefaults(items, requestItems) {
    const groups = prepare(items,requestItems);
    for (const group of groups) await loadDefaults(group,group.rows.filter(row=>!row.choice.recommended));
    return choicesFor(groups,true);
  }

  function review(items, requestItems, message = '') {
    const outdated = items.some(item=>drafts.has(item.client_id) && drafts.get(item.client_id).revision !== item.preview.revision);
    shown = prepare(items,requestItems);
    reviewMessage = message || (outdated ? '部分客户的资料或安排已更新，请重新确认这些客户的选题。' : '');
    notice.textContent = reviewMessage;
    notice.hidden = !reviewMessage;
    render();
    confirmation = null;
    return new Promise(resolve=>{
      resolveReview = resolve;
      dialog.showModal();
      if (shown.some(group=>group.rows.some(row=>!row.choice.recommended))) void withLoading(async active=>{
        for (const group of shown) {
          if (!active()) return;
          await loadDefaults(group,group.rows.filter(row=>!row.choice.recommended),active);
        }
      });
    });
  }

  list.addEventListener('change',event=>{
    const pick = event.target.closest('[data-preview-include]');
    if (!pick) return;
    const group = shown[Number(pick.closest('[data-preview-kind]').dataset.group)];
    const row = group.byId.get(pick.closest('[data-preview-row]').dataset.previewRow);
    row.choice.excluded = !pick.checked;
    rememberChoices(group);
    pick.closest('[data-preview-row]').classList.toggle('is-excluded',!pick.checked);
    updateSelection();
  });
  list.addEventListener('click',event=>{
    const control = event.target.closest('[data-preview-refresh],[data-preview-select-all],[data-preview-more],[data-preview-select],[data-preview-alternatives]');
    if (!control || loading) return;
    const section = control.closest('[data-preview-kind]');
    const group = shown[Number(section.dataset.group)], kind = section.dataset.previewKind;
    const rows = group.rows.filter(row=>row.kind === kind);
    if (control.hasAttribute('data-preview-refresh')) {
      return void withLoading(active=>loadDefaults(group,rows.filter(canRefresh),active));
    }
    if (control.hasAttribute('data-preview-select-all')) {
      const exclude = rows.every(included);
      for (const row of rows.filter(row=>row.choice.topic)) row.choice.excluded = exclude;
      rememberChoices(group);
      render();
      return;
    }
    const node = control.closest('[data-preview-row]');
    const row = group.byId.get(node.dataset.previewRow);
    const choice = row.choice;
    if (control.hasAttribute('data-preview-select')) {
      choice.select(control.value);
      rememberChoices(group);
      node.querySelector('strong').textContent = choice.topic;
      node.querySelector('[data-preview-include]').checked = true;
      node.classList.remove('is-excluded');
      for (const option of node.querySelectorAll('[data-preview-select]')) {
        option.setAttribute('aria-pressed',String(option.value === choice.topic));
      }
      updateSelection();
      return;
    }
    if (control.hasAttribute('data-preview-more')) {
      choice.expanded = !choice.expanded;
      syncDisclosure(node,choice);
      return;
    }
    void withLoading(async active=>{
      const topics = await load(group,[row],2,[choice.topic]);
      if (active()) {
        choice.setAlternatives(topics[row.id]);
        choice.alternativesEdited = true;
        rememberChoices(group);
        replaceAlternatives(node,choice);
      }
    },node);
  });
  form.addEventListener('submit',event=>{
    event.preventDefault();
    if (start.disabled) return;
    confirmation = choicesFor(shown);
    dialog.close();
  });
  form.querySelector('[data-preview-back]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{
    generation++;
    loading = false;
    resolveReview?.(confirmation);
    resolveReview = null;
  });
  return {
    review, useDefaults,
    clear() {
      saved.clear();
      drafts.clear();
      writeBrowserDraft(draftKey,null);
    },
    close:()=>{if (dialog.open) dialog.close();},
  };
}
