import { escapeHTML as e } from './model.mjs';
import { createTopicHistory, TopicChoice } from './topic-recommendation.mjs';

export function chooseArticleTopic(recommend, {submitLabel = '按此选题写作', expanded = false, currentTopic = ''} = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'topic-choice-dialog classic-dialog';
  dialog.setAttribute('aria-labelledby','topic-choice-title');
  dialog.innerHTML = `<form>
    <header class="dialog-head"><h2 id="topic-choice-title">选择本次文章选题</h2></header>
    <div class="topic-choice-body">
      <p data-topic-status role="status"></p>
      <div class="topic-choice-current"><strong data-topic-current></strong>
        <button type="button" class="button quiet" data-topic-more aria-expanded="false" hidden>看备选</button>
      </div>
      <div data-topic-options hidden></div>
    </div>
    <footer class="dialog-actions actions">
      <button type="button" class="button quiet" data-topic-cancel>取消</button>
      <button type="button" class="button outline" data-topic-refresh>换一批</button>
      <button type="submit" class="button primary" disabled>${e(submitLabel)}</button>
    </footer>
  </form>`;
  const form = dialog.querySelector('form');
  const status = dialog.querySelector('[data-topic-status]');
  const current = dialog.querySelector('[data-topic-current]');
  const options = dialog.querySelector('[data-topic-options]');
  const refresh = dialog.querySelector('[data-topic-refresh]');
  const more = dialog.querySelector('[data-topic-more]');
  const submit = dialog.querySelector('[type=submit]');
  const history = createTopicHistory();
  const choice = new TopicChoice();
  choice.expanded = expanded;
  if (currentTopic) choice.select(currentTopic);
  let chosen = null, loading = false;

  function render() {
    current.textContent = choice.topic;
    more.hidden = !choice.topic;
    more.setAttribute('aria-expanded',String(choice.expanded));
    more.textContent = choice.expanded ? '收起备选' : '看备选';
    options.hidden = !choice.expanded;
    options.innerHTML = choice.options.map(topic=>`<button type="button" class="button quiet topic-choice-row" value="${e(topic)}" aria-pressed="${choice.topic === topic}" ${loading ? 'disabled' : ''}>${e(topic)}</button>`).join('');
    more.disabled = refresh.disabled = loading;
    submit.disabled = loading || !choice.topic;
  }

  async function load(count = 3) {
    loading = true;
    status.textContent = '正在推荐选题…';
    render();
    try {
      const topics = await history(recommend,['1'],count,[choice.topic]);
      if (!dialog.open) return;
      if (count === 3) choice.setRecommended(topics['1']);
      else choice.setAlternatives(topics['1']);
      status.textContent = '';
    } catch (error) {
      if (dialog.open) status.textContent = error.message;
    } finally {
      loading = false;
      if (dialog.open) render();
    }
  }

  refresh.addEventListener('click',()=>{
    if (choice.manual) choice.expanded = true;
    void load(choice.manual ? 2 : 3);
  });
  more.addEventListener('click',()=>{
    choice.expanded = !choice.expanded;
    render();
  });
  options.addEventListener('click',event=>{
    const button = event.target.closest('button'), topic = button?.value;
    if (!topic || loading) return;
    choice.select(topic);
    current.textContent = choice.topic;
    for (const option of options.querySelectorAll('button')) option.setAttribute('aria-pressed',String(option === button));
  });
  dialog.querySelector('[data-topic-cancel]').addEventListener('click',()=>dialog.close());
  form.addEventListener('submit',event=>{
    event.preventDefault();
    if (submit.disabled) return;
    chosen = choice.topic;
    dialog.close();
  });
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>{ dialog.remove(); resolve(chosen); },{once:true});
    document.body.append(dialog);
    dialog.showModal();
    void load(currentTopic ? 2 : 3);
  });
}
