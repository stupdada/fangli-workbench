import test from 'node:test';
import assert from 'node:assert/strict';
import { selfCheck } from '../../web/workbench/model.mjs';

test('具体检查项读取原 ZIP geo 逐项结果：通过项、未通过项与提示', () => {
  const check = selfCheck({geo: {score: 85, chars: 1234, checks: [
    {name: '标题含核心关键词', ok: true, hint: ''},
    {name: '关键信息独立成段', ok: false, hint: '把数字、参数、对比差异单独列出来，至少 3 条'},
  ]}});
  assert.equal(check.total, 2);
  assert.equal(check.chars, 1234);
  assert.equal(check.rated, true);
  assert.equal(check.failed.length, 1);
  assert.equal(check.failed[0].name, '关键信息独立成段');
  assert.equal(check.failed[0].hint, '把数字、参数、对比差异单独列出来，至少 3 条');
});

test('不展示总分：geo.score 不进入视图模型', () => {
  const check = selfCheck({geo: {score: 92, checks: [{name: '篇幅达标', ok: true}]}});
  assert.equal('score' in check, false);
  assert.equal('tone' in check, false);
  // 只有总分、没有逐项时不出视图，避免用一个不稳定的汇总分代替检查项。
  assert.equal(selfCheck({geo: {score: 92}}).rated, false);
});

test('缺少 geo 时不伪造检查结果', () => {
  for (const article of [undefined, {}, {geo: {}}, {geo: null}, {geo: {checks: []}}]) {
    const check = selfCheck(article);
    assert.equal(check.rated, false);
    assert.deepEqual(check.checks, []);
    assert.deepEqual(check.failed, []);
    assert.equal(check.total, 0);
    assert.equal(check.chars, 0);
  }
});
