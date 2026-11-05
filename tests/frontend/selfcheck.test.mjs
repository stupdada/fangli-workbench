import test from 'node:test';
import assert from 'node:assert/strict';
import { selfCheck } from '../../web/workbench/model.mjs';

test('发布前自检读取原 ZIP geo 结果：总分、逐项与未通过提示', () => {
  const check = selfCheck({geo: {score: 84.6, chars: 1234, checks: [
    {name: '标题含核心关键词', ok: true, hint: ''},
    {name: '关键信息独立成段', ok: false, hint: '把数字、参数、对比差异单独列出来，至少 3 条'},
  ]}});
  assert.equal(check.score, 85);
  assert.equal(check.total, 2);
  assert.equal(check.failed.length, 1);
  assert.equal(check.failed[0].name, '关键信息独立成段');
  assert.equal(check.failed[0].hint, '把数字、参数、对比差异单独列出来，至少 3 条');
  assert.equal(check.tone, 'mid');
  assert.equal(check.chars, 1234);
});

test('缺少 geo 时不伪造自检结果，分数档位与导出筛选一致', () => {
  for (const article of [undefined, {}, {geo: {}}, {geo: null}, {geo: {checks: []}}]) {
    const check = selfCheck(article);
    assert.equal(check.rated, false);
    assert.equal(check.score, null);
    assert.deepEqual(check.checks, []);
    assert.equal(check.tone, 'none');
  }
  assert.equal(selfCheck({geo: {score: 96}}).tone, 'good');
  assert.equal(selfCheck({geo: {score: 85}}).tone, 'mid');
  assert.equal(selfCheck({geo: {score: 61}}).tone, 'bad');
  // 只有 checks 没有总分时仍可展示逐项，但不得编造分数。
  const partial = selfCheck({geo: {checks: [{name: '篇幅达标', ok: true}]}});
  assert.equal(partial.score, null);
  assert.equal(partial.rated, true);
});
