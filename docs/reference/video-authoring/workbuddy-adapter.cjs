'use strict';
const { MODEL } = require('./content-creator.cjs');
// Cloud/auth/model-directory ownership stays with the production bridge.
function createWorkBuddyCallModel({ cloud, modelCall, releaseStreams } = {}) {
  if (!cloud || typeof modelCall !== 'function') throw new TypeError('需要既有WorkBuddy cloud与单次流调用工具');
  return async function callModel(request, { signal } = {}) {
    if (request.model !== MODEL) throw new TypeError('创作模型必须为deepseek-v4.1-flash');
    let text = '', finishReason = '', usage = null;
    try {
      for await (const chunk of modelCall(cloud, { model: MODEL, messages: request.messages, stream: true }, { signal, releaseStreams })) {
        const choice = chunk.choices?.[0];
        if (choice?.delta?.refusal || choice?.delta?.tool_calls?.length) { const error = new Error('返回协议无效'); error.code = 'MODEL_PROTOCOL'; throw error; }
        text += choice?.delta?.content || '';
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
      return { model: MODEL, text, finishReason, usage };
    } catch (error) {
      // Expose only a bounded protocol category and partial content, never provider error details.
      const safe = new Error('模型单次流调用未完成');
      safe.name = error?.name === 'AbortError' ? 'AbortError' : 'Error';
      safe.code = error?.code === 'MODEL_PROTOCOL' ? 'MODEL_PROTOCOL' : 'MODEL_CALL_FAILED';
      safe.responseText = text; safe.usage = usage;
      throw safe;
    }
  };
}
module.exports = { createWorkBuddyCallModel };
