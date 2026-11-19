// 生產／採集職業魔晶石最佳化的 Web Worker 進入點，避免目標接近上限時的計算阻塞介面
import { optimizeMateriaTarget } from './materiaTarget';
import type { MateriaTargetInput } from './materiaTarget';

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<MateriaTargetInput>) => void) | null,
  postMessage: (message: unknown) => void,
};

scope.onmessage = e => {
  try {
    scope.postMessage({ result: optimizeMateriaTarget(e.data) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
