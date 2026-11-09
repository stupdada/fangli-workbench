/* finesse · design-language=apple · apple-mode=editorial */
import {canPlayPaperMotion, createPaperAnimations, observePaperMotion} from '../assets/paper-motion.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const examples = {
  ordering: {
    question: '公司下午茶怎么订？',
    title: '公司下午茶订购清单',
    facts: ['公司地址', '订餐人数', '送达时间'],
    cut: '订餐前有不少事要安排。',
    lead: '订下午茶前，把公司地址、人数和希望送达的时间发给门店。',
    details: '确认能送到，再选餐食。如果只能送到大堂，提前约好交接位置。',
    review: '把地址、人数和送达时间放在开头，负责订餐的人看完就知道要发什么给门店。',
  },
  delivery: {
    question: '下午茶能送到我们公司吗？',
    title: '公司下午茶配送怎么确认',
    facts: ['公司地址', '送达时间', '交接位置'],
    cut: '配送是订餐的重要一环。',
    lead: '把公司地址和希望送达的时间发给门店，请店员确认能不能送到。',
    details: '确认能送后，再问清送到楼层还是大堂，提前约好交接位置。',
    review: '开头直接说怎么确认配送。示例资料没有给出覆盖区域，能否送达由门店确认。',
  },
};
let example = examples.ordering;

const stepTabs = $$('[data-demo-step]');
const stepPanels = stepTabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
let activeStep = stepTabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
let stepMotion;

function finishStepMotion() {
  if (!stepMotion) return;
  const {outgoing, animations} = stepMotion;
  stepMotion = null;
  outgoing.hidden = true;
  outgoing.inert = false;
  outgoing.classList.remove('demo-panel-leaving');
  animations.forEach(animation => animation.cancel());
}

function showStep(index) {
  if (index === activeStep) return;
  finishStepMotion();
  finishPaperScene();
  reviewAnimations.stop();
  const outgoing = stepPanels[activeStep];
  const incoming = stepPanels[index];
  const direction = Math.sign(index - activeStep);
  activeStep = index;
  stepTabs.forEach((tab, tabIndex) => {
    const selected = tabIndex === index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    stepPanels[tabIndex].hidden = !selected;
  });
  if (reduced.matches || document.hidden) return;

  outgoing.classList.add('demo-panel-leaving');
  outgoing.inert = true;
  outgoing.hidden = false;
  const slide = (element, from, to, duration) => element.animate(
    [from, to], {duration, easing: 'cubic-bezier(.22,.7,.24,1)', fill: 'both'},
  );
  const moving = (distance, opacity = 1) => ({
    transform: `translateX(${direction * distance}px)`,
    opacity,
  });
  const animations = [
    slide(outgoing, moving(0), moving(-38, 0), 185),
    slide(outgoing.querySelector('.demo-panel-intro'), moving(0), moving(18), 185),
    slide(incoming.querySelector('.demo-panel-intro'), moving(-27), moving(0), 280),
    slide(incoming, moving(56, .15), moving(0), 280),
  ];
  const motion = {outgoing, animations};
  stepMotion = motion;
  animations.at(-1).finished.then(() => {
    if (stepMotion === motion) finishStepMotion();
  }, () => {});
}
reduced.addEventListener('change', finishStepMotion);

function focusInView(element) {
  element.focus({preventScroll: true});
  element.scrollIntoView({behavior: 'instant', block: 'nearest'});
}

stepTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => showStep(index));
  tab.addEventListener('keydown', event => {
    const count = stepTabs.length;
    const positions = {
      ArrowLeft: (index - 1 + count) % count,
      ArrowRight: (index + 1) % count,
      Home: 0,
      End: count - 1,
    };
    if (!Object.hasOwn(positions, event.key)) return;
    event.preventDefault();
    const next = positions[event.key];
    showStep(next);
    stepTabs[next].focus();
  });
});
$$('[data-next-step]').forEach(button => button.addEventListener('click', () => {
  const index = stepTabs.findIndex(tab => tab.dataset.demoStep === button.dataset.nextStep);
  showStep(index);
  focusInView(stepPanels[index].querySelector('.demo-heading'));
}));

