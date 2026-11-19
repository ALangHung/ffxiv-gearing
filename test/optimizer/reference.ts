// 自動配裝最佳化的舊版（第一版）實作，保留作為驗證新版結果正確性的基準，不會被打包進網站。
// 與 src/optimizer.ts 的差異：沒有線性上界（速度背包、暴擊分段、斜率調整）與跨速度剔除，
// 食物依速度需求分組並以「樂觀食物」估上界，狀態以物件儲存且沒有數量上限。演算法較單純，適合作為正確性的對照。
// 執行比對：npm run test-optimizer

// 自動配裝：在候選裝備、魔晶石、食物中找出每威力傷害期望最高的配置
// 純計算模組，不依賴 MobX 狀態，於 Web Worker 中執行（見 optimizer.worker.ts）
//
// 演算法概要：
// 1. 每件候選裝備列舉可使用孔洞的魔晶石分配（暴擊、信念、直擊、技速／詠速），
//    得到此裝備的屬性向量 [主屬性, 基本性能, 速度, 暴擊, 信念, 直擊, 堅韌]，並剔除完全劣勢的選項。
//    兩個戒指欄位合併為一層，以排除同一件唯一戒指被裝備兩次的組合。
// 2. 逐部位動態規劃：狀態依（主屬性、基本性能、速度）分組，組內只保留暴擊、信念、直擊的柏拉圖前緣。
//    速度只需達到 GCD 目標，超出部分視為等同，避免無意義的狀態膨脹。
// 3. 分支定界：以「剩餘部位在滿足速度需求下各屬性的最大值」估算上界，
//    先以束搜尋求得可行解作為下界，再以精確搜尋剔除上界低於下界的狀態，結果為精確最佳解。
//
// 已知的近似與限制：
// - 堅韌魔晶石一律不鑲嵌（每點收益明顯低於其他屬性）；裝備本身的堅韌會計入傷害，
//   但只在暴擊、信念、直擊完全相同時才用來比較，理論上可能錯過堅韌較高但其他屬性略低的方案。
// - 幻境武器（可自訂屬性的裝備）不參與屬性分配最佳化，沿用使用者已填入的自訂屬性。
//   依 Console Games Wiki，795 品級幻境武器為「兩種屬性 447、第三種 108」，
//   可選屬性為暴擊、信念及依職能而定的兩種；但此規則未經確認，騎士劍與盾的數值也不明，暫不實作。
// - 不支援等級同步；品級同步下被同步的裝備魔晶石失效，維持原有魔晶石不變。

import * as G from '../../src/game';

export interface OptimizerMateria {
  stat?: G.Stat,
  grade?: G.MateriaGrade,
}

export interface OptimizerGear {
  id: G.GearId,  // 裝備實例 ID，第二個戒指欄位為負數
  data: G.Gear,
  customStats?: G.Stats,
  materias: OptimizerMateria[],
  equipped: boolean,
}

export interface OptimizerSlot {
  slot: number,
  gears: OptimizerGear[],
}

export interface OptimizerFood {
  data: G.Food,
  equipped: boolean,
}

export interface OptimizerInput {
  job: G.Job,
  jobLevel: G.JobLevel,
  syncLevel?: number,
  baseStats: G.Stats,
  slots: OptimizerSlot[],
  foods: OptimizerFood[],
  gcdTarget: number,
  overmeldLimit: number,
}

export interface OptimizerGearResult {
  slot: number,
  id: G.GearId,
  materiaStats?: (G.Stat | undefined)[],  // undefined 表示不更動此裝備的魔晶石
}

export interface OptimizerResult {
  gears: OptimizerGearResult[],
  foodId?: G.GearId,
  damage: number,
  stats: G.Stats,
  speedStat: G.Stat,
  gcd: number,
  gcdUnmet: boolean,
  managedStats: G.Stat[],
  elapsed: number,
}

const DIMS = 7;
const MAIN = 0;
const WD = 1;
const SPD = 2;
const CRT = 3;
const DET = 4;
const DHT = 5;
const TEN = 6;
// 速度以外的維度，用於上界估算
const BOUND_DIMS = [MAIN, WD, CRT, DET, DHT, TEN];

interface Choice {
  slot: number,
  id: G.GearId,
  materiaStats?: (G.Stat | undefined)[],
}

