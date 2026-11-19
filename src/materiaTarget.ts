// 生產／採集職業的魔晶石最佳化：依目標數值計算需要鑲嵌的魔晶石
// 純計算模組，不依賴 MobX 狀態
//
// 輸入目前裝備、食物／藥品與各屬性的目標數值（含食物與藥品加成後的最終數值），在禁斷孔數量限制內
// 重新分配受管理屬性（作業精度、加工精度、製作力；或獲得力、鑑別力、採集力）的魔晶石，求出兩種方案：
// - 最少：達成全部目標所需的魔晶石最少（以期望消耗數量計，禁斷孔依成功率換算）
// - 最高：達成全部目標後，禁斷範圍內的孔洞全部鑲嵌，總數值最高（剩餘數值盡量平均分配給各屬性）
// 無法達成目標時，兩種方案都以「未達量最少」為優先（未達量以最高等級魔晶石的顆數換算）。
//
// 規則：
// - 每個可使用孔洞鑲嵌此孔洞可鑲嵌的最高等級魔晶石；同一件裝備的某屬性會超出數值上限時，
//   改用數值不變而超出最少的等級組合（超出量相同時取期望消耗較少者，較低等級的禁斷成功率較高）
// - 孔洞必須由前往後依序鑲嵌（遊戲中禁斷孔必須在一般孔都鑲嵌後才能鑲嵌，後面的禁斷孔也要等前面的鑲嵌後）
// - 其他屬性的魔晶石維持不變；超出禁斷孔數量限制的孔洞上，受管理屬性的魔晶石會被移除
// - 品級同步中魔晶石失效的裝備不參與最佳化
//
// 演算法：每件裝備列舉所有孔洞分配（每孔 3 種屬性，最多 5 孔），換算成「此裝備各屬性增加量」，
// 同樣增加量只保留期望消耗最少者並剔除完全劣勢的選項；再以動態規劃逐件裝備累加，
// 狀態為各屬性的增加量合計，同一狀態只保留期望消耗最少者，最後依兩種方案的評分各自挑選。

import * as G from './game';

export interface MateriaTargetGear {
  id: G.GearId,
  data: G.Gear,
  materias: { stat?: G.Stat, grade?: G.MateriaGrade }[],
  syncedLevel?: number,
}

export interface MateriaTargetConsumable {
  stats: G.Stats,
  statRates: G.Stats,
}

export interface MateriaTargetInput {
  stats: G.Stat[],  // 受管理的屬性
  baseStats: G.Stats,
  gears: MateriaTargetGear[],
  consumables: MateriaTargetConsumable[],  // 食物、藥品
  targets: G.Stats,  // 最終數值的目標，未設定視為不要求
  overmeldLimit: number,
}

export interface MateriaTargetMateria {
  stat: G.Stat,
  grade: G.MateriaGrade,
}

export interface MateriaTargetSolution {
  gearMaterias: Map<G.GearId, (MateriaTargetMateria | undefined)[]>,  // 各孔洞最終的魔晶石（含維持不變者）
  stats: G.Stats,  // 最終數值（含食物與藥品）
  shortfalls: G.Stats,  // 未達目標的差距，達成者不列出
  slotCount: number,  // 鑲嵌的孔洞數
  overmeldCount: number,  // 其中禁斷孔的數量
  expectedConsumption: number,  // 期望消耗的魔晶石數量
}

export interface MateriaTargetResult {
  minimal: MateriaTargetSolution,
  maximal: MateriaTargetSolution,
  states: number,  // 動態規劃中最大的一層狀態數，供效能檢查
}

interface SlotGrade {
  grade: G.MateriaGrade,
  cost: number,  // 期望消耗，以百分之一顆為單位
}

interface SlotPlan {
  index: number,
  grades: SlotGrade[],  // 可鑲嵌的等級，由高到低，第一個為最高等級
  overmeld: boolean,
  original?: MateriaTargetMateria,  // 原本鑲嵌的受管理屬性魔晶石
}

