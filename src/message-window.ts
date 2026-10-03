/** History stays in memory; only this bounded page is mounted as rich text. */
export const MESSAGE_PAGE_SIZE = 40;

export interface MessageWindow {
  start: number;
  end: number;
  total: number;
  limit: number;
  isLatest: boolean;
  older: number | null;
  newer: number | null;
}

/** null follows the newest messages, while an older page keeps its own index. */
export function messageWindow(total: number, start: number | null = null, pageSize = MESSAGE_PAGE_SIZE): MessageWindow {
  const count = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
  const limit = Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : MESSAGE_PAGE_SIZE);
  const latestStart = Math.max(0, count - limit);
  const first = start === null ? latestStart : Math.min(latestStart, Math.max(0, Number.isFinite(start) ? Math.floor(start) : 0));
  const end = Math.min(count, first + limit);
  return {
    start: first, end, total: count, limit, isLatest: end === count,
    older: first > 0 ? Math.max(0, first - limit) : null,
    newer: end < count ? Math.min(latestStart, first + limit) : null,
  };
}
