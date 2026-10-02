import type { RpcRecord } from '../shared/types';

export function textContent(message: RpcRecord | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).filter((part: RpcRecord) => part.type === 'text').map((part: RpcRecord) => part.text).join('\n');
}

/** Pi 0.84 streams indexed deltas; completed message snapshots remain authoritative. */
export function applyMessageEvent(messages: RpcRecord[], event: RpcRecord): RpcRecord[] {
  if (event.type === 'message_start') {
    const message = event.message;
    if (!message) return messages;
    return [...messages, { ...message, _streaming: true }];
  }
  if (event.type === 'message_update' || event.type === 'message_end') {
    const next = [...messages];
    let index = next.findLastIndex(message => message._streaming && (!event.message || message.role === event.message.role));
    if (index < 0 && event.type === 'message_end' && event.message) {
      // Some extensions emit completed messages directly, without message_start.
      index = next.findLastIndex(message => message.role === event.message.role && message.timestamp && message.timestamp === event.message.timestamp && message.toolCallId === event.message.toolCallId);
    }
    if (event.message) {
      const message = { ...event.message, _streaming: event.type !== 'message_end' };
      if (index < 0) next.push(message); else next[index] = message;
      return next;
    }
    const delta = event.assistantMessageEvent;
    if (index < 0 || !delta) return messages;
    const message: RpcRecord = { ...next[index], content: [...(next[index].content || [])] };
    const contentIndex = delta.contentIndex;
    if (typeof contentIndex !== 'number') return messages;
    const part = { ...(message.content[contentIndex] || {}) };
    if (delta.type === 'text_start') Object.assign(part, { type: 'text', text: '' });
    if (delta.type === 'thinking_start') Object.assign(part, { type: 'thinking', thinking: '' });
    if (delta.type === 'text_delta') Object.assign(part, { type: 'text', text: (part.text || '') + delta.delta });
    if (delta.type === 'thinking_delta') Object.assign(part, { type: 'thinking', thinking: (part.thinking || '') + delta.delta });
    if (delta.type === 'text_end' && typeof delta.content === 'string') Object.assign(part, { type: 'text', text: delta.content });
    if (delta.type === 'thinking_end' && typeof delta.content === 'string') Object.assign(part, { type: 'thinking', thinking: delta.content });
    if (delta.type === 'toolcall_start') Object.assign(part, { type: 'toolCall', _arguments: '' });
    if (delta.type === 'toolcall_delta') Object.assign(part, { type: 'toolCall', _arguments: (part._arguments || '') + delta.delta });
    if (delta.type === 'toolcall_end' && delta.toolCall) Object.assign(part, delta.toolCall);
    message.content[contentIndex] = part;
    if (event.usage) message.usage = event.usage;
    next[index] = message;
    return next;
  }
  return messages;
}

export const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
export const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
export const compactNumber = (number = 0) => number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : number.toLocaleString();
