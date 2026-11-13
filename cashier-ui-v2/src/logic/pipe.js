// FCFS 收款通道：后端在收款类指令上自动占用通道，冲突时返回 409 PIPE_BUSY。
// 这里对这类指令做自动重试，直到通道空闲或超时。
export const PIPE_RETRY_INTERVAL = 2000;
export const PIPE_RETRY_TIMEOUT = 30000;

export function pipeHolderOf(issue) {
  return issue?.data?.data?.holder || null;
}

export async function withPipeRetry(fn, onBusy, { interval = PIPE_RETRY_INTERVAL, timeout = PIPE_RETRY_TIMEOUT } = {}) {
  const startedAt = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (issue) {
      if (issue?.code !== 'PIPE_BUSY' || Date.now() - startedAt >= timeout) throw issue;
      onBusy?.(pipeHolderOf(issue));
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
