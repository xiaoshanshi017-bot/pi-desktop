import type { RpcRecord } from '../shared/types';

// The pinned Pi SDK emits this exact error after an AbortController cancellation.
// Preserve the source record; only its display and lifecycle classification change.
export const SDK_ABORT_ERROR = 'This operation was aborted';

export function isCancelledMessage(message?: RpcRecord): boolean {
  return Boolean(message && (message.stopReason === 'aborted'
    || (message.role === 'assistant' && message.stopReason === 'error' && message.errorMessage === SDK_ABORT_ERROR)));
}
