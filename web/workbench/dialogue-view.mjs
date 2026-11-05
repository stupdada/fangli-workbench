import {escapeHTML as e, markdown, OPERATION_KIND, running} from './model.mjs';

export function liveReplyMarkup(state, pending = false) {
  const op = (state.operations || []).filter(row=>row.kind===OPERATION_KIND.chat&&row.conversation_id===state.conversation?.id)
    .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0];
  if (!op || op.conversation_id !== state.conversation?.id) return '';
  const done=op.status==='done';
  if(done&&state.conversation.messages?.some(message=>message.role==='assistant'&&message.content?.operation_id===op.id))return '';
  const active = running(op), result = op.result || {};
  const text = typeof result.understanding === 'string' ? result.understanding : '';
  if (!active && !done && (pending || !result.partial || !text)) return '';
  const streaming = active && !result.reply_complete && !op.stream_disconnected;
  const status = op.stream_disconnected ? '连接中断，回复状态待确认' : active || done ? '' : '回复未完成';
  return `<div data-key="reply-${e(op.id)}" class="message assistant ${streaming?'is-streaming':''}"><span class="message-label">方立${status?` <span class="reply-state">${e(status)}</span>`:''}</span><div class="rendered-copy message-copy">${markdown(text)}</div>${active?`<button type="button" class="text-button reply-stop" data-stop-operation="${e(op.id)}">停止回复</button>`:''}</div>`;
}