interface Option {
  v: number[],
  raw?: number[],  // 速度截斷前的原始向量
  changes: number,  // 與目前配置的差異量，用於同分時偏好改動較少的方案
  choices: Choice[],
}

interface State {
  v: number[],
  changes: number,
  parent: State | undefined,
  option: Option | undefined,
  ub: number,
}

const CHANGE_GEAR = 1000;  // 更換一件裝備相當於改動 1000 顆魔晶石，優先保留目前裝備

function isDominated(a: number[], b: number[]) {  // a 是否被 b 完全壓制
  for (let k = 0; k < DIMS; k++) {
    if (a[k] > b[k]) return false;
  }
  return true;
}

function paretoOptions(options: Option[]): Option[] {
  const unique = new Map<string, Option>();
  for (const option of options) {
    const key = option.v.join();
    const existing = unique.get(key);
    if (existing === undefined || existing.changes > option.changes) unique.set(key, option);
  }
  const list = Array.from(unique.values());
  return list.filter(a => !list.some(b => b !== a && isDominated(a.v, b.v)));
}

/** 只依暴擊、信念、直擊保留柏拉圖前緣，三者相同時保留堅韌較高、改動較少者（與 Store.materiaOptimized 相同的階梯法） */
function paretoStates(states: State[]): State[] {
  states.sort((a, b) => b.v[CRT] - a.v[CRT] || b.v[DET] - a.v[DET] || b.v[DHT] - a.v[DHT] ||
    b.v[TEN] - a.v[TEN] || a.changes - b.changes);
  const kept: State[] = [];
  const stair: { d: number, h: number }[] = [];  // d strictly descending, h strictly ascending
  let prev: State | undefined;
  for (const state of states) {
    if (prev !== undefined && prev.v[CRT] === state.v[CRT] && prev.v[DET] === state.v[DET] &&
      prev.v[DHT] === state.v[DHT]) continue;
    prev = state;
    const d = state.v[DET];
    const h = state.v[DHT];
    let lo = 0;
    let hi = stair.length;  // first index with stair.d < d
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (stair[mid].d >= d) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && stair[lo - 1].h >= h) continue;  // dominated
    kept.push(state);
    let end = lo;
    while (end < stair.length && stair[end].h <= h) end++;
    if (lo > 0 && stair[lo - 1].d === d) {  // same d with smaller h, replace it
      stair.splice(lo - 1, end - lo + 1, { d, h });
    } else {
      stair.splice(lo, end - lo, { d, h });
    }
  }
  return kept;
}

/** n 個孔洞分配給 m 種屬性的所有數量組合 */
function distributions(n: number, m: number): number[][] {
  if (m === 1) return [[n]];
  const ret: number[][] = [];
  for (let i = 0; i <= n; i++) {
    for (const rest of distributions(n - i, m - 1)) ret.push([i, ...rest]);
  }
  return ret;
}

