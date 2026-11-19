// 自動配裝的 Web Worker 進入點，避免長時間計算阻塞介面
import { optimize } from './optimizer';
import type { OptimizerInput } from './optimizer';

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<OptimizerInput>) => void) | null,
  postMessage: (message: unknown) => void,
};

scope.onmessage = e => {
  try {
    scope.postMessage({ result: optimize(e.data) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