interface GearOption {
  gain: number[],
  cost: number,
  costs: number[],  // 期望消耗依屬性拆分（各屬性的魔晶石鑲在不同孔洞，合計即為 cost）
  changes: number,
  assignment: (MateriaTargetMateria | undefined)[],  // 對應 SlotPlan，undefined 表示不鑲嵌
}

/** 動態規劃的一層：存活狀態的各屬性增加量、期望消耗（含改動數的次要排序），以及回溯用的來源狀態與選項 */
interface Layer {
  n: number,
  v: Int32Array[],
  cost: Int32Array,
  parent: Int32Array,
  option: Int32Array,
}

interface LayerRun {
  layers: Layer[],  // layers[0] 為起點，layers[g + 1] 為累加第 g 件裝備後
  maxCandidates: number,
}

export function optimizeMateriaTarget(input: MateriaTargetInput): MateriaTargetResult {
  const { stats, baseStats, consumables, targets, overmeldLimit } = input;
  const dims = stats.length;
  const units = stats.map(stat => G.materias[stat]![11]);

  const isManaged = (stat: G.Stat | undefined) => stat !== undefined && stats.includes(stat);

  // 不參與最佳化的部分：基礎數值、品級同步的裝備、裝備本身及其他屬性魔晶石
  const fixed = stats.map(stat => baseStats[stat] ?? 0);
  const managedGears: { gear: MateriaTargetGear, plans: SlotPlan[], options: GearOption[] }[] = [];
  for (const gear of input.gears) {
    const { data, syncedLevel } = gear;
    if (syncedLevel !== undefined) {
      const gearStats = G.calcGearStats(data, { syncedLevel, materiaStats: materiaStatsOf(gear.materias) });
      stats.forEach((stat, k) => {
        fixed[k] += gearStats[stat] ?? 0;
      });
      continue;
    }
    const keptMaterias = gear.materias.map(m => isManaged(m.stat) ? {} : m);
    const bare = G.calcGearStats(data, { materiaStats: materiaStatsOf(keptMaterias) });
    stats.forEach((stat, k) => {
      fixed[k] += bare[stat] ?? 0;
    });

    // 可使用的孔洞：由前往後，遇到不可使用者為止（其他屬性的魔晶石視為已鑲嵌，可越過）
    const plans: SlotPlan[] = [];
    const usableEnd = Math.min(gear.materias.length, data.materiaSlot + overmeldLimit);
    for (let i = 0; i < usableEnd; i++) {
      const materia = gear.materias[i];
      if (materia.stat !== undefined && !isManaged(materia.stat)) continue;
      const advancedIndex = i - data.materiaSlot;
      const canRestricted = G.materiaCanRestricted(data, i);
      const grades: SlotGrade[] = [];
      for (const grade of G.materiaGrades) {
        if (data.level < G.materiaGradeRequiredLevels[grade - 1]) continue;
        if (!canRestricted && G.materiaGradeIsRestricted[grade]) continue;
        const rate = advancedIndex < 0 ? 100 : G.materiaSuccessRates[advancedIndex][grade - 1];
        if (rate > 0) grades.push({ grade, cost: Math.round(10000 / rate) });
      }
      // 最高等級必須與一般鑲嵌時相同（禁斷成功率為 0 的等級不可用）
      if (grades.length === 0 || grades[0].grade !== G.materiaTopGrade(data, i)) break;
      plans.push({
        index: i,
        grades,
        overmeld: advancedIndex >= 0,
        original: materia.stat !== undefined && isManaged(materia.stat) && materia.grade !== undefined ?
          { stat: materia.stat, grade: materia.grade } : undefined,
      });
    }
    if (plans.length === 0 && !gear.materias.some(m => isManaged(m.stat))) continue;
    managedGears.push({ gear, plans, options: gearOptions(gear, keptMaterias, bare, plans) });
  }

  // 達成目標所需的裝備數值合計（扣除食物、藥品加成前）
  const finalOf = (k: number, value: number) => {
    let ret = value;
    for (const { stats: cStats, statRates } of consumables) {
      const max = cStats[stats[k]] ?? 0;
      if (max <= 0) continue;
      const rate = statRates[stats[k]];
      ret += rate === undefined ? max : Math.min(max, G.floor(value * rate / 100));
    }
    return ret;
  };
  const maxReach = stats.map((_, k) => managedGears.reduce((sum, { options }) =>
    sum + Math.max(0, ...options.map(o => o.gain[k])), 0));
  const need = stats.map((stat, k) => {
    const target = targets[stat] ?? 0;
    if (finalOf(k, fixed[k]) >= target) return 0;
    let lo = fixed[k];
    let hi = fixed[k] + Math.max(1, maxReach[k]);
    while (finalOf(k, hi) < target) hi += hi - lo;
    while (hi - lo > 1) {  // finalOf(lo) < target <= finalOf(hi)
      const mid = Math.floor((lo + hi) / 2);
      if (finalOf(k, mid) >= target) hi = mid; else lo = mid;
    }
    return hi - fixed[k];
  });

  // 未達量以最高等級魔晶石的顆數換算
  const deficitOf = (v: number[]) => {
    let ret = 0;
    for (let k = 0; k < dims; k++) if (v[k] < need[k]) ret += (need[k] - v[k]) / units[k];
    return ret;
  };

  // 動態規劃：逐件裝備累加各屬性增加量，每層只保留柏拉圖前緣
  // 最少方案：以（增加量、期望消耗）剔除劣勢狀態。增加量截斷於需求量；需求量不低於可達上限的屬性，
  //   未達量與增加量成正比，合併為一個維度（各屬性換算成魔晶石顆數的加權和），避免目標過高時狀態爆量
  // 最高方案：增加量不截斷，增加量完全不高於另一狀態者剔除（同樣增加量保留期望消耗最少者）
  const linear = stats.map((_, k) => need[k] >= maxReach[k]);
  const lcm = units.reduce((a, u, k) => linear[k] ? a / gcd(a, u) * u : a, 1);
  const minimalTransform = (v: number[]) => {
    const ret = stats.map((_, k) => linear[k] ? 0 : Math.min(v[k], need[k]));
    let w = 0;
    for (let k = 0; k < dims; k++) if (linear[k]) w += v[k] * (lcm / units[k]);
    ret.push(w);
    return ret.filter((_, i) => i === dims || !linear[i]).concat([0, 0, 0]).slice(0, 3);
  };
  const minimalCostTransform = (costs: number[]) => {  // 期望消耗依轉換後的維度拆分
    const ret = stats.map((_, k) => linear[k] ? 0 : costs[k]);
    let w = 0;
    for (let k = 0; k < dims; k++) if (linear[k]) w += costs[k];
    ret.push(w);
    return ret.filter((_, i) => i === dims || !linear[i]).concat([0, 0, 0]).slice(0, 3);
  };
  const minimalCaps = minimalTransform(maxReach);
  const linearNeed = stats.reduce((sum, _, k) => linear[k] ? sum + need[k] / units[k] : sum, 0);
  const minimalDeficitOf = (t: number[]) => {  // 由轉換後的狀態計算未達量
    let ret = linearNeed;
    let i = 0;
    for (let k = 0; k < dims; k++) {
      if (linear[k]) continue;
      ret += (need[k] - t[i]) / units[k];
      i++;
    }
    if (linear.some(Boolean)) ret -= t[i] / lcm;
    return ret;
  };
  const maximalRun = runLayers(managedGears.map(g => g.options), maxReach, false);

  const finalStatsOf = (v: number[]) => stats.map((_, k) => finalOf(k, fixed[k] + v[k]));
  const better = (a: number[], b: number[]) => {  // 字典序比較，越小越好，容許浮點誤差
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i] - 1e-9) return true;
      if (a[i] > b[i] + 1e-9) return false;
    }
    return false;
  };
  /** 回溯求出最終狀態實際的各屬性增加量（最少方案的狀態經過截斷與合併） */
  const gainOf = (run: LayerRun, finalIndex: number) => {
    const v = new Array<number>(dims).fill(0);
    let s = finalIndex;
    for (let g = managedGears.length - 1; g >= 0; g--) {
      const layer = run.layers[g + 1];
      const { gain } = managedGears[g].options[layer.option[s]];
      for (let k = 0; k < dims; k++) v[k] += gain[k];
      s = layer.parent[s];
    }
    return v;
  };
  /** 剩餘數值以最高等級魔晶石的顆數換算，由少到多逐一比較（越平均越好），再比較總數值 */
  const balanceScore = (v: number[]) => {
    const final = finalStatsOf(v);
    const surplus = stats.map((stat, k) => (final[k] - (targets[stat] ?? 0)) / units[k]).sort((a, b) => a - b);
    let total = 0;
    for (let k = 0; k < dims; k++) total += v[k] / units[k];
    return [...surplus.map(x => -x), -total];
  };
  const pick = (run: LayerRun, scoreOf: (s: number) => number[]) => {
    const last = run.layers[run.layers.length - 1];
    let bestIndex = 0;
    let bestScore: number[] | undefined;
    for (let s = 0; s < last.n; s++) {
      const score = scoreOf(s);
      if (bestScore === undefined || better(score, bestScore)) {
        bestIndex = s;
        bestScore = score;
      }
    }
    return bestIndex;
  };
  // 最高方案：未達量最少，其次剩餘數值越平均、總數值越高越好，最後期望消耗最少
  const maximalLast = maximalRun.layers[maximalRun.layers.length - 1];
  const maximalIndex = pick(maximalRun, s => {
    const v = maximalLast.v.map(a => a[s]);
    return [deficitOf(v), ...balanceScore(v), maximalLast.cost[s]];
  });

  // 最少方案的剪枝：
  // - 最高方案的未達量即為可達成的最小未達量；剩餘裝備全部取最大增加量仍會超過它的狀態可直接剔除
  // - 期望消耗上限：最高方案的期望消耗必定可行。可達成全部目標時，每個維度都必須補到需求量；
  //   期望消耗可依維度拆分（各維度的魔晶石鑲在不同孔洞），因此「剩餘裝備只看維度 d 補足需求、只計維度 d 的消耗」
  //   的最少值對各維度加總即為下界。上限先從起點的下界開始，找不到解時放寬 1.25 倍重算（迭代加深），
  //   找到的解若在上限內即為精確最佳解
  const minimalOptions = managedGears.map(g => g.options.map(o =>
    ({ ...o, gain: minimalTransform(o.gain), costs: minimalCostTransform(o.costs) })));
  const gearCount = minimalOptions.length;
  const bestDeficit = deficitOf(maximalLast.v.map(a => a[maximalIndex]));
  const feasible = bestDeficit < 1e-9;
  const maxCostLimit = Math.floor(maximalLast.cost[maximalIndex] / 1000);  // 以百分之一顆為單位
  const suffixMax = minimalOptions.map(() => [0, 0, 0]);
  suffixMax.push([0, 0, 0]);
  for (let g = gearCount - 1; g >= 0; g--) {
    for (let d = 0; d < 3; d++) {
      suffixMax[g][d] = suffixMax[g + 1][d] + Math.max(0, ...minimalOptions[g].map(o => o.gain[d]));
    }
  }
  // restCost[d][g][x]：第 g 件之後的裝備在維度 d 補足 x 所需、只計維度 d 的最少期望消耗（背包問題；範圍過大的維度不計算）
  const restCost = minimalCaps.map((cap, d) => {
    if (!feasible || cap === 0 || cap > 5000) return undefined;
    const ret: Float64Array[] = new Array(gearCount + 1);
    ret[gearCount] = new Float64Array(cap + 1).fill(Infinity);
    ret[gearCount][0] = 0;
    for (let g = gearCount - 1; g >= 0; g--) {
      const next = ret[g + 1];
      const current = new Float64Array(cap + 1).fill(Infinity);
      for (const option of minimalOptions[g]) {
        for (let x = 0; x <= cap; x++) {
          const value = option.costs[d] + next[Math.max(0, x - option.gain[d])];
          if (value < current[x]) current[x] = value;
        }
      }
      ret[g] = current;
    }
    return ret;
  });
  const restCostBound = (g: number, t0: number, t1: number, t2: number) => {
    let ret = 0;
    if (restCost[0] !== undefined) ret += restCost[0][g][minimalCaps[0] - t0];
    if (restCost[1] !== undefined) ret += restCost[1][g][minimalCaps[1] - t1];
    if (restCost[2] !== undefined) ret += restCost[2][g][minimalCaps[2] - t2];
    return ret;
  };
  let costLimit = feasible ? Math.max(1, restCostBound(0, 0, 0, 0)) : maxCostLimit;
  const reach = [0, 0, 0];
  let minimalRun: LayerRun;
  for (;;) {
    const limit = Math.min(costLimit, maxCostLimit);
    minimalRun = runLayers(minimalOptions, minimalCaps, true, (g, t0, t1, t2, cost) => {
      if (Math.floor(cost / 1000) + restCostBound(g + 1, t0, t1, t2) > limit) return true;
      const rest = suffixMax[g + 1];
      reach[0] = Math.min(minimalCaps[0], t0 + rest[0]);
      reach[1] = Math.min(minimalCaps[1], t1 + rest[1]);
      reach[2] = Math.min(minimalCaps[2], t2 + rest[2]);
      return minimalDeficitOf(reach) > bestDeficit + 1e-9;
    });
    if (limit >= maxCostLimit) break;
    const last = minimalRun.layers[gearCount];
    let found = false;
    for (let s = 0; s < last.n && !found; s++) {
      found = minimalDeficitOf(last.v.map(a => a[s])) <= bestDeficit + 1e-9;
    }
    if (found) break;
    costLimit = Math.ceil(limit * 1.25);
  }

  // 最少方案：未達量最少，其次期望消耗最少，再其次剩餘數值越平均越好（只在前兩項相同的狀態間比較）
  const minimalLast = minimalRun.layers[minimalRun.layers.length - 1];
  const minimalPrimary = (s: number) =>
    [minimalDeficitOf(minimalLast.v.map(a => a[s])), minimalLast.cost[s] - minimalLast.cost[s] % 1000];
  const minimalBest = minimalPrimary(pick(minimalRun, minimalPrimary));
  const minimalIndex = pick(minimalRun, s => {
    const primary = minimalPrimary(s);
    if (better(minimalBest, primary)) return [Infinity];
    return [...balanceScore(gainOf(minimalRun, s)), minimalLast.cost[s]];
  });

  const buildSolution = (run: LayerRun, finalIndex: number): MateriaTargetSolution => {
    const chosen: GearOption[] = new Array(managedGears.length);
    let s = finalIndex;
    for (let g = managedGears.length - 1; g >= 0; g--) {
      const layer = run.layers[g + 1];
      chosen[g] = managedGears[g].options[layer.option[s]];
      s = layer.parent[s];
    }
    const gearMaterias = new Map<G.GearId, (MateriaTargetMateria | undefined)[]>();
    const v = new Array<number>(dims).fill(0);
    let slotCount = 0;
    let overmeldCount = 0;
    let expectedConsumption = 0;
    managedGears.forEach(({ gear, plans }, g) => {
      const option = chosen[g];
      const materias = gear.materias.map(({ stat, grade }) =>
        stat === undefined || grade === undefined || isManaged(stat) ? undefined : { stat, grade });
      plans.forEach((plan, p) => {
        const materia = option.assignment[p];
        materias[plan.index] = materia;
        if (materia === undefined) return;
        slotCount++;
        if (plan.overmeld) overmeldCount++;
        expectedConsumption += plan.grades.find(g => g.grade === materia.grade)!.cost / 100;
      });
      gearMaterias.set(gear.id, materias);
      for (let k = 0; k < dims; k++) v[k] += option.gain[k];
    });
    const final = finalStatsOf(v);
    const result: G.Stats = {};
    const shortfalls: G.Stats = {};
    stats.forEach((stat, k) => {
      result[stat] = final[k];
      const target = targets[stat] ?? 0;
      if (final[k] < target) shortfalls[stat] = target - final[k];
    });
    return { gearMaterias, stats: result, shortfalls, slotCount, overmeldCount, expectedConsumption };
  };

  return {
    minimal: buildSolution(minimalRun, minimalIndex),
    maximal: buildSolution(maximalRun, maximalIndex),
    states: Math.max(minimalRun.maxCandidates, maximalRun.maxCandidates),
  };

  function gearOptions(
    gear: MateriaTargetGear,
    keptMaterias: MateriaTargetGear['materias'],
    bare: G.Stats,
    plans: SlotPlan[],
  ): GearOption[] {
    // 此裝備各屬性魔晶石可增加的上限
    const unlimitedStats: G.Stats = materiaStatsOf(keptMaterias);
    for (const stat of stats) unlimitedStats[stat] = 1e6;
    const withUnlimited = G.calcGearStats(gear.data, { materiaStats: unlimitedStats });
    const room = stats.map(stat => Math.max(0, (withUnlimited[stat] ?? 0) - (bare[stat] ?? 0)));
    const changeOf = (plan: SlotPlan, stat: G.Stat, grade: G.MateriaGrade) =>
      plan.original?.stat === stat && plan.original.grade === grade ? 0 : 1;

    // 某屬性鑲在指定孔洞時各孔的等級：未超出上限時全用最高等級，
    // 超出時改用數值合計不低於上限、超出最少的組合，其次期望消耗最少、改動最少
    interface StatPlacement { gain: number, cost: number, changes: number, grades: G.MateriaGrade[] }
    const placements = new Map<string, StatPlacement>();
    const placementOf = (k: number, slots: number[]): StatPlacement => {
      const key = k + ':' + slots.join();
      const cached = placements.get(key);
      if (cached !== undefined) return cached;
      const stat = stats[k];
      const values = G.materias[stat]!;
      const topSum = slots.reduce((sum, p) => sum + values[plans[p].grades[0].grade - 1], 0);
      let ret: StatPlacement;
      if (topSum <= room[k]) {
        ret = {
          gain: topSum,
          cost: slots.reduce((sum, p) => sum + plans[p].grades[0].cost, 0),
          changes: slots.reduce((sum, p) => sum + changeOf(plans[p], stat, plans[p].grades[0].grade), 0),
          grades: slots.map(p => plans[p].grades[0].grade),
        };
      } else {
        // 依數值合計做動態規劃，每種合計保留（期望消耗、改動）最少者
        interface Entry { cost: number, changes: number, grades: G.MateriaGrade[] }
        let dp = new Map<number, Entry>([[ 0, { cost: 0, changes: 0, grades: [] } ]]);
        for (const p of slots) {
          const next = new Map<number, Entry>();
          for (const [ sum, entry ] of dp) {
            for (const { grade, cost } of plans[p].grades) {
              const nextSum = sum + values[grade - 1];
              const candidate = {
                cost: entry.cost + cost,
                changes: entry.changes + changeOf(plans[p], stat, grade),
                grades: [ ...entry.grades, grade ],
              };
              const existing = next.get(nextSum);
              if (existing === undefined || candidate.cost < existing.cost ||
                candidate.cost === existing.cost && candidate.changes < existing.changes) {
                next.set(nextSum, candidate);
              }
            }
          }
          dp = next;
        }
        let bestSum = Infinity;
        for (const sum of dp.keys()) if (sum >= room[k] && sum < bestSum) bestSum = sum;
        const best = dp.get(bestSum)!;
        ret = { gain: room[k], cost: best.cost, changes: best.changes, grades: best.grades };
      }
      placements.set(key, ret);
      return ret;
    };

    const byGain = new Map<string, GearOption>();
    const assignment: number[] = new Array(plans.length).fill(-1);  // 各孔洞的屬性索引，-1 表示不鑲嵌
    // 原本鑲嵌在已無法使用的孔洞上的受管理魔晶石，移除也算一次改動
    const removedChanges = gear.materias.filter((m, i) =>
      isManaged(m.stat) && !plans.some(plan => plan.index === i)).length;
    const visit = (p: number) => {
      // 前 p 個孔洞已分配，其後全部不鑲嵌
      const gain = new Array<number>(dims).fill(0);
      const costs = new Array<number>(dims).fill(0);
      const materias: (MateriaTargetMateria | undefined)[] = new Array(plans.length).fill(undefined);
      let cost = 0;
      let changes = removedChanges;
      for (let q = p; q < plans.length; q++) if (plans[q].original !== undefined) changes++;
      for (let k = 0; k < dims; k++) {
        const slots: number[] = [];
        for (let q = 0; q < p; q++) if (assignment[q] === k) slots.push(q);
        if (slots.length === 0) continue;
        const placement = placementOf(k, slots);
        gain[k] = placement.gain;
        costs[k] = placement.cost;
        cost += placement.cost;
        changes += placement.changes;
        slots.forEach((q, i) => {
          materias[q] = { stat: stats[k], grade: placement.grades[i] };
        });
      }
      const option = { gain, cost, costs, changes, assignment: materias };
      const key = gain.join();
      const existing = byGain.get(key);
      if (existing === undefined || option.cost < existing.cost ||
        option.cost === existing.cost && option.changes < existing.changes) {
        byGain.set(key, option);
      }
      if (p === plans.length) return;
      for (let k = 0; k < dims; k++) {
        assignment[p] = k;
        visit(p + 1);
      }
      assignment[p] = -1;
    };
    visit(0);
    // 剔除完全劣勢的選項：增加量都不高於另一個選項，期望消耗與改動也不少於它
    const list = Array.from(byGain.values());
    return list.filter(a => !list.some(b => b !== a &&
      b.gain.every((x, k) => x >= a.gain[k]) &&
      (b.cost < a.cost || b.cost === a.cost && b.changes <= a.changes) &&
      (b.cost < a.cost || b.changes < a.changes || b.gain.some((x, k) => x > a.gain[k]))));
  }
}