const paperAnimations = createPaperAnimations();
const generationResult = $('#demo-generation-result');
const generationCount = $('#demo-generation-count');
const replayGeneration = $('#replay-generation');
function finishPaperScene() {
  paperAnimations.stop();
  if (generationResult.textContent === '稿件已就绪') return;
  generationResult.textContent = '稿件已就绪';
  generationCount.textContent = '已保存 1 / 1 篇';
}

function playPaperScene() {
  finishPaperScene();
  if (!canPlayPaperMotion()) return;
  generationResult.textContent = '正在从资料里找信息';
  generationCount.textContent = '成稿演示';
  const arrive = (node, transform, delay, duration) => paperAnimations.play(
    node,
    [{transform, opacity: 0}, {transform: 'none', opacity: 1}],
    {duration, delay, fill: 'backwards', easing: 'cubic-bezier(.16,1,.3,1)'},
  );
  arrive($('#demo-flow-source'), 'translateY(22px) rotate(-5deg)', 0, 420);
  $$('#demo-flow-facts mark').forEach((fact, index) => {
    arrive(fact, 'translateX(-9px)', 230 + index * 100, 280);
  });
  const question = arrive($('#demo-flow-question'), 'translateX(-20px) scale(.95)', 590, 410);
  question?.finished.then(() => {
    generationResult.textContent = '正在整理稿件开头';
  }, () => {});
  arrive($('#demo-flow-draft'), 'translateY(22px) rotate(3deg)', 970, 470);
  const opening = arrive($('#demo-flow-opening'), 'translateY(10px)', 1220, 440);
  if (opening) opening.finished.then(finishPaperScene, () => {});
  else finishPaperScene();
}
function syncPaperMotion() {
  const canPlay = canPlayPaperMotion();
  replayGeneration.hidden = !canPlay;
  $('#replay-review').hidden = !canPlay;
  if (!canPlay) {
    finishPaperScene();
    reviewAnimations.stop();
  }
}
replayGeneration.addEventListener('click', () => {
  playPaperScene();
  focusInView(generationResult);
});

$('#demo-confirm-topic').addEventListener('click', () => {
  example = examples[$('input[name="demo-topic"]:checked').value];
  renderExample();
  $('#demo-topic').hidden = true;
  $('#demo-generated').hidden = false;
  $('#demo-start-label').textContent = '查看生成结果';
  playPaperScene();
  focusInView(generationResult);
});

const draft = $('#demo-article');
const draftBody = $('#demo-article-body');
const draftStatus = $('#demo-draft-status');
const candidateBody = $('#demo-candidate-body');
const editForm = $('#demo-edit-form');
const editBody = $('#demo-edit-body');
const editButton = $('#demo-edit-button');
const review = $('#demo-review');
const reviewButton = $('#demo-review-button');
const adoptButton = $('#demo-adopt');
const reviewCut = $('#demo-review-cut');
const reviewNote = $('#demo-review-note');
const reviewAnimations = createPaperAnimations();

function setDraftPane(pane) {
  draft.hidden = pane !== draft;
  editForm.hidden = pane !== editForm;
  review.hidden = pane !== review;
  editButton.setAttribute('aria-expanded', String(pane === editForm));
  reviewButton.setAttribute('aria-expanded', String(pane === review));
  reviewAnimations.stop();
}

function replayReview() {
  if (review.hidden) return;
  reviewAnimations.stop();
  if (!reviewCut.hidden) {
    reviewAnimations.play(reviewCut.querySelector('i'), [
      {transform: 'scaleX(0)'}, {transform: 'scaleX(1)'},
    ], {duration: 360, fill: 'backwards', easing: 'ease-out'});
  }
  reviewAnimations.play(review.querySelector('.review-after'), [
    {transform: 'translateY(14px)', opacity: .25}, {transform: 'none', opacity: 1},
  ], {duration: 410, delay: 160, fill: 'backwards', easing: 'ease-out'});
}
$('#replay-review').addEventListener('click', replayReview);
syncPaperMotion();
observePaperMotion(syncPaperMotion);

function setDraftVersion(text, label) {
  draftBody.textContent = text;
  draftStatus.textContent = `当前采用版 · ${label}`;
  $('#demo-receipt').textContent = '';
  setDraftPane(draft);
}

