// 生產／採集職業魔晶石最佳化（src/materiaTarget.ts）的隨機驗證：以真實裝備資料隨機產生小型情境
// （1～3 件裝備、隨機目標、禁斷孔數量與食物），以暴力列舉求出兩種方案的最佳評分，確認與最佳化結果相同。
//
// 暴力列舉與最佳化各自獨立實作：
// - 每件裝備列舉所有孔洞的屬性分配（由前往後依序鑲嵌）
// - 每個屬性的魔晶石等級組合全部窮舉，取「數值與全用最高等級時相同、超出最少、期望消耗最少」者
// - 所有裝備的組合全部列舉，依兩種方案的評分取最佳
// 另外從方案實際的魔晶石重算最終數值與期望消耗，並檢查等級是否可鑲嵌、孔洞是否由前往後連續。
//
// 用法：
//   npm run test-materia-target-fuzz                 預設 200 個情境
//   npm run test-materia-target-fuzz -- 1000 42      情境數、亂數種子

import * as G from '../../src/game';
import { optimizeMateriaTarget } from '../../src/materiaTarget';
import type { MateriaTargetSolution } from '../../src/materiaTarget';

/* eslint-disable @typescript-eslint/no-require-imports */
const gearData: G.Gear[] = Array.from(new Map(['gears-recent', 'gears-730', 'gears-661', 'gears-645']
  .flatMap(file => require(`../../data/out/${file}`).default as G.Gear[])
  .map(gear => [gear.id, gear])).values());
const foodData = require('../../data/out/foods').default as G.Food[];
/* eslint-enable @typescript-eslint/no-require-imports */

const iterations = Number(process.argv[2] ?? 200);
let seed = Number(process.argv[3] ?? 777);
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pickOne = <T>(list: T[]) => list[Math.floor(random() * list.length)];
const better = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-9) return true;
    if (a[i] > b[i] + 1e-9) return false;
  }
  return false;
};
const rateOf = (gear: G.Gear, index: number, grade: G.MateriaGrade) => {
  const advancedIndex = index - gear.materiaSlot;
  return advancedIndex < 0 ? 100 : G.materiaSuccessRates[advancedIndex][grade - 1];
};
// 可鑲嵌的等級：一般孔與第一個禁斷孔（290 品級以上）可用全部等級，其後的禁斷孔不能用偶數等級的高階魔晶石
const allowedGrades = (gear: G.Gear, index: number) => G.materiaGrades.filter(grade =>
  gear.level >= G.materiaGradeRequiredLevels[grade - 1] &&
  (index <= gear.materiaSlot && gear.level >= 290 || ![12, 10, 8, 6].includes(grade)) &&
  rateOf(gear, index, grade) > 0);