function materiaStatsOf(materias: { stat?: G.Stat, grade?: G.MateriaGrade }[]): G.Stats {
  const ret: G.Stats = {};
  for (const { stat, grade } of materias) {
    if (stat === undefined || grade === undefined) continue;
    ret[stat] = (ret[stat] ?? 0) + G.materias[stat]![grade - 1];
  }
  return ret;
}

function createLayer(size: number, dims: number): Layer {
  return {
    n: size,
    v: Array.from({ length: dims }, () => new Int32Array(size)),
    cost: new Int32Array(size),
    parent: new Int32Array(size),
    option: new Int32Array(size),
  };
}

/**
 * 逐件裝備累加選項，每層剔除劣勢狀態，只保留柏拉圖前緣。
 * 增加量截斷於 caps；withCost 時以（增加量、期望消耗）判斷支配，否則只以增加量判斷（同增加量保留期望消耗最少者）。
 * 支配判斷：依排序逐一檢查，以二維 Fenwick 樹記錄已保留狀態在兩個維度上的後綴最大值，第三個維度由排序或樹中的值保證。
 */
function runLayers(
  optionsList: GearOption[][],
  caps: number[],
  withCost: boolean,
  // 剪枝：累加第 g 件裝備後的狀態不可能成為最佳解時回傳 true
  prune?: (g: number, v0: number, v1: number, v2: number, cost: number) => boolean,
): LayerRun {
  const dims = caps.length;
  if (dims !== 3) throw new Error('materiaTarget: only 3 stats are supported');
  const [ d0, d1, d2 ] = [0, 1, 2].sort((a, b) => caps[b] - caps[a]);  // d0 範圍最大，不放入樹中
  const width = caps[d2] + 1;
  const fenwick = new Int32Array((caps[d1] + 2) * (width + 1));
  const query = (i0: number, j0: number) => {  // [1..i0] x [1..j0] 的最大值
    let ret = 0;
    for (let i = i0; i > 0; i -= i & -i) {
      for (let j = j0; j > 0; j -= j & -j) {
        const x = fenwick[i * (width + 1) + j];
        if (x > ret) ret = x;
      }
    }
    return ret;
  };
  const update = (i0: number, j0: number, value: number) => {
    for (let i = i0; i <= caps[d1] + 1; i += i & -i) {
      for (let j = j0; j <= width; j += j & -j) {
        const k = i * (width + 1) + j;
        if (fenwick[k] < value) fenwick[k] = value;
      }
    }
  };

  const start = createLayer(1, dims);
  const layers = [start];
  let layer = start;
  let maxCandidates = 1;
  optionsList.forEach((options, g) => {
    const cand = createLayer(layer.n * options.length, dims);
    let c = 0;
    for (let s = 0; s < layer.n; s++) {
      for (let o = 0; o < options.length; o++) {
        const option = options[o];
        for (let k = 0; k < dims; k++) cand.v[k][c] = Math.min(caps[k], layer.v[k][s] + option.gain[k]);
        cand.cost[c] = layer.cost[s] + option.cost * 1000 + option.changes;
        if (prune?.(g, cand.v[0][c], cand.v[1][c], cand.v[2][c], cand.cost[c])) continue;
        cand.parent[c] = s;
        cand.option[c] = o;
        c++;
      }
    }
    const n = c;
    maxCandidates = Math.max(maxCandidates, n);

    // 排序（由次要到主要依序做穩定的計數排序）
    let order: Int32Array = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const keys = new Int32Array(n);
    const sortBy = (fill: (i: number) => number) => {
      for (let i = 0; i < n; i++) keys[i] = fill(i);
      order = countingSort(order, keys);
    };
    const sumOf = (i: number) => cand.v[0][i] + cand.v[1][i] + cand.v[2][i];
    const maxSum = caps[0] + caps[1] + caps[2];
    if (withCost) {
      // 期望消耗由少到多，同消耗時增加量合計多者優先，再其次改動少者優先
      // （改動數只作為同增加量時的次要比較，不參與支配判斷，以免狀態數膨脹）
      sortBy(i => cand.cost[i] % 1000);
      sortBy(i => maxSum - sumOf(i));
      sortBy(i => Math.floor(cand.cost[i] / 1000));
    } else {
      // d0 由大到小，其次另兩維合計由大到小，同增加量時期望消耗少者優先
      sortBy(i => cand.cost[i]);
      sortBy(i => caps[d1] + caps[d2] - cand.v[d1][i] - cand.v[d2][i]);
      sortBy(i => caps[d0] - cand.v[d0][i]);
    }

    fenwick.fill(0);
    const kept: number[] = [];
    for (let t = 0; t < n; t++) {
      const i = order[t];
      const fi = caps[d1] - cand.v[d1][i] + 1;
      const fj = caps[d2] - cand.v[d2][i] + 1;
      const found = query(fi, fj);
      if (withCost) {
        // 已保留的狀態期望消耗不多於此狀態，若 d1、d2 不低於且 d0 也不低於則此狀態為劣勢
        if (found >= cand.v[d0][i] + 1) continue;
        update(fi, fj, cand.v[d0][i] + 1);
      } else {
        // 已保留的狀態 d0 不低於此狀態
        if (found > 0) continue;
        update(fi, fj, 1);
      }
      kept.push(i);
    }

    const next = createLayer(kept.length, dims);
    kept.forEach((i, t) => {
      for (let k = 0; k < dims; k++) next.v[k][t] = cand.v[k][i];
      next.cost[t] = cand.cost[i];
      next.parent[t] = cand.parent[i];
      next.option[t] = cand.option[i];
    });
    layers.push(next);
    layer = next;
  });
  return { layers, maxCandidates };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 依非負整數鍵值做穩定排序，回傳新的順序 */
function countingSort(order: Int32Array, keys: Int32Array): Int32Array {
  const n = order.length;
  let maxKey = 0;
  for (let i = 0; i < n; i++) if (keys[i] > maxKey) maxKey = keys[i];
  const BITS = 16;
  let src: Int32Array = order;
  let dst: Int32Array = new Int32Array(n);
  for (let shift = 0; shift === 0 || shift < 32 && maxKey >>> shift > 0; shift += BITS) {
    const count = new Int32Array((1 << BITS) + 1);
    for (let t = 0; t < n; t++) count[((keys[src[t]] >>> shift) & 0xffff) + 1]++;
    for (let b = 0; b < 1 << BITS; b++) count[b + 1] += count[b];
    for (let t = 0; t < n; t++) dst[count[(keys[src[t]] >>> shift) & 0xffff]++] = src[t];
    [ src, dst ] = [ dst, src ];
  }
  return src;
}