function renderExample() {
  $('#demo-flow-topic').textContent = example.question;
  $('#demo-flow-title').textContent = example.title;
  $('#demo-flow-cut').textContent = example.cut;
  $('#demo-flow-lead').textContent = example.lead;
  $('#demo-flow-facts').replaceChildren(...example.facts.map(text => {
    const row = document.createElement('li');
    const mark = document.createElement('mark');
    mark.textContent = text;
    row.append(mark);
    return row;
  }));
  $('#demo-article-title').textContent = example.title;
  candidateBody.textContent = example.lead + example.details;
  setDraftVersion(example.cut + candidateBody.textContent, '示例成稿');
}
renderExample();

editButton.addEventListener('click', () => {
  if (!editForm.hidden) {
    setDraftPane(draft);
    return;
  }
  editBody.value = draftBody.textContent;
  editBody.setCustomValidity('');
  setDraftPane(editForm);
  focusInView(editBody);
});
$('#demo-close-editor').addEventListener('click', () => {
  setDraftPane(draft);
  focusInView(editButton);
});
editBody.addEventListener('input', () => editBody.setCustomValidity(''));
editForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = editBody.value.trim();
  if (!text) {
    editBody.setCustomValidity('请填写正文');
    editBody.reportValidity();
    return;
  }
  setDraftVersion(text, '人工编辑版');
  focusInView(editButton);
});

reviewButton.addEventListener('click', () => {
  if (!review.hidden) {
    setDraftPane(draft);
    return;
  }
  const current = draftBody.textContent;
  const hasCut = current.startsWith(example.cut);
  const alreadyAdopted = current === candidateBody.textContent;
  reviewCut.hidden = !hasCut;
  reviewCut.querySelector('span').textContent = hasCut ? example.cut : '';
  $('#demo-compare-base').textContent = hasCut ? current.slice(example.cut.length) : current;
  reviewNote.textContent = hasCut ? example.review : '采用前，核对候选稿是否保留了你需要的内容。';
  reviewNote.hidden = alreadyAdopted;
  adoptButton.disabled = alreadyAdopted;
  adoptButton.textContent = alreadyAdopted ? '与当前采用版相同' : '采用此版并用于导出';
  setDraftPane(review);
  replayReview();
});
adoptButton.addEventListener('click', () => {
  setDraftVersion(candidateBody.textContent, '已采用修改候选');
  focusInView(reviewButton);
});

const exportDialog = $('#demo-export');
const exportButton = $('#demo-open-export');
const exportSelection = $('#demo-export-selection');
exportButton.addEventListener('click', () => {
  $('#demo-export-name').textContent = example.title;
  $('#demo-export-version').textContent = draftStatus.textContent;
  exportSelection.checked = true;
  exportDialog.showModal();
});
$('#demo-close-export').addEventListener('click', () => exportDialog.close());
$('#demo-export-form').addEventListener('submit', event => {
  event.preventDefault();
  const title = $('#demo-article-title').textContent;
  const file = new Blob([`# ${title}\n\n${draftBody.textContent}\n`], {type: 'text/markdown;charset=utf-8'});
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `示例-${title}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  exportDialog.close();
  $('#demo-receipt').textContent = '已发起下载。示例文件使用当前采用版。';
});

const sceneObserver = new IntersectionObserver(entries => {
  for (const {target, isIntersecting} of entries) {
    if (!isIntersecting) continue;
    sceneObserver.unobserve(target);
    if (!reduced.matches) target.classList.add('scene-arrival');
  }
}, {threshold: .15});
$$('.customer-stage, .demo-workbench, .chat-sample')
  .forEach(scene => sceneObserver.observe(scene));

const chapters = $$('[data-chapter]');
const observer = new IntersectionObserver(entries => {
  const entry = entries.find(item => item.isIntersecting);
  if (!entry) return;
  chapters.forEach(link => {
    if (link.dataset.chapter === entry.target.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}, {rootMargin: '-25% 0px -74% 0px'});
chapters.forEach(link => observer.observe(document.getElementById(link.dataset.chapter)));

addEventListener('pagehide', () => {
  finishStepMotion();
  finishPaperScene();
  reviewAnimations.stop();
});
