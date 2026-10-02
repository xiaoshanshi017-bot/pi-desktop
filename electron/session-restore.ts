import { stat } from 'node:fs/promises';
import { readSessionInfo } from './storage';

/** Missing saved sessions may be replaced; existing invalid sessions need review. */
export async function resolveSessionRestore(project: string, sessionPath?: string): Promise<{ sessionPath?: string; missing: boolean }> {
  if (!sessionPath) return { missing: false };
  try {
    if (!(await stat(sessionPath)).isFile()) throw new Error('会话路径不是文件。');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { missing: true };
    throw error;
  }
  if (!(await readSessionInfo(sessionPath, project))) throw new Error('会话无效，或会话所属项目与当前项目不同。');
  return { sessionPath, missing: false };
}
