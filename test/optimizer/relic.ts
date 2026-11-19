// 幻境武器最終階段的屬性分配在新版中是最佳化的一部分；舊版（reference.ts、current-backup.ts）、
// 外部求解器與 fuzz.ts 的精確對照都只會沿用固定的自訂屬性。比對時把每件這類裝備展開為
// 「每種分配各一件、自訂屬性固定」的候選，讓各實作解的是同一個問題。

import * as G from '../../src/game';
import type { OptimizerInput } from '../../src/optimizer';

/** 與新版相同：在受管理的屬性（暴擊、信念、直擊、技速／詠速）與堅韌中分配 */
export function relicAllocationsFor(job: G.Job, gear: G.Gear): G.Stats[] | undefined {
  const schema = G.jobSchemas[job] as G.JobSchema;
  const rule = G.getRelicRule(gear, schema.stats);
  if (rule === undefined) return undefined;
  const speedStat: G.Stat = schema.stats.includes('SPS') ? 'SPS' : 'SKS';
  const relicStats: G.Stat[] = ['CRT', 'DET', 'DHT', speedStat, 'TEN'];
  return G.relicAllocations(rule, rule.stats.filter(stat => relicStats.includes(stat)));
}

/** 把幻境武器最終階段展開為各種分配的候選（實例 ID 依序加上分配編號，正負號不變） */
export function expandRelics(input: OptimizerInput): OptimizerInput {
  return {
    ...input,
    slots: input.slots.map(({ slot, gears }) => ({
      slot,
      gears: gears.flatMap(gear => {
        const allocations = relicAllocationsFor(input.job, gear.data);
        if (allocations === undefined) return [gear];
        return allocations.map((customStats, k) => ({
          ...gear,
          id: (Math.sign(gear.id) * (Math.abs(gear.id) * 100 + k + 1)) as G.GearId,
          customStats,
        }));
      }),
    })),
  };
}

/** 兩組屬性是否完全相同（不計順序） */
export function sameStats(a: G.Stats, b: G.Stats): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as G.Stat[]);
  return Array.from(keys).every(stat => a[stat] === b[stat]);
}