export function optimize(input: OptimizerInput): OptimizerResult {
  const startTime = Date.now();
  const { job, jobLevel, syncLevel, baseStats, gcdTarget, overmeldLimit } = input;
  const schema = G.jobSchemas[job] as G.JobSchema;
  const mainStat = schema.mainStat!;
  const attackMainStat: G.Stat = mainStat === 'VIT' ? 'STR' : mainStat;
  const wdStat: G.Stat = mainStat === 'MND' || mainStat === 'INT' ? 'MDMG' : 'PDMG';
  const speedStat: G.Stat = schema.stats.includes('SPS') ? 'SPS' : 'SKS';
  const managedStats: G.Stat[] = ['CRT', 'DET', 'DHT', speedStat];
  const dimStats: G.Stat[] = [attackMainStat, wdStat, speedStat, 'CRT', 'DET', 'DHT', 'TEN'];

  // ---- 1. 每件裝備的選項

  const gearOptions = (slot: number, gear: OptimizerGear): Option[] => {
    const { data } = gear;
    const syncedLevel = G.calcSyncedLevel(data, jobLevel, syncLevel);
    const statsOptions = { mainStat, secondaryStat: schema.secondaryStat, customStats: gear.customStats, syncedLevel };
    // 基礎屬性中沒有的屬性（非坦克職業的堅韌）與介面的屬性合計一致，一律忽略
    const vectorOf = (stats: G.Stats) => dimStats.map(stat => baseStats[stat] === undefined ? 0 : stats[stat] ?? 0);
    const gearChange = gear.equipped ? 0 : CHANGE_GEAR;

    const currentStats = gear.materias.map(m => m.stat);
    const fixedMateriaStats: G.Stats = {};
    for (const materia of gear.materias) {
      if (materia.stat !== undefined && materia.grade !== undefined) {
        fixedMateriaStats[materia.stat] = (fixedMateriaStats[materia.stat] ?? 0) +
          G.materias[materia.stat]![materia.grade - 1];
      }
    }
    if (syncedLevel !== undefined) {
      // 魔晶石已失效，不更動
      const stats = G.calcGearStats(data, { ...statsOptions, materiaStats: fixedMateriaStats });
      return [{ v: vectorOf(stats), changes: gearChange, choices: [{ slot, id: gear.id }] }];
    }

    // 未受管理屬性的魔晶石維持不變；受管理屬性及空孔中，在禁斷孔限制內的為可使用孔洞，超出的移除
    const baseMateriaStats: G.Stats = {};
    const resultStats: (G.Stat | undefined)[] = currentStats.slice();
    const freeGroups = new Map<G.MateriaGrade, number[]>();
    gear.materias.forEach((materia, index) => {
      if (materia.stat !== undefined && !managedStats.includes(materia.stat)) {
        baseMateriaStats[materia.stat] = (baseMateriaStats[materia.stat] ?? 0) +
          G.materias[materia.stat]![materia.grade! - 1];
        return;
      }
      resultStats[index] = undefined;
      const grade = G.materiaTopGrade(data, index);
      if (index < data.materiaSlot + overmeldLimit && grade !== undefined) {
        const group = freeGroups.get(grade) ?? [];
        group.push(index);
        freeGroups.set(grade, group);
      }
    });

    const groups = Array.from(freeGroups.entries());
    const options: Option[] = [];
    const enumerate = (groupIndex: number, assigned: (G.Stat | undefined)[]) => {
      if (groupIndex === groups.length) {
        const materiaStats: G.Stats = { ...baseMateriaStats };
        let changes = gearChange;
        assigned.forEach((stat, index) => {
          if (stat !== currentStats[index] && (stat !== undefined || currentStats[index] !== undefined)) changes++;
          if (stat === undefined || resultStats[index] !== undefined) return;
          materiaStats[stat] = (materiaStats[stat] ?? 0) + G.materias[stat]![G.materiaTopGrade(data, index)! - 1];
        });
        const stats = G.calcGearStats(data, { ...statsOptions, materiaStats });
        options.push({ v: vectorOf(stats), changes, choices: [{ slot, id: gear.id, materiaStats: assigned.slice() }] });
        return;
      }
      const indexes = groups[groupIndex][1];
      for (const amounts of distributions(indexes.length, managedStats.length)) {
        const next = assigned.slice();
        const remaining = amounts.slice();
        for (const index of indexes) {  // 盡量保留原本的魔晶石
          const k = managedStats.indexOf(currentStats[index]!);
          if (k >= 0 && remaining[k] > 0) {
            next[index] = managedStats[k];
            remaining[k]--;
          }
        }
        for (const index of indexes) {
          if (next[index] !== undefined) continue;
          const k = remaining.findIndex(x => x > 0);
          next[index] = managedStats[k];
          remaining[k]--;
        }
        enumerate(groupIndex + 1, next);
      }
    };
    enumerate(0, resultStats);
    return paretoOptions(options);
  };

  const rawLayers: Option[][] = [];
  const ringSlots = input.slots.filter(s => Math.abs(s.slot) === 12);
  for (const { slot, gears } of input.slots) {
    if (Math.abs(slot) === 12) continue;
    const options = gears.flatMap(gear => gearOptions(slot, gear));
    rawLayers.push(options.length > 0 ? paretoOptions(options) :
      [{ v: new Array(DIMS).fill(0), changes: 0, choices: [] }]);
  }
  if (ringSlots.length === 2) {
    const [ ringsA, ringsB ] = ringSlots.map(({ slot, gears }) =>
      gears.map(gear => ({ gear, options: gearOptions(slot, gear) })));
    const options: Option[] = [];
    for (const a of ringsA) {
      for (const b of ringsB) {
        if (a.gear.data.id === b.gear.data.id && a.gear.data.unique) continue;
        for (const oa of a.options) {
          for (const ob of b.options) {
            options.push({
              v: oa.v.map((x, k) => x + ob.v[k]),
              changes: oa.changes + ob.changes,
              choices: [...oa.choices, ...ob.choices],
            });
          }
        }
      }
    }
    rawLayers.push(options.length > 0 ? paretoOptions(options) :
      [{ v: new Array(DIMS).fill(0), changes: 0, choices: [] }]);
  }

  // ---- 2. 食物與速度需求

  const foodAdd = (food: G.Food | undefined, stat: G.Stat, raw: number) => {
    const max = food?.stats[stat];
    if (!max) return 0;
    const rate = food!.statRates[stat];
    return rate === undefined ? max : Math.min(max, G.floor(raw * rate / 100));
  };
  const foodRelevantStats = dimStats.filter(stat => stat !== wdStat);
  // 剔除完全劣勢的食物（每個相關屬性的上限與比例都不高於另一個食物）
  const foods: (OptimizerFood | undefined)[] = input.foods.filter(a => !input.foods.some(b => b !== a &&
    foodRelevantStats.every(stat => (a.data.stats[stat] ?? 0) <= (b.data.stats[stat] ?? 0) &&
      (a.data.statRates[stat] ?? Infinity) <= (b.data.statRates[stat] ?? Infinity)) &&
    (foodRelevantStats.some(stat => (a.data.stats[stat] ?? 0) < (b.data.stats[stat] ?? 0) ||
      (a.data.statRates[stat] ?? Infinity) < (b.data.statRates[stat] ?? Infinity)) || a.data.id > b.data.id)));
  if (foods.length === 0) foods.push(undefined);

  const baseSpeed = baseStats[speedStat] ?? 0;
  const maxGearSpeed = rawLayers.reduce((sum, options) => sum + Math.max(...options.map(o => o.v[SPD])), 0);
  const gcdMet = (speed: number) =>
    Math.round(G.calcGcd(job, jobLevel, speed) * 100) <= Math.round(gcdTarget * 100);
  const speedNeedOf = (food: OptimizerFood | undefined) => {
    for (let gearSpeed = 0; gearSpeed <= maxGearSpeed; gearSpeed++) {
      const raw = baseSpeed + gearSpeed;
      if (gcdMet(raw + foodAdd(food?.data, speedStat, raw))) return gearSpeed;
    }
    return undefined;
  };
  let gcdUnmet = false;
  const needGroups = new Map<number, (OptimizerFood | undefined)[]>();
  for (const food of foods) {
    const need = speedNeedOf(food);
    if (need === undefined) continue;
    needGroups.set(need, [...(needGroups.get(need) ?? []), food]);
  }
  if (needGroups.size === 0) {
    // 無法達到 GCD 目標，改為在速度最大化的前提下最佳化傷害
    gcdUnmet = true;
    needGroups.set(maxGearSpeed, foods);
  }

  // ---- 3. 傷害評估

  const evalStats: G.Stats = { ...baseStats };
  const evaluate = (v: number[], food: G.Food | undefined) => {
    for (let k = 0; k < DIMS; k++) {
      const stat = dimStats[k];
      const base = baseStats[stat];
      if (base === undefined && v[k] === 0) continue;
      const raw = (base ?? 0) + v[k];
      evalStats[stat] = raw + foodAdd(food, stat, raw);
    }
    return G.calcDamage(job, jobLevel, evalStats, baseStats)!.damage;
  };

  // ---- 4. 分支定界

  const runSearch = (need: number, groupFoods: (OptimizerFood | undefined)[], lowerBound: number, beam: number,
    hint?: number[]) => {
    // 速度超過需求量的部分沒有意義，截斷後重新剔除劣勢選項（需求為 0 時所有速度魔晶石選項都會被剔除）
    const layers = rawLayers.map(options => paretoOptions(options.map(option => option.v[SPD] <= need ? option :
      { ...option, v: option.v.map((x, k) => k === SPD ? need : x), raw: option.v })));
    // 選項多的部位先處理，此時狀態數還少，可大幅減少組合數
    layers.sort((a, b) => b.length - a.length);

    // 上界估算用的樂觀食物：取同組食物各屬性的最大上限與最大比例，只需評估一次
    let boundFood: G.Food | undefined;
    if (groupFoods.length === 1 || groupFoods.includes(undefined)) {
      boundFood = groupFoods[0]?.data;
    } else {
      boundFood = { stats: {}, statRates: {} } as G.Food;
      for (const food of groupFoods as OptimizerFood[]) {
        for (const [ stat, value ] of Object.entries(food.data.stats) as G.StatPairs) {
          boundFood.stats[stat] = Math.max(boundFood.stats[stat] ?? 0, value);
          const rate = food.data.statRates[stat] ?? Infinity;
          boundFood.statRates[stat] = Math.max(boundFood.statRates[stat] ?? 0, rate);
        }
      }
      for (const [ stat, rate ] of Object.entries(boundFood.statRates) as G.StatPairs) {
        if (rate === Infinity) delete boundFood.statRates[stat];
      }
    }

    // suffix[i][r * width + j]：第 i 層之後，速度至少再提供 r 時，BOUND_DIMS[j] 的最大可能總和；
    // 最後一欄 SUM 為暴擊＋信念＋直擊合計的最大值
    const width = BOUND_DIMS.length + 1;
    const SUM = width - 1;
    const valueOf = (option: Option, j: number) =>
      j === SUM ? option.v[CRT] + option.v[DET] + option.v[DHT] : option.v[BOUND_DIMS[j]];
    const suffix: Float64Array[] = [];
    suffix[layers.length] = new Float64Array((need + 1) * width).fill(-Infinity);
    suffix[layers.length].fill(0, 0, width);
    for (let i = layers.length - 1; i >= 0; i--) {
      const next = suffix[i + 1];
      const current = new Float64Array((need + 1) * width).fill(-Infinity);
      for (let r = 0; r <= need; r++) {
        for (const option of layers[i]) {
          const rest = Math.max(0, r - option.v[SPD]) * width;
          for (let j = 0; j < width; j++) {
            const value = valueOf(option, j) + next[rest + j];
            if (value > current[r * width + j]) current[r * width + j] = value;
          }
        }
      }
      suffix[i] = current;
    }
    if (suffix[0][need * width] === -Infinity) return undefined;

    // 上界估算的查表：各屬性（裝備提供量 x，含基礎值與樂觀食物）對應的傷害因子
    // 由共用的傷害公式逐值產生，並以與 calcDamage 相同的乘法順序組合，結果與 calcDamage 完全一致
    const tableOf = (dim: number) => {
      const stat = dimStats[dim];
      const size = suffix[0][BOUND_DIMS.indexOf(dim)] + 1;  // r = 0 時為各部位最大值的總和，不會被超過
      const base = baseStats[stat];
      return Array.from({ length: size }, (_, x) => {
        if (base === undefined && x === 0) return undefined;
        const raw = (base ?? 0) + x;
        return raw + foodAdd(boundFood, stat, raw);
      });
    };
    const subTable = (dim: number, pick: (d: ReturnType<typeof G.calcSubStatDamage>) => number) =>
      Float64Array.from(tableOf(dim), value => pick(G.calcSubStatDamage(job, jobLevel,
        { CRT: value ?? 0, DET: value ?? 0, DHT: value ?? 0, TEN: dimStats[DIMS - 1] === 'TEN' ? value : undefined })));
    const crtTable = subTable(CRT, d => (d.crtDamage - 1) * d.crtChance + 1);
    const detTable = subTable(DET, d => d.detDamage);
    const dhtTable = subTable(DHT, d => 0.25 * d.dhtChance + 1);
    const tenTable = subTable(TEN, d => d.tenDamage);
    const mainValues = tableOf(MAIN);
    const mainTable = new Float64Array(mainValues.length);
    const weaponBaseTable = new Float64Array(mainValues.length);  // 基本性能為 0 時的 weaponDamage（含青魔法師加成）
    mainValues.forEach((value, x) => {
      const effects = G.calcDamage(job, jobLevel, { ...baseStats, [attackMainStat]: value, [wdStat]: 0 }, baseStats)!;
      mainTable[x] = effects.mainDamage;
      weaponBaseTable[x] = effects.weaponDamage;
    });
    const trait = schema.traitDamageMultiplier!;
    const boundOf = (m: number, w: number, c: number, d: number, h: number, t: number) =>
      0.01 * (weaponBaseTable[m] + w) * mainTable[m] * detTable[d] * tenTable[t] * trait * crtTable[c] * dhtTable[h];

    const jM = BOUND_DIMS.indexOf(MAIN);
    const jW = BOUND_DIMS.indexOf(WD);
    const jC = BOUND_DIMS.indexOf(CRT);
    const jD = BOUND_DIMS.indexOf(DET);
    const jH = BOUND_DIMS.indexOf(DHT);
    const jT = BOUND_DIMS.indexOf(TEN);

    // 拉格朗日上界：各屬性分別取最大值時，同一顆魔晶石會同時被算進暴擊、信念、直擊，上界過於寬鬆。
    // 以 log 傷害因子的上凹包絡 hull（≥ 原值）取代原函數，並利用「剩餘暴擊＋信念＋直擊 ≤ T」：
    //   Σ hull_k(v_k + x_k) ≤ λ·T + Σ φ_k(v_k)，其中 φ_k(v) = max_{y ≥ v} [hull_k(y) − λ·(y − v)]，對任意 λ ≥ 0 皆成立
    // φ 可預先算成表，每個候選只需查表；取數個 λ 的最小值，仍是合法上界，不影響結果的精確性
    const upperHull = (values: Float64Array) => {
      const hull: number[] = [];  // 上凸包的頂點 x
      for (let x = 0; x < values.length; x++) {
        while (hull.length >= 2) {
          const a = hull[hull.length - 2];
          const b = hull[hull.length - 1];
          if ((values[b] - values[a]) * (x - a) <= (values[x] - values[a]) * (b - a)) hull.pop(); else break;
        }
        hull.push(x);
      }
      const ret = new Float64Array(values.length);
      for (let i = 0; i + 1 < hull.length; i++) {
        const a = hull[i];
        const b = hull[i + 1];
        for (let x = a; x <= b; x++) ret[x] = values[a] + (values[b] - values[a]) * (x - a) / (b - a);
      }
      if (hull.length === 1) ret[0] = values[0];
      return ret;
    };
    const subHulls = [crtTable, detTable, dhtTable].map(table => upperHull(table.map(Math.log)));
    const lagrangians: { lambda: number, phis: Float64Array[] }[] = [];
    if (hint !== undefined && lowerBound > 0) {
      const slopes = [CRT, DET, DHT].map((dim, k) => {
        const hull = subHulls[k];
        const x = Math.min(hint[dim], hull.length - 2);
        return Math.max(0, hull[x + 1] - hull[x]);
      }).filter(slope => slope > 0);
      const lambdas = new Set<number>();
      for (const slope of slopes) lambdas.add(slope);
      if (slopes.length > 0) {
        lambdas.add(Math.min(...slopes) * 0.7);
        lambdas.add(Math.max(...slopes) * 1.4);
      }
      for (const lambda of lambdas) {
        lagrangians.push({
          lambda,
          phis: subHulls.map(hull => {
            const phi = new Float64Array(hull.length);
            let best = -Infinity;
            for (let y = hull.length - 1; y >= 0; y--) {
              best = Math.max(best, hull[y] - lambda * y);
              phi[y] = best + lambda * y;
            }
            return phi;
          }),
        });
      }
    }
    const logLowerBound = Math.log(lowerBound) - 1e-9;
    let states: State[] = [{ v: new Array(DIMS).fill(0), changes: 0, parent: undefined, option: undefined, ub: Infinity }];
    for (let i = 0; i < layers.length; i++) {
      const rest = suffix[i + 1];
      const buckets = new Map<number, { states: State[], limit: number }>();
      for (const state of states) {
        const sv = state.v;
        for (const option of layers[i]) {
          const ov = option.v;
          const spd = Math.min(sv[SPD] + ov[SPD], need);
          const offset = (need - spd) * width;
          if (rest[offset] === -Infinity) continue;  // 剩餘部位無法滿足速度需求
          const m = sv[MAIN] + ov[MAIN];
          const w = sv[WD] + ov[WD];
          const c = sv[CRT] + ov[CRT];
          const d = sv[DET] + ov[DET];
          const h = sv[DHT] + ov[DHT];
          const t = sv[TEN] + ov[TEN];
          const ub = boundOf(m + rest[offset + jM], w + rest[offset + jW], c + rest[offset + jC],
            d + rest[offset + jD], h + rest[offset + jH], t + rest[offset + jT]);
          if (ub < lowerBound) continue;
          if (lagrangians.length > 0) {
            const total = rest[offset + SUM];
            let sub = Infinity;
            for (const { lambda, phis } of lagrangians) {
              const value = lambda * total + phis[0][c] + phis[1][d] + phis[2][h];
              if (value < sub) sub = value;
            }
            const mu = m + rest[offset + jM];
            const tu = t + rest[offset + jT];
            const fixed = Math.log(0.01 * (weaponBaseTable[mu] + w + rest[offset + jW]) * mainTable[mu] * tenTable[tu] * trait);
            if (fixed + sub < logLowerBound) continue;
          }
          const key = (m * 1024 + w) * 8192 + spd;
          let bucket = buckets.get(key);
          if (bucket === undefined) {
            bucket = { states: [], limit: 64 };
            buckets.set(key, bucket);
          }
          bucket.states.push({ v: [m, w, spd, c, d, h, t], changes: state.changes + option.changes, parent: state, option, ub });
          if (bucket.states.length >= bucket.limit) {
            // 邊產生邊剔除劣勢狀態，避免先產生全部候選造成記憶體暴增
            bucket.states = paretoStates(bucket.states);
            bucket.limit = Math.max(64, bucket.states.length * 2);
          }
        }
      }
      states = [];
      for (const bucket of buckets.values()) {
        for (const state of bucket.states.length > 1 ? paretoStates(bucket.states) : bucket.states) states.push(state);
      }
      if (beam > 0 && states.length > beam) {
        states.sort((a, b) => b.ub - a.ub);
        states.length = beam;
      }
    }

    let best: { state: State, food: OptimizerFood | undefined, damage: number, changes: number } | undefined;
    for (const state of states) {
      for (const food of groupFoods) {
        const damage = evaluate(state.v, food?.data);
        const changes = state.changes + (food === undefined || food.equipped ? 0 : CHANGE_GEAR);
        if (best === undefined || damage > best.damage || (damage === best.damage && changes < best.changes)) {
          best = { state, food, damage, changes };
        }
      }
    }
    return best;
  };

  type Best = NonNullable<ReturnType<typeof runSearch>>;
  const better = (a: Best | undefined, b: Best | undefined) =>
    b !== undefined && (a === undefined || b.damage > a.damage || (b.damage === a.damage && b.changes < a.changes)) ? b : a;
  let best: Best | undefined;
  for (const [ need, groupFoods ] of needGroups) {
    best = better(best, runSearch(need, groupFoods, 0, 1000));  // 束搜尋求下界
  }
  const lowerBound = best?.damage ?? 0;
  const hint = best?.state.v;
  for (const [ need, groupFoods ] of needGroups) {
    best = better(best, runSearch(need, groupFoods, lowerBound, 0, hint));  // 精確搜尋
  }
  if (best === undefined) throw Error('找不到可行的配置');

  // ---- 5. 輸出

  const gears: OptimizerGearResult[] = [];
  const totals: number[] = new Array(DIMS).fill(0);  // 狀態中的速度已截斷於需求量，需以實際選項重新加總
  for (let state: State | undefined = best.state; state?.option !== undefined; state = state.parent) {
    gears.unshift(...state.option.choices);
    (state.option.raw ?? state.option.v).forEach((x, k) => { totals[k] += x; });
  }
  const stats: G.Stats = {};
  dimStats.forEach((stat, k) => {
    const base = baseStats[stat];
    if (base === undefined && totals[k] === 0) return;
    const raw = (base ?? 0) + totals[k];
    stats[stat] = raw + foodAdd(best!.food?.data, stat, raw);
  });
  return {
    gears,
    foodId: best.food?.data.id,
    damage: best.damage,
    stats,
    speedStat,
    gcd: G.calcGcd(job, jobLevel, stats[speedStat] ?? baseSpeed),
    gcdUnmet,
    managedStats,
    elapsed: Date.now() - startTime,
  };
}
