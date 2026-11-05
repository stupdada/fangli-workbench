import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerClient } from '../../web/workbench/customers-client.mjs';
import { CustomerIntake, intakeDraft, renderIntake } from '../../web/workbench/customer-intake.mjs';
import { claimReviewForm, claimSearchForm, renderClaimCheck } from '../../web/workbench/customer-claim-check.mjs';

const ref = {filename:'<原件>',revision:2,quote:'<script>引用</script>',document_id:'d'};
const profile = {company:'人工公司', brand:'资料品牌'};
const result = {profile_suggestion:{company:'资料公司',brand:'资料品牌'}, profile_sources:{company:[ref],brand:[ref]},
  overview:{text:'业务概览',source_refs:[ref]}, keywords:[{text:'产品词',source_refs:[ref]}],
  important_claims:[{text:'重要说法',source_refs:[ref]}], conflicts:[{topic:'规格冲突',detail:'两种规格描述',source_refs:[ref]}]};
const record = {id:'run',status:'ready',sources:[ref],current_client:{name:'客户',profile:{company:'人工公司'}},
  proposed_client:{name:'客户',profile},result,expected_profile_version:'version',expected_adoption_id:null};

test('资料确认页面呈现原档案、来源与冲突，并安全转义正文',() => {
  const html = renderIntake(record,intakeDraft(record));
  for (const expected of ['人工公司','资料公司','规格冲突','公开来源尚未核对','确认保存','&lt;script&gt;引用']) assert.ok(html.includes(expected));
  assert.ok(!html.includes('<script>引用'));
});

test('确认保存包含人工改动和双基准；同一次结果刷新保留草稿',async () => {
  const calls = [];
  const service = new CustomerClient(async (path,method,body) => {
    calls.push({path,method,body});
    if (path.endsWith('/adopt')) return {client:record.current_client,intake:{...record,expected_adoption_id:'saved',adoption:{editorial:body.editorial}}};
    return {intake:record,reused:true};
  },{storage:null});
  const intake = new CustomerIntake(service,() => {});
  await intake.start('customer',['d']);
  intake.change('profile:company','再校订公司');
  intake.change('overview','已核对概览');
  await intake.refresh();
  assert.equal(intake.draft.profile.company,'再校订公司');
  await intake.save();
  assert.deepEqual(calls.map(c => c.path),['/api/workbench/clients/customer/intakes','/api/workbench/clients/customer/intakes/run','/api/workbench/clients/customer/intakes/run/adopt']);
  assert.equal(calls[2].body.editorial.overview.text,'已核对概览');
  assert.equal(calls[2].body.expected_profile_version,'version');
  assert.equal(calls[2].body.expected_adoption_id,null);
});

test('公开候选出处与人工证据状态分开，改动中的说法不会沿用旧结论', () => {
  const original = {text:'认证范围',claim_key:'key',source_refs:[ref]};
  const withCandidates = {...original,public_check:{status:'candidates',revision:1,query:'产品 认证',candidates:[
    {url:'https://issuer.example/cert',title:'发证机构',snippet:'<摘要>'},
    {url:'javascript:alert(1)',title:'坏链接'},
  ]}};
  const pending = renderClaimCheck(withCandidates,true);
  assert.match(pending,/待核对原文/);
  assert.doesNotMatch(pending,/已找到公开依据/);
  const form = claimReviewForm(withCandidates);
  assert.match(form,/&lt;摘要&gt;/);
  assert.doesNotMatch(form,/href="javascript:/);
  assert.match(claimSearchForm(original), /name="query"/);
  const checked = {...withCandidates,public_check:{...withCandidates.public_check,status:'conflict',evidence:{
    url:'https://issuer.example/cert',title:'发证机构',source_type:'issuer',quote:'不含该型号',subject:'产品 A',conditions:'仅限 B 型号',checked_at:'2026-11-05T00:00:00+00:00',
  }}};
  const updated = {...record,public_search_configured:true,result:{...result,important_claims:[checked]}};
  const draft = intakeDraft(updated);
  assert.match(renderIntake(updated,draft), /公开出处与说法有冲突/);
  draft.editorial.important_claims[0].text = '新的说法';
  const unsaved = renderIntake(updated,draft);
  assert.match(unsaved, /data-claim-check hidden/);
  assert.match(unsaved, /保存改动后可核对这条说法/);
  assert.match(renderClaimCheck({...original,public_check:{status:'no_result',candidates:[]}},true), /未返回出处/);
  assert.match(claimReviewForm(checked), /value="https:\/\/issuer\.example\/cert" selected/);
  const followed = {...checked,public_check:{...checked.public_check,evidence:{...checked.public_check.evidence,
    candidate_url:'https://issuer.example/cert',candidate_title:'发证机构',
    url:'https://issuer.example/data-sheet.pdf',title:'原厂技术资料',
  }}};
  assert.match(claimReviewForm(followed), /value="https:\/\/issuer\.example\/cert" selected/);
  assert.match(claimReviewForm(followed), /name="source_url"[^>]*value="https:\/\/issuer\.example\/data-sheet\.pdf"/);
  assert.match(claimReviewForm(followed), /name="source_title"[^>]*value="原厂技术资料"/);
  assert.match(renderClaimCheck(followed,true), /出处<\/dt><dd><a href="https:\/\/issuer\.example\/data-sheet\.pdf"/);
  assert.match(renderClaimCheck(followed,true), /检索入口<\/dt><dd><a href="https:\/\/issuer\.example\/cert"/);
});

test('搜索和人工证据分别提交，搜索请求只包含编辑填写的检索词',async () => {
  const calls = [];
  const service = new CustomerClient(async (path,method,body) => { calls.push({path,method,body}); return {}; },{storage:null});
  await service.searchClaim('cid','intake','key','产品 发证机构');
  await service.reviewClaim('cid','intake','key',{expected_revision:1,status:'supported'});
  assert.deepEqual(calls,[
    {path:'/api/workbench/clients/cid/intakes/intake/claims/key/search',method:'POST',body:{query:'产品 发证机构'}},
    {path:'/api/workbench/clients/cid/intakes/intake/claims/key/review',method:'POST',body:{expected_revision:1,status:'supported'}},
  ]);
});
