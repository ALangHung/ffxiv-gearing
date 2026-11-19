// 配裝最佳化問題回報的資料格式，前端（optimizerReport.ts）與重播腳本（test/optimizer/replay.ts）共用
// 純資料轉換，不依賴瀏覽器或建置時常數

import type * as G from './game';
import type { OptimizerInput, OptimizerMateria } from './optimizer';

/** 回報種類：slow／error 附帶計算輸入，其餘為同一次計算（run_id 相同）的後續結果 */
export type OptimizerReportKind = 'slow' | 'error' | 'done' | 'cancelled' | 'abandoned';

/**
 * 回報用的計算輸入：裝備資料依 ID 去重複（兩個戒指欄位共用），附帶完整資料而非只有 ID，
 * 重播時不必取得當時版本的遊戲資料。
 */
export interface OptimizerReportInput {
  v: 1,
  job: G.Job,
  jobLevel: G.JobLevel,
  syncLevel?: number,
  baseStats: G.Stats,
  gcdTarget: number,
  overmeldLimit: number,
  gears: Record<string, G.Gear>,  // 以裝備 ID（正數）為鍵
  slots: {
    slot: number,
    gears: { id: G.GearId, customStats?: G.Stats, materias: OptimizerMateria[], equipped: boolean }[],
  }[],
  foods: { data: G.Food, equipped: boolean }[],
}

/** 資料庫中的一筆回報（欄位名稱與 supabase/optimizer_reports.sql 相同） */
export interface OptimizerReportRow {
  id?: number,
  created_at?: string,
  run_id: string,
  kind: OptimizerReportKind,
  elapsed_ms?: number,
  error?: string,
  app: { version: string, commit: string, patch: string },
  client: { userAgent?: string, hardwareConcurrency?: number, deviceMemory?: number },
  result?: { damage: number, gcd: number, gcdUnmet: boolean },
  input?: OptimizerReportInput,
}

export function serializeOptimizerInput(input: OptimizerInput): OptimizerReportInput {
  const gears: Record<string, G.Gear> = {};
  const slots = input.slots.map(({ slot, gears: slotGears }) => ({
    slot,
    gears: slotGears.map(gear => {
      gears[Math.abs(gear.id)] = gear.data;
      return {
        id: gear.id,
        ...(gear.customStats !== undefined ? { customStats: gear.customStats } : {}),
        materias: gear.materias,
        equipped: gear.equipped,
      };
    }),
  }));
  return {
    v: 1,
    job: input.job,
    jobLevel: input.jobLevel,
    ...(input.syncLevel !== undefined ? { syncLevel: input.syncLevel } : {}),
    baseStats: input.baseStats,
    gcdTarget: input.gcdTarget,
    overmeldLimit: input.overmeldLimit,
    gears,
    slots,
    foods: input.foods,
  };
}

export function deserializeOptimizerInput(input: OptimizerReportInput): OptimizerInput {
  if (input.v !== 1) throw new Error(`不支援的回報格式版本：${String(input.v)}`);
  return {
    job: input.job,
    jobLevel: input.jobLevel,
    syncLevel: input.syncLevel,
    baseStats: input.baseStats,
    gcdTarget: input.gcdTarget,
    overmeldLimit: input.overmeldLimit,
    slots: input.slots.map(({ slot, gears }) => ({
      slot,
      gears: gears.map(gear => {
        const data = input.gears[Math.abs(gear.id)];
        if (data === undefined) throw new Error(`回報中缺少裝備 ${gear.id} 的資料`);
        return { id: gear.id, data, customStats: gear.customStats, materias: gear.materias, equipped: gear.equipped };
      }),
    })),
    foods: input.foods,
  };
}
