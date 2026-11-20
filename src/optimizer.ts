// 自動配裝：在候選裝備、魔晶石、食物中找出每威力傷害期望最高的配置
// 純計算模組，不依賴 MobX 狀態，於 Web Worker 中執行（見 optimizer.worker.ts）
//
// 演算法概要：
// 1. 每件候選裝備列舉可使用孔洞的魔晶石分配（暴擊、信念、直擊、技速／詠速），
//    得到此裝備的屬性向量 [主屬性, 基本性能, 速度, 暴擊, 信念, 直擊, 堅韌]，並剔除完全劣勢的選項。
//    兩個戒指欄位合併為一層，以排除同一件唯一戒指被裝備兩次的組合。
//    速度只需達到 GCD 目標，超出部分視為等同（截斷後重新剔除劣勢選項）。
// 2. 每種食物各自搜尋（合成「各屬性取最大值」的樂觀食物會讓上界過鬆）。
//    先以小寬度的束搜尋（逐層展開、保留柏拉圖前緣）為每種食物找出可行解，作為初始下界與線性上界斜率的參考點。
// 3. 精確搜尋為深度優先分支定界（參考 bis.xivtc.com 的做法自行實作）：
//    - 一次只走一條路徑，記憶體只與部位數有關；每層依線性分數由高到低展開，找到更好的解立即用來剪枝
//    - 食物依束搜尋結果由好到壞處理，前一種食物的最佳解即為下一種食物的下界
//    - 上界有兩種，任一種低於目前最佳解即可剪枝：
//      剩餘部位在滿足速度需求下各屬性的最大值（便宜但寬鬆），以及
//      線性上界：各維度的 log 傷害因子以直線蓋住，線性分數可逐部位相加，以速度背包精確納入速度限制；
//      斜率以座標下降調整使起點上界最緊，基本性能則用單點斜率
//    - 暴擊依數值分段分別搜尋，段內使用該段專屬的直線，起點上界低於目前最佳解的段整段跳過
//    - 同一層累計屬性完全相同的節點只展開一次（換位表）
//    - 背包與後綴表依速度提供量分組計算，查表依食物快取，以降低準備成本
//    搜尋涵蓋所有不可能被上界排除的配置，結果為精確最佳解。
// 4. 深度優先不做劣勢剔除，在候選少而禁斷孔多的情境（大量魔晶石分配的傷害只差一點點）會慢上數十倍；
//    此時逐層展開（每層保留柏拉圖前緣、以同樣的上界剪枝）快得多。因此精確搜尋讓兩者輪流執行，
//    每輪時間上限加倍，先完成者即為結果；逐層展開會從中斷的層接續，深度優先找到的解則作為下界。
//
// 驗證：舊版實作保留於 test/optimizer/reference.ts（其結果記錄於 reference-results.json），
// 前一版（逐層展開的精確搜尋）保留於 test/optimizer/current-backup.ts，以 npm run test-optimizer 比對結果是否一致；
// npm run test-optimizer-fuzz 則以隨機情境（已鑲魔晶石、品級同步、自訂屬性等）與舊版比對，並從頭重算結果的傷害與 GCD。
//
// 已知的限制：
// - 堅韌魔晶石一律不鑲嵌（每點收益明顯低於其他屬性）；裝備本身的堅韌會精確計入傷害。
// - 幻境武器最終階段（795 品級，規則見 G.getRelicRule）的屬性分配一併最佳化：每種「兩大一小」的分配
//   各自是一個選項，與魔晶石選項一樣參與剔除與搜尋。可選屬性為受管理的屬性加上堅韌（坦克）：
//   魔晶石不鑲堅韌是因為每點收益低，但幻武的分配是在固定的幾種屬性中挑選，速度超出需求時
//   選堅韌可能比選技速更好，因此納入比較；信仰不影響傷害，不選。和目前已填入的分配不同時，
//   每個不同的屬性計為一次改動。
//   其他可自訂屬性的裝備（舊版本的幻境武器）沿用使用者已填入的自訂屬性。
// - 品級／等級同步下被同步的裝備（G.calcSyncedLevel）魔晶石失效，維持原有魔晶石不變。
//   等級同步時的基礎屬性、GCD 與傷害公式皆依 input.jobLevel 計算，與介面顯示共用同一套公式。

import * as G from './game';

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
  customStats?: G.Stats,  // 幻境武器最終階段的屬性分配，undefined 表示不更動
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
  customStats?: G.Stats,
}

interface Option {
  v: number[],
  raw?: number[],  // 速度截斷前的原始向量
  changes: number,  // 與目前配置的差異量，用於同分時偏好改動較少的方案
  choices: Choice[],
}

/** 搜尋中產生的候選狀態：目前為止各維度的總和，以及回溯用的來源狀態與選項索引 */
interface Candidate {
  m: number,  // 主屬性
  w: number,  // 基本性能
  spd: number,  // 速度（截斷於需求量）
  c: number,  // 暴擊
  d: number,  // 信念
  h: number,  // 直擊
  t: number,  // 堅韌
  changes: number,
  parent: number,
  option: number,
  ub: number,
}

/** 一層的存活狀態，以型別陣列儲存以降低記憶體用量（每個狀態約 40 位元組，物件則超過 100 位元組） */
interface LayerStates {
  n: number,
  m: Int32Array,
  w: Int32Array,
  spd: Int32Array,
  c: Int32Array,
  d: Int32Array,
  h: Int32Array,
  t: Int32Array,
  changes: Int32Array,
  parent: Int32Array,
  option: Int32Array,
}

function createLayerStates(size: number): LayerStates {
  return {
    n: 0,
    m: new Int32Array(size),
    w: new Int32Array(size),
    spd: new Int32Array(size),
    c: new Int32Array(size),
    d: new Int32Array(size),
    h: new Int32Array(size),
    t: new Int32Array(size),
    changes: new Int32Array(size),
    parent: new Int32Array(size),
    option: new Int32Array(size),
  };
}