let failures = 0;
let downgraded = 0;
for (let iteration = 0; iteration < iterations; iteration++) {
  const job: G.Job = pickOne(['CRP', 'CUL', 'MIN', 'FSH'] as G.Job[]);
  const stats = G.jobSchemas[job].stats;
  const pool = gearData.filter(gear => G.jobCategories[gear.jobCategory][job] && gear.materiaSlot > 0 && gear.slot !== 17);
  const gearCount = pickOne([1, 2, 2, 3]);
  const overmeldLimit = gearCount === 3 ? pickOne([0, 1]) : pickOne([0, 1, 2, 5]);
  const gears = Array.from({ length: gearCount }, (_, i) => {
    const data = pickOne(pool);
    const materias = Array.from({ length: data.materiaAdvanced ? 5 : data.materiaSlot }, () => ({}));
    return { id: (data.id * 10 + i) as G.GearId, data, materias };
  });
  const consumables = random() < 0.5 ? [] :
    [pickOne(foodData.filter(food => stats.some(stat => stat in food.stats)))]
      .map(food => ({ stats: food.stats, statRates: food.statRates }));
  const baseStats: G.Stats = {};
  for (const stat of stats) baseStats[stat] = G.baseStats[stat] as number ?? 0;
  const finalOf = (k: number, value: number) => {
    let ret = value;
    for (const c of consumables) {
      const max = c.stats[stats[k]] ?? 0;
      if (max <= 0) continue;
      const rate = c.statRates[stats[k]];
      ret += rate === undefined ? max : Math.min(max, G.floor(value * rate / 100));
    }
    return ret;
  };
  const fixed = stats.map(stat => baseStats[stat]! +
    gears.reduce((sum, gear) => sum + (G.calcGearStats(gear.data, { materiaStats: {} })[stat] ?? 0), 0));
  const targets: G.Stats = {};
  stats.forEach((stat, k) => {
    if (random() < 0.8) targets[stat] = finalOf(k, fixed[k]) + Math.floor(random() * 150 * (stat === 'CP' || stat === 'GP' ? 0.3 : 1));
  });
  const result = optimizeMateriaTarget({ stats, baseStats, gears, consumables, targets, overmeldLimit });
  const units = stats.map(stat => G.materias[stat]![11]);

  // 暴力列舉每件裝備的選項
  const gearOptions = gears.map(gear => {
    const usableEnd = Math.min(gear.materias.length, gear.data.materiaSlot + overmeldLimit);
    const slots: { index: number, grades: G.MateriaGrade[] }[] = [];
    for (let index = 0; index < usableEnd; index++) {
      const grades = allowedGrades(gear.data, index);
      if (grades.length === 0 || grades[0] !== G.materiaTopGrade(gear.data, index)) break;
      slots.push({ index, grades });
    }
    const bare = G.calcGearStats(gear.data, { materiaStats: {} });
    const gainOf = (stat: G.Stat, sum: number) =>
      (G.calcGearStats(gear.data, { materiaStats: { [stat]: sum } })[stat] ?? 0) - (bare[stat] ?? 0);
    const placements = new Map<string, { gain: number, cost: number }>();
    const placementOf = (stat: G.Stat, slotIndices: number[]) => {
      const key = stat + slotIndices.join();
      const cached = placements.get(key);
      if (cached !== undefined) return cached;
      const values = G.materias[stat]!;
      const topGain = gainOf(stat, slotIndices.reduce((sum, q) => sum + values[slots[q].grades[0] - 1], 0));
      let best: number[] | undefined;
      const enumerate = (j: number, sum: number, cost: number) => {
        if (j === slotIndices.length) {
          if (gainOf(stat, sum) !== topGain) return;
          if (best === undefined || better([sum, cost], best)) best = [sum, cost];
          return;
        }
        const slot = slots[slotIndices[j]];
        for (const grade of slot.grades) {
          enumerate(j + 1, sum + values[grade - 1], cost + Math.round(10000 / rateOf(gear.data, slot.index, grade)));
        }
      };
      enumerate(0, 0, 0);
      const ret = { gain: topGain, cost: best![1] };
      placements.set(key, ret);
      return ret;
    };
    const options: { gain: number[], cost: number }[] = [];
    const assignment: number[] = [];
    const visit = (p: number) => {
      const gain = [0, 0, 0];
      let cost = 0;
      stats.forEach((stat, k) => {
        const slotIndices = assignment.slice(0, p).map((x, q) => x === k ? q : -1).filter(q => q >= 0);
        if (slotIndices.length === 0) return;
        const placement = placementOf(stat, slotIndices);
        gain[k] = placement.gain;
        cost += placement.cost;
      });
      options.push({ gain, cost });
      if (p === slots.length) return;
      for (let k = 0; k < 3; k++) {
        assignment[p] = k;
        visit(p + 1);
      }
    };
    visit(0);
    return options;
  });

  const need = stats.map((stat, k) => {
    const target = targets[stat] ?? 0;
    let value = fixed[k];
    while (finalOf(k, value) < target) value++;
    return value - fixed[k];
  });
  const scoresOf = (v: number[], cost: number) => {
    let deficit = 0;
    for (let k = 0; k < 3; k++) if (v[k] < need[k]) deficit += (need[k] - v[k]) / units[k];
    const finals = v.map((x, k) => finalOf(k, fixed[k] + x));
    const surplus = stats.map((stat, k) => (finals[k] - (targets[stat] ?? 0)) / units[k]).sort((a, b) => a - b);
    const total = v.reduce((sum, x, k) => sum + x / units[k], 0);
    return { minimal: [deficit, cost], maximal: [deficit, ...surplus.map(x => -x), -total, cost] };
  };
  let bestMinimal: number[] | undefined;
  let bestMaximal: number[] | undefined;
  const search = (g: number, v: number[], cost: number) => {
    if (g === gearOptions.length) {
      const scores = scoresOf(v, cost);
      if (bestMinimal === undefined || better(scores.minimal, bestMinimal)) bestMinimal = scores.minimal;
      if (bestMaximal === undefined || better(scores.maximal, bestMaximal)) bestMaximal = scores.maximal;
      return;
    }
    for (const option of gearOptions[g]) search(g + 1, v.map((x, k) => x + option.gain[k]), cost + option.cost);
  };
  search(0, [0, 0, 0], 0);

  // 由方案實際的魔晶石重算
  const verify = (solution: MateriaTargetSolution) => {
    const v = [0, 0, 0];
    let cost = 0;
    for (const gear of gears) {
      const materias = solution.gearMaterias.get(gear.id)!;
      const materiaStats: G.Stats = {};
      materias.forEach((materia, index) => {
        if (materia === undefined) return;
        if (materia.grade !== G.materiaTopGrade(gear.data, index)) downgraded++;
        if (!allowedGrades(gear.data, index).includes(materia.grade)) throw new Error('不可鑲嵌的等級');
        materiaStats[materia.stat] = (materiaStats[materia.stat] ?? 0) + G.materias[materia.stat]![materia.grade - 1];
        cost += Math.round(10000 / rateOf(gear.data, index, materia.grade));
      });
      const lastUsed = materias.reduce((last, materia, index) => materia === undefined ? last : index, -1);
      for (let index = 0; index < lastUsed; index++) {
        if (materias[index] === undefined) throw new Error('孔洞沒有由前往後連續鑲嵌');
      }
      const withMateria = G.calcGearStats(gear.data, { materiaStats });
      const bare = G.calcGearStats(gear.data, { materiaStats: {} });
      stats.forEach((stat, k) => {
        v[k] += (withMateria[stat] ?? 0) - (bare[stat] ?? 0);
      });
    }
    if (Math.abs(cost / 100 - solution.expectedConsumption) > 1e-6) throw new Error('期望消耗不符');
    stats.forEach((stat, k) => {
      if (finalOf(k, fixed[k] + v[k]) !== solution.stats[stat]) throw new Error('最終數值不符');
    });
    return scoresOf(v, cost);
  };
  const minimal = verify(result.minimal).minimal;
  const maximal = verify(result.maximal).maximal;
  const minimalOk = !better(bestMinimal!, minimal) && !better(minimal, bestMinimal!);
  const maximalOk = !better(bestMaximal!, maximal) && !better(maximal, bestMaximal!);
  if (!minimalOk || !maximalOk) {
    failures++;
    console.log(`失敗 #${iteration} ${job} ${gearCount}件 禁斷${overmeldLimit} 目標${JSON.stringify(targets)}`);
    if (!minimalOk) console.log(`  最少方案 ${JSON.stringify(minimal)}，暴力列舉 ${JSON.stringify(bestMinimal)}`);
    if (!maximalOk) console.log(`  最高方案 ${JSON.stringify(maximal)}，暴力列舉 ${JSON.stringify(bestMaximal)}`);
  }
}
console.log(`完成 ${iterations} 個情境，失敗 ${failures} 個（方案中使用了 ${downgraded} 顆較低等級的魔晶石）`);
if (failures > 0) process.exitCode = 1;
