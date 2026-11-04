'use strict';
const assert = require('node:assert/strict');
const {diagnostic} = require('../../bridge/workbuddy.cjs');
const result = diagnostic({message: 'Rejected token wbpk_example_secret at https://private.invalid/path; Bearer abc-secret',
  error: {code: 'unsupported_parameter', param: 'max_tokens'}, requestId: 'request-123'});
assert.equal(result.code, 'unsupported_parameter');
assert.equal(result.param, 'max_tokens');
assert.equal(result.request_id, 'request-123');
assert.ok(!result.message.includes('wbpk_') && !result.message.includes('abc-secret') && !result.message.includes('private.invalid'));
process.stdout.write(JSON.stringify({ok: true, check: 'private upstream diagnostic preserves safe reason and removes credentials/URLs', network_calls: 0}) + '\n');