// 狀態數上限：超過時中止計算並提示使用者縮小範圍，避免瀏覽器分頁因記憶體不足而崩潰
// 以此上限估計，計算所需記憶體約在 1 GB 以內
const MAX_STATES = 2_000_000;  // 每層剔除後的存活狀態
const MAX_LIVE_CANDIDATES = 4_000_000;  // 產生一層時同時存在的候選
const MAX_TRANSPOSITIONS = 3_000_000;  // 深度優先搜尋換位表的上限，超過時清空
export const TOO_MANY_STATES_MESSAGE = '可能的組合過多，請縮小品級範圍、隱藏部分裝備來源，或提高 GCD 目標後再試';

const CHANGE_GEAR = 1000;
const CRIT_BAND = 256;  // 線性上界中暴擊分段的寬度
const SLOPE_SPAN = 32;  // 線性上界斜率所用割線的半寬
// 精確搜尋中深度優先與逐層展開輪流執行，第一輪各自的時間上限（毫秒），之後每輪加倍
const EXACT_ROUND_START_MS = 250;
const BEAM_WIDTH = 50;  // 求初始下界與斜率參考點的束搜尋寬度；精確搜尋會迅速刷新下界，寬度不必大
const SLOPE_TUNING_ROUNDS = 4;  // 斜率座標下降的最多輪數
const SLOPE_TUNING_FACTORS = [0.7, 0.85, 0.93, 0.97, 1.03, 1.07, 1.15, 1.3];  // 每輪嘗試的斜率倍數
const CRIT_SLOPE_FACTORS = [1];  // 暴擊分段中背包使用的暴擊斜率（相對於段內割線斜率的倍數）；實測加入 0.5、0 並未收緊上界  // 更換一件裝備相當於改動 1000 顆魔晶石，優先保留目前裝備

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
  // 依各維度總和由大到小檢查：能支配某選項者總和必定不小於它，因此只需與已保留的前緣比較
  // （被前緣以外的選項支配時，該選項也必定被前緣中的某個選項支配）
  const sumOf = (option: Option) => option.v.reduce((sum, x) => sum + x, 0);
  const list = Array.from(unique.values()).sort((a, b) => sumOf(b) - sumOf(a));
  const front: Option[] = [];
  for (const option of list) {
    if (!front.some(kept => isDominated(option.v, kept.v))) front.push(option);
  }
  return front;
}

/** 同一組（主屬性、基本性能、速度、堅韌皆相同）內依暴擊、信念、直擊保留柏拉圖前緣，
 *  三者相同時保留改動較少者（與 Store.materiaOptimized 相同的階梯法） */
