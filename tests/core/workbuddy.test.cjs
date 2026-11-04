'use strict';
const assert = require('node:assert/strict');
const {execute, classified} = require('../../bridge/workbuddy.cjs');

function sse(chunks, done = true) {
  return new Response(chunks.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + (done ? 'data: [DONE]\n\n' : ''),
    {headers: {'Content-Type': 'text/event-stream'}});
}

(async () => {
  const input = {model: 'deepseek-v4.1-flash', messages: [{role: 'system', content: '原生中文消息'}, {role: 'user', content: '资料与要求'}],
    temperature: 0, max_tokens: 1876, force_json: true, timeout: 1};
  let calls = 0, body;
  const events = [];
  await execute(input, event => events.push(event), async (url, options) => {
    calls++; body = JSON.parse(options.body);
    assert.ok(url.endsWith('/.cloud/llm/chat/completions'));
    assert.ok(options.headers.has('x-wb-webapp-access-key'));
    return sse([{choices: [{delta: {content: '中文'}, finish_reason: null}]},
      {choices: [{delta: {content: '结果'}, finish_reason: 'stop'}], usage: {total_tokens: 4}}]);
  });
  assert.equal(calls, 1);
  assert.deepEqual(body, {model: input.model, messages: input.messages, temperature: 0, max_tokens: 1876, stream: true, response_format: {type: 'json_object'}});
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), '中文结果');
  assert.equal(events.at(-1).type, 'done');
  for (const [finish, done, expected] of [['length', true, 'truncated'], ['stop', false, 'uncertain'], [null, true, 'uncertain'], ['content_filter', true, 'uncertain']]) {
    let error; calls = 0;
    try {await execute(input, () => {}, async () => {calls++; return sse([{choices: [{delta: {content: '不完整'}, finish_reason: finish}]}], done);});}
    catch (value) {error = value;}
    assert.ok(error, 'incomplete return cannot succeed');
    assert.equal(classified(error).kind, expected);
    assert.equal(calls, 1, 'no automatic retry');
  }
  const models = [];
  await execute({operation: 'models', timeout: 1}, value => models.push(value), async () => new Response(JSON.stringify({data: [
    {id: 'deepseek-v4.1-flash', enabled: true, capabilities: {chat: true, streaming: true}},
    {id: 'near-match-deepseek', disabled: true}, {id: 'image-only', modalities: {output: ['image']}},
  ]}), {headers: {'Content-Type': 'application/json'}}));
  assert.deepEqual(JSON.parse(JSON.stringify(models[0].models.map(m => m.id))), ['deepseek-v4.1-flash']);
  let error;
  try {await execute(input, () => {}, async () => new Response(JSON.stringify({error: {message: 'wbpk_must_not_leak', code: 'secret'}}), {status: 429}));}
  catch (value) {error = value;}
  assert.deepEqual(classified(error), {type: 'error', kind: 'rate_limited', status: 429});
  let abortCalls = 0;
  try {await execute({...input, timeout: .02}, () => {}, (url, options) => new Promise((resolve, reject) => {
    abortCalls++; options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
  })); assert.fail('abort must not count as completed');}
  catch (value) {assert.equal(classified(value).kind, 'uncertain');}
  assert.equal(abortCalls, 1);
  process.stdout.write(JSON.stringify({ok: true, sdk_fetches: 'all injected offline', external_model_calls: 0,
    exact_native_payload: true, completion_length_eof_filter_abort_checked: true, raw_error_redacted: true}) + '\n');
})().catch(error => {process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1;});
