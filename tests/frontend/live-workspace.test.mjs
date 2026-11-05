import test from 'node:test';
import assert from 'node:assert/strict';
import {partialObject,streamDocument,remainingCount,activity} from '../../web/workbench/live-model.mjs';
import {markdown} from '../../web/workbench/model.mjs';
import {liveMarkup} from '../../web/workbench/live-workspace.mjs';

test('结构化JSON所有截断位置均可安全预览，正确解码转义并保留章节顺序',()=>{
  const data={title:'含"引号"的标题',summary:'摘要\n换行与\\路径',sections:[{heading:'条件',paragraphs:['**正文**\n\n- 第一项','中文\u2028字符']}],key_facts:['事实'],faq:[{q:'怎么用？',a:'按资料。'}],tags:['不混入正文']};
  const raw=JSON.stringify(data);
  for(let cut=1;cut<=raw.length;cut++){
    const value=partialObject(raw.slice(0,cut));assert.ok(value&&typeof value==='object',`cut ${cut}`);
    const doc=streamDocument(raw.slice(0,cut));assert.equal(typeof doc.body,'string');assert.ok(!doc.body.includes('"paragraphs":'));
  }
  assert.deepEqual(partialObject(raw),data);
  assert.deepEqual(streamDocument(raw),{title:data.title,body:'摘要\n换行与\\路径\n\n## 条件\n\n**正文**\n\n- 第一项\n\n中文\u2028字符\n\n## 关键信息\n\n- 事实\n\n## 常见问题\n\n### 怎么用？\n\n按资料。'});
  assert.equal(streamDocument('{"title":"标题","body_md":"# 正文\\n\\n- 条目').body,'# 正文\n\n- 条目');
  assert.equal(streamDocument('## 普通Markdown\n正文').body,'## 普通Markdown\n正文');
  assert.equal(streamDocument('{"title":"未完整转义\\u12').title,'未完整转义');
});
test('Markdown表格、嵌套列表、链接和引用正确排版，HTML与危险协议不可执行',()=>{
  const html=markdown('| 条件 | 说明 |\n| --- | --- |\n| A | **依据** |\n\n- 外层\n  - 内层\n\n> 引用\n\n[资料](https://example.com)\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))');
  for(const tag of ['table','strong','ul','blockquote'])assert.ok(html.includes('<'+tag));
  assert.equal((html.match(/<ul>/g)||[]).length,2);assert.ok(html.includes('href="https://example.com"'));
  assert.ok(!html.includes('<script'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('&lt;script&gt;'));
});
test('真实活动与终态：核查、取消收尾、访谈、错误不能伪装仍在写作',()=>{
  assert.equal(activity({job:{id:'job',status:'running'},stream:{phase:'audit'}}).label,'正在对照客户资料核查');
  assert.equal(activity({job:{id:'job',status:'running',cancel:true}}).label,'正在收尾，之后暂停');
  assert.equal(activity({operations:[{id:'op',kind:'interview',status:'running'}]}).label,'正在整理本次要求');
  for(const status of ['done','error','interrupted','stopped','paused'])assert.equal(activity({job:{id:'job',status}}).active,false);
});
test('全部完成隐藏继续/下一篇；部分完成保留剩余入口，未保存流不计完成',()=>{
  const state={conversation:{id:'fixture'},options:{selections:[{platform_id:1,account_type:'official',count:2}]},operations:[],stream:{text:'{"body_md":"流式稿"}'},job:{id:'job',status:'done',done:2,planned:2},articles:[{id:1,platform_id:1,account_type:'official',current_version:1,title:'第一篇',body_md:'已保存正文'},{id:2,platform_id:1,account_type:'official',current_version:2,title:'第二篇',body_md:'核查后的正文'}]};
  const button=(action,label)=>`<button data-action="${action}">${label}</button>`;
  assert.equal(remainingCount(state),0);const html=liveMarkup(state,[],button);
  assert.ok(!html.includes('data-action="start"'));assert.ok(!html.includes('data-action="write-one"'));assert.ok(html.includes('核查后的正文'));
  state.articles.pop();assert.equal(remainingCount(state),1);assert.ok(liveMarkup(state,[],button).includes('继续剩余安排'));
  state.articles.push({id:2,current_version:null,locked:true});assert.equal(remainingCount(state),1);
  state.articles[0].locked=true;assert.equal(remainingCount(state),1,'修改锁不释放已占篇数');
  state.options.selections=[{platform_id:2,account_type:'official',count:1}];assert.equal(remainingCount(state),1,'旧平台成稿不占新平台配额');
  state.options.selections=[{platform_id:1,account_type:'personal',count:1}];assert.equal(remainingCount(state),1,'官方稿不占个人号配额');
});