function paretoCandidates(states: Candidate[]): Candidate[] {
  states.sort((a, b) => b.c - a.c || b.d - a.d || b.h - a.h || b.t - a.t || a.changes - b.changes);
  const kept: Candidate[] = [];
  const stair: { d: number, h: number }[] = [];  // d strictly descending, h strictly ascending
  let prev: Candidate | undefined;
  for (const state of states) {
    if (prev !== undefined && prev.c === state.c && prev.d === state.d && prev.h === state.h) continue;
    prev = state;
    const { d, h } = state;
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

/** 跨速度剔除：主屬性、基本性能與堅韌相同時，速度不低、暴擊與信念都更高、直擊也不低的狀態一定不會更差。
 *  依速度由高到低掃描，以二維 Fenwick 樹記錄各（暴擊, 信念）分格的最大直擊。
 *  為控制記憶體，暴擊與信念依數值排名分成 CROSS_BINS 格，只比較「兩者分格都嚴格較高」的狀態：
 *  分格只會漏掉一部分可剔除的狀態，不會誤刪，結果仍然精確 */
const CROSS_BINS = 256;
function crossSpeedFilter(states: Candidate[]): Candidate[] {
  const groups = new Map<number, Candidate[]>();
  for (const state of states) {
    const key = (state.m * 1024 + state.w) * 8192 + state.t;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [state]); else group.push(state);
  }
  const kept: Candidate[] = [];
  const size = CROSS_BINS + 1;
  const tree = new Float64Array(size * size);
  for (const group of groups.values()) {
    if (group.length < 2) {
      kept.push(...group);
      continue;
    }
    const binsOf = (values: number[]) => {
      const unique = Array.from(new Set(values)).sort((a, b) => a - b);
      return new Map(unique.map((value, i) => [value, Math.floor(i * CROSS_BINS / unique.length)]));
    };
    const cBins = binsOf(group.map(s => s.c));
    const dBins = binsOf(group.map(s => s.d));
    group.sort((a, b) => b.spd - a.spd || b.c - a.c || b.d - a.d || b.h - a.h);
    tree.fill(-Infinity);
    for (const state of group) {
      // 分格倒置後，速度不低（先插入）且暴擊、信念分格都嚴格較高的狀態落在前綴 [1, x] × [1, y]
      const x = CROSS_BINS - 1 - cBins.get(state.c)!;
      const y = CROSS_BINS - 1 - dBins.get(state.d)!;
      let maxH = -Infinity;
      for (let i = x; i > 0; i -= i & -i) {
        for (let j = y; j > 0; j -= j & -j) {
          if (tree[i * size + j] > maxH) maxH = tree[i * size + j];
        }
      }
      if (maxH >= state.h) continue;
      kept.push(state);
      for (let i = x + 1; i <= CROSS_BINS; i += i & -i) {
        for (let j = y + 1; j <= CROSS_BINS; j += j & -j) {
          if (tree[i * size + j] < state.h) tree[i * size + j] = state.h;
        }
      }
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
  const relicStats: G.Stat[] = [...managedStats, 'TEN'];  // 幻境武器最終階段可分配的屬性（實際再依職業篩選）
  const dimStats: G.Stat[] = [attackMainStat, wdStat, speedStat, 'CRT', 'DET', 'DHT', 'TEN'];

  // ---- 1. 每件裝備的選項

  const gearOptions = (slot: number, gear: OptimizerGear): Option[] => {
    const relicRule = G.getRelicRule(gear.data, schema.stats);
    if (relicRule === undefined) return materiaOptions(slot, gear, gear.customStats, 0);
    // 幻境武器最終階段：每種分配各自列舉（沒有魔晶石孔，每種分配只有一個選項）
    const current = gear.customStats ?? {};
    const options = G.relicAllocations(relicRule, relicRule.stats.filter(stat => relicStats.includes(stat)))
      .flatMap(customStats => {
        const stats = new Set([...Object.keys(current), ...Object.keys(customStats)] as G.Stat[]);
        const changes = Array.from(stats).filter(stat => current[stat] !== customStats[stat]).length;
        return materiaOptions(slot, gear, customStats, changes)
          .map(option => ({ ...option, choices: option.choices.map(choice => ({ ...choice, customStats })) }));
      });
    return paretoOptions(options);
  };

  const materiaOptions = (slot: number, gear: OptimizerGear, customStats: G.Stats | undefined,
    customChanges: number): Option[] => {
    const { data } = gear;
    const syncedLevel = G.calcSyncedLevel(data, jobLevel, syncLevel);
    const statsOptions = { mainStat, secondaryStat: schema.secondaryStat, customStats, syncedLevel };
    // 基礎屬性中沒有的屬性（非坦克職業的堅韌）與介面的屬性合計一致，一律忽略
    const vectorOf = (stats: G.Stats) => dimStats.map(stat => baseStats[stat] === undefined ? 0 : stats[stat] ?? 0);
    const gearChange = (gear.equipped ? 0 : CHANGE_GEAR) + customChanges;

    const currentStats = gear.materias.map(m => m.stat);
    if (syncedLevel !== undefined) {
      // 魔晶石已失效，全部清除（屬性值不受影響，清除的顆數計入改動數）
      const stats = G.calcGearStats(data, { ...statsOptions, materiaStats: {} });
      const changes = gearChange + currentStats.filter(stat => stat !== undefined).length;
      const materiaStats = currentStats.map(() => undefined);
      return [{ v: vectorOf(stats), changes, choices: [{ slot, id: gear.id, materiaStats }] }];
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
  // 每種食物各自搜尋：若把多種食物合成一個「各屬性取最大值」的樂觀食物來估上界，
  // 上界會比任何真實食物都高，實測會讓大量狀態無法剔除
  let foodGroups = foods.flatMap(food => {
    const need = speedNeedOf(food);
    return need === undefined ? [] : [{ need, foods: [food] }];
  });
  if (foodGroups.length === 0) {
    // 無法達到 GCD 目標，改為在速度最大化的前提下最佳化傷害
    gcdUnmet = true;
    foodGroups = foods.map(food => ({ need: maxGearSpeed, foods: [food] }));
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

  interface NeedGroup {
    need: number,
    foods: (OptimizerFood | undefined)[],
  }

  /** 每組食物需求各自的上界估算工具（查表與拉格朗日上界依樂觀食物而不同） */
  interface GroupBound {
    need: number,
    foods: (OptimizerFood | undefined)[],
    crtTable: Float64Array,
    detTable: Float64Array,
    dhtTable: Float64Array,
    tenTable: Float64Array,
    mainTable: Float64Array,
    weaponBaseTable: Float64Array,
    linear?: LinearBound,
  }

  /** 線性上界（含速度背包與暴擊分段），見 runSearch 中的說明 */
  interface LinearBound {
    slopes: { m: number, w: number, d: number, h: number, t: number },
    bands: {
      lo: number,  // 此段涵蓋的暴擊（裝備提供量）範圍
      hi: number,
      // 同一段的數個等價上界，取最小者：背包中暴擊斜率 slopeC 不同，常數已補上差額
      variants: {
        slopeC: number,
        constant: number,  // log(0.01 × 職業特性) 加上各維度直線的截距（及暴擊斜率調整的補償）
        best: Float64Array[],  // best[i][r]：第 i 層之後，速度至少再提供 r 時的最大線性分數（速度背包）
      }[],
    }[],
  }

  // 上界估算的查表：各屬性（裝備提供量 x，含基礎值與食物）對應的傷害因子
  // 由共用的傷害公式逐值產生，並以與 calcDamage 相同的乘法順序組合，結果與 calcDamage 完全一致。
  // 查表只與食物有關：依食物快取，且食物沒有加成的屬性所有食物共用同一份
  interface Tables {
    crtTable: Float64Array,
    detTable: Float64Array,
    dhtTable: Float64Array,
    tenTable: Float64Array,
    mainTable: Float64Array,
    weaponBaseTable: Float64Array,  // 基本性能為 0 時的 weaponDamage（含青魔法師加成）
  }
  // 各維度的查表大小：各部位最大值的總和（速度截斷與重新剔除不會改變各維度的最大值）
  const tableSizeOf = (dim: number) => rawLayers.reduce((sum, options) => sum + Math.max(...options.map(o => o.v[dim])), 0) + 1;
  const valuesOf = (dim: number, food: G.Food | undefined) => {
    const stat = dimStats[dim];
    const base = baseStats[stat];
    return Array.from({ length: tableSizeOf(dim) }, (_, x) => {
      if (base === undefined && x === 0) return undefined;
      const raw = (base ?? 0) + x;
      return raw + foodAdd(food, stat, raw);
    });
  };
  const subTableOf = (dim: number, food: G.Food | undefined,
    pick: (d: ReturnType<typeof G.calcSubStatDamage>) => number) =>
    Float64Array.from(valuesOf(dim, food), value => pick(G.calcSubStatDamage(job, jobLevel,
      { CRT: value ?? 0, DET: value ?? 0, DHT: value ?? 0, TEN: dimStats[DIMS - 1] === 'TEN' ? value : undefined })));
  const mainTablesOf = (food: G.Food | undefined) => {
    const values = valuesOf(MAIN, food);
    const mainTable = new Float64Array(values.length);
    const weaponBaseTable = new Float64Array(values.length);
    values.forEach((value, x) => {
      const effects = G.calcDamage(job, jobLevel, { ...baseStats, [attackMainStat]: value, [wdStat]: 0 }, baseStats)!;
      mainTable[x] = effects.mainDamage;
      weaponBaseTable[x] = effects.weaponDamage;
    });
    return { mainTable, weaponBaseTable };
  };
  const buildTables = (food: G.Food | undefined): Tables => ({
    crtTable: subTableOf(CRT, food, d => (d.crtDamage - 1) * d.crtChance + 1),
    detTable: subTableOf(DET, food, d => d.detDamage),
    dhtTable: subTableOf(DHT, food, d => 0.25 * d.dhtChance + 1),
    tenTable: subTableOf(TEN, food, d => d.tenDamage),
    ...mainTablesOf(food),
  });
  const noFoodTables = buildTables(undefined);
  const tablesCache = new Map<string, Tables>();
  const tablesOf = (food: G.Food | undefined, key: string): Tables => {
    let tables = tablesCache.get(key);
    if (tables !== undefined) return tables;
    const boosts = (stat: G.Stat) => (food?.stats[stat] ?? 0) > 0;
    tables = {
      crtTable: boosts('CRT') ? subTableOf(CRT, food, d => (d.crtDamage - 1) * d.crtChance + 1) : noFoodTables.crtTable,
      detTable: boosts('DET') ? subTableOf(DET, food, d => d.detDamage) : noFoodTables.detTable,
      dhtTable: boosts('DHT') ? subTableOf(DHT, food, d => 0.25 * d.dhtChance + 1) : noFoodTables.dhtTable,
      tenTable: boosts('TEN') && dimStats[DIMS - 1] === 'TEN' ? subTableOf(TEN, food, d => d.tenDamage) : noFoodTables.tenTable,
      ...(boosts(attackMainStat) ? mainTablesOf(food) :
        { mainTable: noFoodTables.mainTable, weaponBaseTable: noFoodTables.weaponBaseTable }),
    };
    tablesCache.set(key, tables);
    return tables;
  };

  interface Best {
    v: number[],
    path: Option[],
    food: OptimizerFood | undefined,
    damage: number,
    changes: number,
  }
  const better = (a: Best | undefined, b: Best | undefined) =>
    b !== undefined && (a === undefined || b.damage > a.damage || (b.damage === a.damage && b.changes < a.changes)) ? b : a;
  const TIME_UP = new Error('time up');

  // 依速度需求快取：截斷後的選項層與後綴表（需求相同的食物共用）
  const layersCache = new Map<string, { layers: Option[][], suffix: Float64Array[] }>();

  const runSearch = (groups: NeedGroup[], lowerBound: number, beam: number, hint?: number[]) => {
    const maxNeed = Math.max(...groups.map(g => g.need));
    // suffix[i][r * width + j]：第 i 層之後，速度至少再提供 r 時，BOUND_DIMS[j] 的最大可能總和
    const width = BOUND_DIMS.length;
    const cacheKey = `${maxNeed}|${beam > 0}`;
    let prepared = layersCache.get(cacheKey);
    if (prepared === undefined) {
      // 速度超過需求量的部分沒有意義，截斷後重新剔除劣勢選項（需求為 0 時所有速度魔晶石選項都會被剔除）
      const layers = rawLayers.map(options => paretoOptions(options.map(option => option.v[SPD] <= maxNeed ? option :
        { ...option, v: option.v.map((x, k) => k === SPD ? maxNeed : x), raw: option.v })));
      // 逐層展開（束搜尋）時選項多的部位先處理，此時狀態數還少；深度優先時則選項少的部位先處理，分支較少
      layers.sort((a, b) => beam > 0 ? b.length - a.length : a.length - b.length);
      const suffix: Float64Array[] = [];
      suffix[layers.length] = new Float64Array((maxNeed + 1) * width).fill(-Infinity);
      suffix[layers.length].fill(0, 0, width);
      for (let i = layers.length - 1; i >= 0; i--) {
        const next = suffix[i + 1];
        const current = new Float64Array((maxNeed + 1) * width).fill(-Infinity);
        // 同一層速度提供量相同的選項，各維度只需要最大值：先分組可大幅減少計算量
        const bySpeed = new Map<number, number[]>();
        for (const option of layers[i]) {
          const maxima = bySpeed.get(option.v[SPD]);
          if (maxima === undefined) {
            bySpeed.set(option.v[SPD], BOUND_DIMS.map(dim => option.v[dim]));
          } else {
            BOUND_DIMS.forEach((dim, j) => { if (option.v[dim] > maxima[j]) maxima[j] = option.v[dim]; });
          }
        }
        for (let r = 0; r <= maxNeed; r++) {
          for (const [ speed, maxima ] of bySpeed) {
            const rest = Math.max(0, r - speed) * width;
            for (let j = 0; j < width; j++) {
              const value = maxima[j] + next[rest + j];
              if (value > current[r * width + j]) current[r * width + j] = value;
            }
          }
        }
        suffix[i] = current;
      }
      prepared = { layers, suffix };
      layersCache.set(cacheKey, prepared);
    }
    const { layers, suffix } = prepared;
    const feasibleGroups = groups.filter(g => suffix[0][g.need * width] !== -Infinity);
    if (feasibleGroups.length === 0) return undefined;

    const jM = BOUND_DIMS.indexOf(MAIN);
    const jW = BOUND_DIMS.indexOf(WD);
    const jC = BOUND_DIMS.indexOf(CRT);
    const jD = BOUND_DIMS.indexOf(DET);
    const jH = BOUND_DIMS.indexOf(DHT);
    const jT = BOUND_DIMS.indexOf(TEN);
    const trait = schema.traitDamageMultiplier!;

    const bounds: GroupBound[] = feasibleGroups.map(({ need, foods: groupFoods }) => {
      // 上界估算用的樂觀食物：取同組食物各屬性的最大上限與最大比例（目前每組只有一種食物，即該食物本身）
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
      const { crtTable, detTable, dhtTable, tenTable, mainTable, weaponBaseTable } =
        tablesOf(boundFood, groupFoods.map(food => food?.data.id ?? 0).join());

      // 線性上界（參考 bis.xivtc.com 的做法自行實作）：
      //   log 傷害 = log(0.01 × 職業特性) + Σ_d ψ_d(x_d)，ψ_d 為各維度（主屬性、基本性能、暴擊、信念、直擊、堅韌）的 log 傷害因子
      //   對每個維度取一條直線 ℓ_d(x) = a_d + b_d·x，截距 a_d = max_x [ψ_d(x) − b_d·x]，因此在整個值域上 ℓ_d ≥ ψ_d（取整造成的鋸齒也涵蓋在內）
      //   log 傷害 ≤ 常數 + Σ_d b_d·x_d，右側的「線性分數」可逐部位相加，
      //   預先以動態規劃算出「剩餘部位在速度至少達到 r 時的最大線性分數」（速度背包），速度限制因此精確地納入上界
      //   暴擊的 log 因子為凸函數，一條直線蓋住全段過於寬鬆，故每 CRIT_BAND 點分為一段，各段使用自己的直線與背包表，
      //   只計算最終暴擊可能落入的段；各段上界取最大值仍是合法上界，不影響結果的精確性
      //   斜率取下界解附近的割線斜率，使上界在最佳解附近最緊
      //   青魔法師的基本性能與智力相關，無法拆成獨立維度，不使用此上界
      let linear: LinearBound | undefined;
      if (hint !== undefined && lowerBound > 0 && job !== 'BLU') {
        const psiM = mainTable.map(Math.log);
        const weaponBase = weaponBaseTable[0];
        const psiW = Float64Array.from({ length: suffix[0][jW] + 1 }, (_, x) => Math.log(weaponBase + x));
        const psiC = crtTable.map(Math.log);
        const psiD = detTable.map(Math.log);
        const psiH = dhtTable.map(Math.log);
        const psiT = tenTable.map(Math.log);
        const secantSlope = (psi: Float64Array, x: number, span = SLOPE_SPAN) => {
          const lo = Math.max(0, Math.min(x, psi.length - 1) - span);
          const hi = Math.min(psi.length - 1, x + span);
          return hi > lo ? Math.max(0, (psi[hi] - psi[lo]) / (hi - lo)) : 0;
        };
        const interceptOf = (psi: Float64Array, slope: number, from = 0, to = psi.length - 1) => {
          let intercept = -Infinity;
          for (let x = from; x <= to; x++) intercept = Math.max(intercept, psi[x] - slope * x);
          return intercept;
        };
        type Slopes = LinearBound['slopes'];
        const baseOf = (sl: Slopes) => Math.log(0.01 * trait) + interceptOf(psiM, sl.m) + interceptOf(psiW, sl.w) +
          interceptOf(psiD, sl.d) + interceptOf(psiH, sl.h) + interceptOf(psiT, sl.t);
        const knapsack = (sl: Slopes, slopeC: number) => {
          const scoreOf = (v: number[]) => sl.m * v[MAIN] + sl.w * v[WD] + slopeC * v[CRT] +
            sl.d * v[DET] + sl.h * v[DHT] + sl.t * v[TEN];
          const best: Float64Array[] = [];
          best[layers.length] = new Float64Array(maxNeed + 1).fill(-Infinity);
          best[layers.length][0] = 0;
          for (let i = layers.length - 1; i >= 0; i--) {
            const next = best[i + 1];
            const current = new Float64Array(maxNeed + 1).fill(-Infinity);
            // 同一層速度提供量相同的選項，背包只需要分數最高者：先分組可大幅減少計算量（戒指層可達上千個選項）
            const bySpeed = new Map<number, number>();
            for (const option of layers[i]) {
              const score = scoreOf(option.v);
              if (score > (bySpeed.get(option.v[SPD]) ?? -Infinity)) bySpeed.set(option.v[SPD], score);
            }
            const speeds = Array.from(bySpeed.keys());
            const scores = speeds.map(speed => bySpeed.get(speed)!);
            for (let r = 0; r <= maxNeed; r++) {
              for (let k = 0; k < speeds.length; k++) {
                const value = scores[k] + next[Math.max(0, r - speeds[k])];
                if (value > current[r]) current[r] = value;
              }
            }
            best[i] = current;
          }
          return best;
        };
        const chordOf = (lo: number, hi: number) => hi > lo ? Math.max(0, (psiC[hi] - psiC[lo]) / (hi - lo)) : 0;

        // 斜率的選擇不影響正確性（任何斜率搭配對應截距都是合法上界），只影響上界的鬆緊。
        // 起點取下界解附近的割線斜率；但各維度斜率只要略有差異，背包就會把魔晶石全部換到斜率較高的屬性，
        // 而直線看不到報酬遞減，造成約 1% 的高估。因此以座標下降調整斜率，使起點（尚未選擇任何部位）的上界最小：
        // 上界 =（各維度截距）+（背包最大線性分數），對斜率是凸函數，逐維搜尋可穩定改善。
        // 調整時只用下界解所在的暴擊段估算，以控制計算量
        let slopes: Slopes = {
          m: secantSlope(psiM, hint[MAIN]),
          // 基本性能只來自武器，值域窄且 log 因子明顯彎曲，寬割線會讓直線在實際使用的數值上高估約 0.35%，
          // 改用該點的單點差分，使直線貼在下界解的基本性能上
          w: secantSlope(psiW, hint[WD], 1),
          d: secantSlope(psiD, hint[DET]),
          h: secantSlope(psiH, hint[DHT]),
          t: secantSlope(psiT, hint[TEN]),
        };
        {
          const lo = Math.floor(Math.min(hint[CRT], psiC.length - 1) / CRIT_BAND) * CRIT_BAND;
          const hi = Math.min(lo + CRIT_BAND - 1, psiC.length - 1);
          const chord = chordOf(lo, hi);
          const constantC = interceptOf(psiC, chord, lo, hi);
          const rootOf = (sl: Slopes) => baseOf(sl) + constantC + knapsack(sl, chord)[0][maxNeed];
          let current = rootOf(slopes);
          const tunedDims = (['d', 'h', 't'] as const).filter(k => slopes[k] > 0);  // 主屬性在起點必然取最高者，調整其斜率會損及中段的剔除能力
          for (let round = 0; round < SLOPE_TUNING_ROUNDS; round++) {
            let improved = false;
            for (const k of tunedDims) {
              for (const factor of SLOPE_TUNING_FACTORS) {
                const candidate = { ...slopes, [k]: slopes[k] * factor };
                const value = rootOf(candidate);
                if (value < current - 1e-12) {
                  current = value;
                  slopes = candidate;
                  improved = true;
                }
              }
            }
            if (!improved) break;
          }
        }
        const base = baseOf(slopes);
        const bands: LinearBound['bands'] = [];
        for (let lo = 0; lo < psiC.length; lo += CRIT_BAND) {
          const hi = Math.min(lo + CRIT_BAND - 1, psiC.length - 1);
          const chord = chordOf(lo, hi);
          const constant = base + interceptOf(psiC, chord, lo, hi);
          // 段內的直線為 a + b·x；對任意 0 ≤ s ≤ b 與段內的 x，a + b·x ≤ (a + (b − s)·hi) + s·x，
          // 因此背包可改用較小的暴擊斜率 s 並把差額補進常數，抑制「暴擊衝出此段」的配置使上界變鬆
          const variants = CRIT_SLOPE_FACTORS.map(factor => {
            const slopeC = chord * factor;
            return { slopeC, constant: constant + (chord - slopeC) * hi, best: knapsack(slopes, slopeC) };
          });
          bands.push({ lo, hi, variants });
        }
        linear = { slopes, bands };
      }

      return { need, foods: groupFoods, crtTable, detTable, dhtTable, tenTable, mainTable, weaponBaseTable, linear };
    });

    // ---- 精確搜尋：深度優先分支定界（參考 bis.xivtc.com 的做法自行實作）
    // 一次只走一條路徑，記憶體只與部位數有關；每層依線性分數由高到低展開，第一條路徑就接近貪婪解，
    // 一找到更好的解就立即用來剪枝。暴擊依段分別搜尋：段內只接受最終暴擊落在該段的配置，可使用該段專屬的直線，
    // 起點上界低於目前最佳解的段整段跳過。同一層累計屬性完全相同的節點只展開一次（換位表）。
    // 此搜尋不做柏拉圖剔除，所有屬性（含堅韌）都是精確比較
    // 超過 deadline 時中止，回傳目前找到的最佳解（complete 為 false）
    const depthFirst = (deadline: number, floor: number): { best: Best | undefined, complete: boolean } => {
      const bound = bounds[0];
      const { need } = bound;
      const food = bound.foods[0];
      const foodChange = food === undefined || food.equipped ? 0 : CHANGE_GEAR;
      const count = layers.length;
      const { crtTable, detTable, dhtTable, tenTable, mainTable, weaponBaseTable } = bound;
      const slopes = bound.linear?.slopes;
      const bands = bound.linear?.bands ?? [{ lo: 0, hi: Infinity, variants: [] }];

      let best: Best | undefined;
      let bestDamage = floor;  // 上界低於此值的分支不可能更好
      let work = 0;
      let logBest = Math.log(bestDamage) - 1e-9;
      const path = new Int32Array(count);

      const roots = bands.map(band => ({
        band,
        root: band.variants.length === 0 ? Infinity :
          Math.min(...band.variants.map(variant => variant.constant + variant.best[0][need])),
      })).sort((a, b) => b.root - a.root);

      try {
        for (const { band, root } of roots) {
          if (root < logBest) break;  // 依起點上界排序，之後的段都不可能更好
          const variants = band.variants;
          // 每層依此段的線性分數由高到低排序
          const scoreOf = (v: number[]) => slopes === undefined ? v[CRT] + v[DET] + v[DHT] :
            slopes.m * v[MAIN] + slopes.w * v[WD] + variants[0].slopeC * v[CRT] +
            slopes.d * v[DET] + slopes.h * v[DHT] + slopes.t * v[TEN];
          const orders = layers.map(layer => layer.map((_, o) => o)
            .sort((a, b) => scoreOf(layer[b].v) - scoreOf(layer[a].v)));
          const seen = layers.map(() => new Set<string>());
          let seenSize = 0;

          const visit = (i: number, m: number, w: number, spd: number, c: number, d: number, h: number, t: number,
            changes: number) => {
            if ((++work & 4095) === 0 && Date.now() > deadline) throw TIME_UP;
            if (i === count) {
              const damage = evaluate([ m, w, spd, c, d, h, t ], food?.data);
              const total = changes + foodChange;
              if (damage > bestDamage || (best === undefined && damage >= bestDamage) ||
                (best !== undefined && damage === best.damage && total < best.changes)) {
                best = {
                  v: [ m, w, spd, c, d, h, t ],
                  path: Array.from(path, (o, k) => layers[k][o]),
                  food,
                  damage,
                  changes: total,
                };
                bestDamage = damage;
                logBest = Math.log(bestDamage) - 1e-9;
              }
              return;
            }
            if (i > 0) {
              const key = `${m},${w},${spd},${c},${d},${h},${t}`;
              if (seen[i].has(key)) return;
              if (seenSize > MAX_TRANSPOSITIONS) {  // 換位表只是加速用，清空不影響正確性
                for (const set of seen) set.clear();
                seenSize = 0;
              }
              seen[i].add(key);
              seenSize++;
            }
            const rest = suffix[i + 1];
            const layer = layers[i];
            for (const o of orders[i]) {
              const ov = layer[o].v;
              const nspd = Math.min(spd + ov[SPD], maxNeed);
              const r = Math.max(0, need - nspd);
              const offset = r * width;
              if (rest[offset] === -Infinity) continue;  // 剩餘部位無法滿足速度需求
              const nc = c + ov[CRT];
              if (nc > band.hi || nc + rest[offset + jC] < band.lo) continue;  // 最終暴擊不可能落在此段
              const nm = m + ov[MAIN];
              const nw = w + ov[WD];
              const nd = d + ov[DET];
              const nh = h + ov[DHT];
              const nt = t + ov[TEN];
              const mu = nm + rest[offset + jM];
              const tu = nt + rest[offset + jT];
              const boxUb = 0.01 * (weaponBaseTable[mu] + nw + rest[offset + jW]) * mainTable[mu] *
                detTable[nd + rest[offset + jD]] * tenTable[tu] * trait *
                crtTable[Math.min(nc + rest[offset + jC], band.hi)] * dhtTable[nh + rest[offset + jH]];
              if (boxUb < bestDamage) continue;
              if (slopes !== undefined) {
                const prefix = slopes.m * nm + slopes.w * nw + slopes.d * nd + slopes.h * nh + slopes.t * nt;
                let pruned = false;
                for (const variant of variants) {
                  if (variant.constant + prefix + variant.slopeC * nc + variant.best[i + 1][r] < logBest) {
                    pruned = true;
                    break;
                  }
                }
                if (pruned) continue;
              }
              path[i] = o;
              visit(i + 1, nm, nw, nspd, nc, nd, nh, nt, changes + layer[o].changes);
            }
          };
          visit(0, 0, 0, 0, 0, 0, 0, 0, 0);
        }
      } catch (error) {
        if (error !== TIME_UP) throw error;
        return { best, complete: false };
      }
      return { best, complete: true };
    };

    // ---- 逐層展開：每層剔除劣勢狀態（柏拉圖前緣），beam > 0 時只保留上界最高的 beam 個（束搜尋）
    // 超過 deadline 時中止（complete 為 false），並記下已完成的層，下次呼叫時從中斷的那一層重新開始。
    // 已完成的層是以當時較低的下界剔除的，存活狀態只會比較多，接續使用不影響正確性
    interface LayeredProgress { i: number, previous: LayerStates, trail: { parent: Int32Array, option: Int32Array }[] }
    let progress: LayeredProgress | undefined;
    const layered = (deadline: number, floor: number): { best: Best | undefined, complete: boolean } => {
      const logLowerBound = Math.log(floor) - 1e-9;
      // 上一層的存活狀態（型別陣列），以及每一層回溯用的來源索引與選項索引
      let previous = progress?.previous ?? Object.assign(createLayerStates(1), { n: 1 });
      const trail = progress?.trail ?? [];
      for (let i = progress?.i ?? 0; i < layers.length; i++) {
        const rest = suffix[i + 1];
        const layer = layers[i];
        const buckets = new Map<number, { states: Candidate[], limit: number }>();
        let live = 0;
        for (let s = 0; s < previous.n; s++) {
          const sm = previous.m[s];
          const sw = previous.w[s];
          const ss = previous.spd[s];
          const sc = previous.c[s];
          const sd = previous.d[s];
          const sh = previous.h[s];
          const st = previous.t[s];
          const sChanges = previous.changes[s];
          if ((s & 255) === 0 && Date.now() > deadline) {
            progress = { i, previous, trail };
            return { best: undefined, complete: false };
          }
          for (let o = 0; o < layer.length; o++) {
            const ov = layer[o].v;
            const spd = Math.min(ss + ov[SPD], maxNeed);
            const m = sm + ov[MAIN];
            const w = sw + ov[WD];
            const c = sc + ov[CRT];
            const d = sd + ov[DET];
            const h = sh + ov[DHT];
            const t = st + ov[TEN];
            // 只要有任何一組食物需求可能勝出就保留
            let ub = -Infinity;
            for (const bound of bounds) {
              const offset = Math.max(0, bound.need - spd) * width;
              if (rest[offset] === -Infinity) continue;  // 剩餘部位無法滿足此組的速度需求
              const mu = m + rest[offset + jM];
              const wu = w + rest[offset + jW];
              const tu = t + rest[offset + jT];
              const boxUb = 0.01 * (bound.weaponBaseTable[mu] + wu) * bound.mainTable[mu] *
                bound.detTable[d + rest[offset + jD]] * bound.tenTable[tu] * trait *
                bound.crtTable[c + rest[offset + jC]] * bound.dhtTable[h + rest[offset + jH]];
              if (boxUb < floor) continue;
              if (bound.linear !== undefined) {
                const { slopes, bands } = bound.linear;
                const r = Math.max(0, bound.need - spd);
                const prefixScore = slopes.m * m + slopes.w * w + slopes.d * d + slopes.h * h + slopes.t * t;
                const cMax = c + rest[offset + jC];
                let possible = false;
                for (const band of bands) {
                  if (band.hi < c || band.lo > cMax) continue;  // 最終暴擊不可能落入此段
                  let bandPossible = true;
                  for (const variant of band.variants) {
                    if (variant.constant + prefixScore + variant.slopeC * c + variant.best[i + 1][r] < logLowerBound) {
                      bandPossible = false;
                      break;
                    }
                  }
                  if (bandPossible) {
                    possible = true;
                    break;
                  }
                }
                if (!possible) continue;
              }
              if (boxUb > ub) ub = boxUb;
              if (beam === 0) break;  // 精確搜尋只需知道可能勝出，不需排序用的上界
            }
            if (ub === -Infinity) continue;
            const key = ((m * 1024 + w) * 8192 + spd) * 8192 + t;
            let bucket = buckets.get(key);
            if (bucket === undefined) {
              bucket = { states: [], limit: 64 };
              buckets.set(key, bucket);
            }
            bucket.states.push({ m, w, spd, c, d, h, t, changes: sChanges + layer[o].changes, parent: s, option: o, ub });
            live++;
            if (bucket.states.length >= bucket.limit) {
              // 邊產生邊剔除劣勢狀態，避免先產生全部候選造成記憶體暴增
              live -= bucket.states.length;
              bucket.states = paretoCandidates(bucket.states);
              live += bucket.states.length;
              bucket.limit = Math.max(64, bucket.states.length * 2);
              if (live > MAX_LIVE_CANDIDATES) throw Error(TOO_MANY_STATES_MESSAGE);
            }
          }
        }
        let states: Candidate[] = [];
        for (const bucket of buckets.values()) {
          for (const state of bucket.states.length > 1 ? paretoCandidates(bucket.states) : bucket.states) states.push(state);
        }
        buckets.clear();
        states = crossSpeedFilter(states);
        if (beam > 0 && states.length > beam) {
          states.sort((a, b) => b.ub - a.ub);
          states.length = beam;
        }
        if (states.length > MAX_STATES) throw Error(TOO_MANY_STATES_MESSAGE);
        const next = createLayerStates(states.length);
        states.forEach((state, k) => {
          next.m[k] = state.m;
          next.w[k] = state.w;
          next.spd[k] = state.spd;
          next.c[k] = state.c;
          next.d[k] = state.d;
          next.h[k] = state.h;
          next.t[k] = state.t;
          next.changes[k] = state.changes;
          next.parent[k] = state.parent;
          next.option[k] = state.option;
        });
        next.n = states.length;
        trail.push({ parent: next.parent, option: next.option });
        previous = next;
      }

      let best: Best | undefined;
      for (let s = 0; s < previous.n; s++) {
        const v = [previous.m[s], previous.w[s], previous.spd[s], previous.c[s], previous.d[s], previous.h[s], previous.t[s]];
        for (const bound of bounds) {
          if (v[SPD] < bound.need) continue;
          for (const food of bound.foods) {
            const damage = evaluate(v, food?.data);
            const changes = previous.changes[s] + (food === undefined || food.equipped ? 0 : CHANGE_GEAR);
            if (best === undefined || damage > best.damage || (damage === best.damage && changes < best.changes)) {
              const path: Option[] = [];
              for (let i = layers.length - 1, k = s; i >= 0; k = trail[i].parent[k], i--) {
                path.push(layers[i][trail[i].option[k]]);
              }
              best = { v, path, food, damage, changes };
            }
          }
        }
      }
      return { best, complete: true };
    };

    if (beam > 0) return layered(Infinity, lowerBound).best;

    // ---- 精確搜尋：深度優先與逐層展開交替執行
    // 兩者各有擅長的情境：候選裝備多時深度優先快得多（逐層展開的狀態數暴增），
    // 但候選少而每件裝備孔洞多（禁斷）時，大量魔晶石分配的傷害只差一點點，上界剪不掉，
    // 深度優先必須逐一走過，逐層展開則能以柏拉圖前緣合併這些組合（實測同一情境 110 秒對 5 秒）。
    // 無法事先判斷哪一種較快，因此兩者輪流執行、每輪時間上限加倍，先完成者即為結果，
    // 總耗時約為較快者的數倍以內。深度優先中途找到的解立即作為之後各輪的下界。
    // 兩者都是精確搜尋，哪一個先完成都不影響傷害結果（只可能影響同分時選到哪一組）。
    let found: Best | undefined;
    let floor = lowerBound;
    let layeredUsable = true;
    const take = (result: Best | undefined) => {
      found = better(found, result);
      if (found !== undefined && found.damage > floor) floor = found.damage;
    };
    for (let round = EXACT_ROUND_START_MS; ; round *= 2) {
      const dfs = depthFirst(layeredUsable ? Date.now() + round : Infinity, floor);
      take(dfs.best);
      if (dfs.complete) return found;
      try {
        const lay = layered(Date.now() + round, floor);
        take(lay.best);
        if (lay.complete) return found;
      } catch (error) {
        // 逐層展開的狀態數超過記憶體上限：之後只用深度優先（不設上限）
        if (!(error instanceof Error && error.message === TOO_MANY_STATES_MESSAGE)) throw error;
        layeredUsable = false;
      }
    }
  };

  // 各組食物需求分開搜尋：實測合併成一次搜尋（速度截斷於最大需求）時狀態數更多，多數情境反而較慢
  const groups = foodGroups;
  // 先以小寬度的束搜尋為每種食物找出可行解：作為初始下界，並作為線性上界斜率的參考點（使上界在該食物的最佳解附近最緊）。
  // 精確搜尋依束搜尋結果由好到壞處理食物，且每種食物找到的最佳解立即成為下一種食物的下界
  const beamResults = groups.map(group => runSearch([group], 0, BEAM_WIDTH));
  let best: Best | undefined;
  for (const result of beamResults) best = better(best, result);
  const order = groups.map((_, k) => k)
    .sort((a, b) => (beamResults[b]?.damage ?? -Infinity) - (beamResults[a]?.damage ?? -Infinity));
  for (const k of order) {
    if (best === undefined) break;
    const hint = (beamResults[k] ?? best).v;
    best = better(best, runSearch([groups[k]], best.damage, 0, hint));  // 精確搜尋
  }
  if (best === undefined) throw Error('找不到可行的配置');

  // ---- 5. 輸出

  const gears: OptimizerGearResult[] = [];
  const totals: number[] = new Array(DIMS).fill(0);  // 狀態中的速度已截斷於需求量，需以實際選項重新加總
  for (const option of best.path) {
    gears.push(...option.choices);
    (option.raw ?? option.v).forEach((x, k) => { totals[k] += x; });
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
