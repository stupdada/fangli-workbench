/* finesse · design-language=apple · apple-mode=editorial */
(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const directions = [
    ['围绕人数、送达时间和餐食搭配，介绍企业下午茶的选择方法。', ['企业下午茶', '下午茶搭配']],
    ['说明配送前需要确认的地址与时间，服务范围以客户资料为准。', ['下午茶配送', '配送范围']],
    ['围绕人数、份量和提前沟通的事项，整理团队订购时要问的问题。', ['团队下午茶', '团体订购']]
  ];
  $$('[data-question]').forEach(button => button.addEventListener('click', () => {
    $$('[data-question]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
    const [direction, keywords] = directions[Number(button.dataset.question)];
    $('#question-direction').textContent = direction;
    $('#question-keywords').replaceChildren(...keywords.map(text => { const tag = document.createElement('span'); tag.textContent = text; return tag; }));
    if (window.gsap && !reduced.matches) gsap.fromTo('.question-answer', {y: 10, opacity: .35}, {y: 0, opacity: 1, duration: .38, overwrite: true});
  }));

  function selectMode(mode, focus = false) {
    $$('[data-demo-mode]').forEach(button => {
      const selected = button.dataset.demoMode === mode;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    $('#demo-chat').hidden = mode !== 'chat'; $('#demo-steps').hidden = mode !== 'steps';
    if (window.ScrollTrigger) ScrollTrigger.refresh();
  }
  $$('[data-demo-mode]').forEach(button => {
    button.addEventListener('click', () => selectMode(button.dataset.demoMode));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); selectMode(event.key === 'Home' ? 'chat' : event.key === 'End' ? 'steps' : button.dataset.demoMode === 'chat' ? 'steps' : 'chat', true);
    });
  });

  let writingTimer;
  const output = $('#demo-output'), play = $('#play-writing');
  play.addEventListener('click', () => {
    clearTimeout(writingTimer); output.hidden = false;
    $('#play-status').textContent = '本页播放示例，不调用模型';
    $('#output-status').textContent = '示例稿 · 已生成'; play.textContent = '重看演示 ↗';
    if (window.gsap && !reduced.matches) {
      gsap.killTweensOf('#demo-output > *');
      gsap.fromTo('#demo-output > *', {y: 12, opacity: 0}, {y: 0, opacity: 1, stagger: .12, duration: .55, clearProps: 'transform,opacity'});
    }
    writingTimer = setTimeout(() => { if (window.ScrollTrigger) ScrollTrigger.refresh(); }, 20);
    output.scrollIntoView({behavior: reduced.matches ? 'instant' : 'smooth', block: 'nearest'});
  });
  $('#close-output').addEventListener('click', () => { clearTimeout(writingTimer); output.hidden = true; $('#play-status').textContent = '看看生成后怎么阅读稿件'; play.focus(); if (window.ScrollTrigger) ScrollTrigger.refresh(); });

  let reviewTimeline;
  function replayReview() {
    if (!window.gsap || reduced.matches) return;
    reviewTimeline?.kill();
    reviewTimeline = gsap.timeline({defaults: {ease: 'power2.out'}})
      .fromTo('.review-before', {opacity: 1}, {opacity: .55, duration: .65})
      .fromTo('.review-after', {y: 18, opacity: 0}, {y: 0, opacity: 1, duration: .8}, .35)
      .fromTo('.review-explanation', {y: 9, opacity: 0}, {y: 0, opacity: 1, duration: .55}, .8);
  }
  $('#replay-review').addEventListener('click', replayReview);

  const chapters = $$('[data-chapter]');
  const observer = new IntersectionObserver(entries => {
    const entry = entries.filter(item => item.isIntersecting).sort((a,b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!entry) return;
    chapters.forEach(link => { const active = link.dataset.chapter === entry.target.id; link.classList.toggle('active', active); if(active)link.setAttribute('aria-current', 'step');else link.removeAttribute('aria-current'); });
  }, {rootMargin: '-20% 0px -45% 0px', threshold: [0, .1, .3]});
  chapters.forEach(link => observer.observe(document.getElementById(link.dataset.chapter)));
  chapters[0].classList.add('active');

  function initMotion() {
    if (!window.gsap || !window.ScrollTrigger) return;
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add({desktop: '(min-width: 761px)', reduced: '(prefers-reduced-motion: reduce)'}, context => {
      const {desktop, reduced: quiet} = context.conditions;
      gsap.to('.reading-progress', {scaleX: 1, ease: 'none', scrollTrigger: {trigger: document.documentElement, start: 'top top', end: 'max', scrub: true}});
      if (quiet) return;
      gsap.timeline({defaults:{ease:'power3.out'}})
        .from('.hero-copy > *', {y: 24, opacity: 0, stagger: .1, duration: .9}, 0)
        .from('.hero-sheet', {y: '+=90', rotation: 0, opacity: 0, stagger: .12, duration: 1.2}, .18)
        .from('.orbit', {scale: .8, opacity: 0, stagger: .1, duration: 1.2}, .2);
      gsap.to('.hero-stage', {y: -35, rotationX: 6, ease:'none', scrollTrigger:{trigger:'.hero',start:'top top',end:'bottom top',scrub: .8}});
      $$('.reveal').forEach(element => gsap.from(element, {y: 35, opacity: .15, duration: .9, ease: 'power3.out', scrollTrigger: {trigger:element,start:'top 88%',once:true}}));
      gsap.timeline({scrollTrigger: {trigger: '.customer-stage', start: 'top 85%', end: 'center 50%', scrub: .6}})
        .from('.document-row', {x: 50, opacity: .2, stagger: .18, ease:'none'})
        .from('.customer-identity .check-disc', {scale: .3, opacity: 0, ease:'back.out(1.5)'}, .25);
      gsap.timeline({scrollTrigger: {trigger: '.question-lab', start: 'top 86%', end: 'bottom 65%', scrub: .65}})
        .from('.branch-lines', {scaleY: 0, transformOrigin: 'top', ease:'none'})
        .from('.question-choice', {y: 30, opacity: .15, stagger: .15, ease:'none'}, .3);
      if (desktop) {
        gsap.from('.demo-workbench', {rotationY: -5, rotationX: 3, y: 40, transformPerspective: 1200, ease:'none', scrollTrigger:{trigger:'.writing-layout',start:'top 90%',end:'top 38%',scrub:.8}});
        $$('.instruction').forEach(item => gsap.from(item, {opacity: .3, x: -14, duration: .7, scrollTrigger:{trigger:item,start:'top 75%',once:true}}));
      }
      ScrollTrigger.create({trigger:'.review-stage',start:'top 75%',once:true,onEnter:replayReview});
      gsap.from('.reuse-strip > div', {y: 30, scale:.96, opacity: .2, stagger: .15, duration: .8, ease:'power3.out',scrollTrigger:{trigger:'.reuse-strip',start:'top 85%',once:true}});
      gsap.from('.closing-mark', {rotation:-20,scale:.7,opacity:.2,duration:.9,ease:'back.out(1.3)',scrollTrigger:{trigger:'.closing',start:'top 85%',once:true}});
    });
    document.fonts.ready.then(() => ScrollTrigger.refresh());
    reduced.addEventListener('change', () => { reviewTimeline?.kill(); gsap.set('.review-before,.review-after,.review-explanation', {clearProps:'transform,opacity'}); });
  }
  initMotion();
  addEventListener('pagehide', () => { clearTimeout(writingTimer); reviewTimeline?.kill(); observer.disconnect(); });
})();
