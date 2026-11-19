// 自動配裝最佳化的隨機交叉驗證：以固定種子產生大量隨機情境，同時用新版（src/optimizer.ts）與
// 舊版（test/optimizer/reference.ts，不使用上界剪枝的逐層柏拉圖前緣搜尋）計算，確認傷害期望完全相同
// （舊版的堅韌只在平手時比較，坦克允許新版較高）；另以本檔的精確對照（七個維度完整剔除、魔晶石直接窮舉）確認新版為最佳解；
// 並依「套用此配置」的規則（受管理屬性鑲最高等級、其餘魔晶石保留原等級）從頭重算新版結果的屬性、
// 傷害與 GCD，確認結果確實可行且數值正確。
//
// 隨機情境涵蓋固定情境沒有的條件：已裝備且已鑲有魔晶石（含堅韌、信仰等非管理屬性）的裝備、
// 篩選範圍外的已裝備裝備、幻境武器的自訂屬性、品級同步、等級同步（約兩成情境，職業等級 60 級以上）、
// 任意食物組合、各種 GCD 目標與禁斷孔數。
// 每個部位只隨機取少量候選裝備，讓舊版也能在合理時間內算完。
// 幻境武器最終階段的屬性分配由新版最佳化；舊版與精確對照改用展開成各種分配的候選（見 relic.ts），
// 驗證時也確認新版結果帶有符合規則的分配。
//
// 精確對照的結果記錄於 exhaustive-results.json（以種子與情境編號為索引，並附上輸入的雜湊）並直接沿用，
// 跑過的情境不必重跑；輸入改變（遊戲資料更新、情境產生方式改變）時雜湊不符，會重新執行。
// 精確對照預設每個情境最多 60 秒，逾時只標示未能確認、不寫入紀錄；可用 --exhaustive-time=0（不設上限）
// 搭配 --only 單獨補跑。精確對照的演算法改動後，以 --refresh-exhaustive 全部重新執行。
//
// 用法：npm run test-optimizer-fuzz -- [--cases=500] [--seed=1] [--exhaustive] [--only=編號,...]
//       [--exhaustive-time=秒] [--refresh-exhaustive]

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as G from '../../src/game';
import * as current from '../../src/optimizer';
import * as reference from './reference';
import { expandRelics, relicAllocationsFor, sameStats } from './relic';
import type { OptimizerGear, OptimizerInput, OptimizerResult } from '../../src/optimizer';

/* eslint-disable @typescript-eslint/no-require-imports */
const loadGears = (files: string[]): G.Gear[] => Array.from(new Map(files
  .flatMap(file => require(`../../data/out/${file}`).default as G.Gear[])
  .map(gear => [gear.id, gear])).values());
const recentGearFiles = ['gears-recent', 'gears-730', 'gears-661', 'gears-645'];
const gearData = loadGears(recentGearFiles);
// 等級同步情境另外載入 60 級以後的舊裝備（一般情境沿用上面的資料，避免改變既有情境的輸入）
const syncGearData = loadGears([...recentGearFiles,
  'gears-600', 'gears-531', 'gears-515', 'gears-470', 'gears-401', 'gears-385', 'gears-340', 'gears-271']);
const foodData = require('../../data/out/foods').default as G.Food[];
/* eslint-enable @typescript-eslint/no-require-imports */

const argValue = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const caseCount = Number(argValue('cases') ?? 500);
const seed = Number(argValue('seed') ?? 1);
// 精確對照較慢，預設只在需要時執行（坦克且新版高於舊版）；加上 --exhaustive 則每個情境都執行
const exhaustiveAll = process.argv.includes('--exhaustive');
const only = argValue('only')?.split(',').map(Number);  // 只執行指定編號的情境並列出詳細結果（除錯用）
const exhaustiveTimeLimitMs = Number(argValue('exhaustive-time') ?? 60) * 1000 || Infinity;  // 0 表示不設上限
const refreshExhaustive = process.argv.includes('--refresh-exhaustive');

interface ExhaustiveRecord {
  fingerprint: string,
  description: string,
  exact: number,  // 精確最佳的傷害期望
  elapsed: number,  // 精確對照的耗時（毫秒）
  recordedAt: string,
}
// 打包後此檔案位於 dist/ 底下，記錄檔放在原始碼目錄（test/optimizer/）以便納入版本控制
const exhaustivePath = path.resolve(path.dirname(__filename), '..', 'exhaustive-results.json');
const exhaustiveRecords: Record<string, ExhaustiveRecord> = fs.existsSync(exhaustivePath) ?
  JSON.parse(fs.readFileSync(exhaustivePath, 'utf8')).results : {};
const saveExhaustiveRecords = () => {
  const sorted = Object.fromEntries(Object.entries(exhaustiveRecords).sort(([ a ], [ b ]) => {
    const [ seedA, caseA ] = a.split('#').map(Number);
    const [ seedB, caseB ] = b.split('#').map(Number);
    return seedA - seedB || caseA - caseB;
  }));
  fs.writeFileSync(exhaustivePath, JSON.stringify({
    說明: '精確對照（fuzz.ts 的 exhaustive）在各隨機情境的結果，索引為「種子#情境編號」，由 fuzz.ts 自動維護；' +
      'fingerprint 為輸入的雜湊，不符時會重新執行',
    results: sorted,
  }, null, 2) + '\n');
};
const fingerprintOf = (input: OptimizerInput) =>
  crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 16);

function mulberry32(initial: number) {
  let a = initial;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const jobs = (Object.keys(G.jobSchemas) as G.Job[]).filter(job => {
  const schema = G.jobSchemas[job] as G.JobSchema;
  return schema.mainStat !== undefined && schema.traitDamageMultiplier !== undefined &&
    (G.jobLevelModifiers as Record<number, unknown>)[schema.jobLevel] !== undefined;
});
const maxLevels = [795, 790, 780, 770, 760, 750, 740, 730, 720, 710, 700, 690, 680, 665];

/**
 * levelSynced 為 true 時產生等級同步情境：職業等級低於該職業的上限，並隨機搭配該等級的品級同步或僅同步等級，
 * 候選裝備取同步品級附近（已裝備的裝備可能是會被同步的高品級裝備）。為 false 時的亂數使用順序與先前完全相同。
 */
function buildRandomInput(rand: () => number, caseSeed: number, levelSynced = false): OptimizerInput & { description: string } {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const shuffled = <T>(list: T[]) => {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ copy[i], copy[j] ] = [ copy[j], copy[i] ];
    }
    return copy;
  };

  const job = pick(levelSynced ? jobs.filter(j => (G.jobSchemas[j] as G.JobSchema).jobLevel > 60) : jobs);
  const schema = G.jobSchemas[job] as G.JobSchema;
  const jobLevel = levelSynced ? pick(G.jobLevels.filter(level => level >= 60 && level < schema.jobLevel)) :
    schema.jobLevel;
  const levelModifier = G.jobLevelModifiers[jobLevel];
  const baseStats: G.Stats = { PDMG: 0, MDMG: 0, DLY: 0 };
  for (const stat of schema.stats) {
    const baseStat = G.baseStats[stat] ?? 0;
    baseStats[stat] = typeof baseStat === 'number' ? baseStat :
      G.floor(levelModifier[baseStat] * ((schema.statModifiers as G.Stats | undefined)?.[stat] ?? 100) / 100) +
      (G.clanStats[stat]?.[0] ?? 0);
  }
  const speedStat: G.Stat = schema.stats.includes('SPS') ? 'SPS' : 'SKS';
  const meldStats: G.Stat[] = ['CRT', 'DET', 'DHT', speedStat, speedStat === 'SPS' ? 'SKS' : 'SPS', 'TEN', 'PIE'];

  let maxLevel: number;
  let minLevel: number;
  let syncLevel: number | undefined;
  // 品級同步只能選介面提供的同步品級（G.syncLevels），其他品級沒有對應的屬性上限表
  if (levelSynced) {
    syncLevel = rand() < 0.7 && G.syncLevels[jobLevel].length > 0 ? pick(G.syncLevels[jobLevel]) : undefined;
    const center = syncLevel ?? G.syncLevelOfJobLevels[jobLevel];
    maxLevel = center + randInt(0, 40);
    minLevel = center - randInt(0, 30);
  } else {
    maxLevel = pick(maxLevels);
    minLevel = maxLevel - randInt(0, 30);
    const syncCandidates = G.syncLevels[jobLevel].filter(level => level <= maxLevel && level >= maxLevel - 60);
    syncLevel = rand() < 0.2 ? pick(syncCandidates.length > 0 ? syncCandidates : [undefined]) : undefined;
  }
  const gcdTarget = randInt(levelSynced ? 225 : 200, 250) / 100;
  const overmeldLimit = randInt(0, 5);
  // 與介面相同，可裝備等級只受職業等級上限限制（等級同步時高於同步等級的裝備會被同步）
  const jobGears = (levelSynced ? syncGearData : gearData).filter(gear => G.jobCategories[gear.jobCategory][job] &&
    gear.equipLevel <= schema.jobLevel && !gear.obsolete);

  let nextInstance = 1;
  const makeGear = (data: G.Gear, slot: number, equipped: boolean): OptimizerGear => {
    const materias = Array.from({ length: data.materiaAdvanced ? 5 : data.materiaSlot }, (_, index) => {
      const grade = G.materiaTopGrade(data, index);
      if (!equipped || grade === undefined || rand() < 0.4) return {};
      const stat = pick(meldStats);
      return { stat, grade: Math.max(1, grade - pick([0, 0, 0, 1, 2])) as G.MateriaGrade };
    });
    const customStats: G.Stats | undefined = data.customizable ? {} : undefined;
    if (customStats !== undefined && rand() < 0.7) {
      for (const stat of shuffled(['CRT', 'DET', 'DHT', speedStat] as G.Stat[]).slice(0, randInt(1, 3))) {
        customStats[stat] = randInt(0, 447);
      }
    }
    // 實例 ID 不必等於裝備 ID，第二個戒指欄位為負數
    const id = ((slot < 0 ? -1 : 1) * (data.id * 100 + nextInstance++)) as G.GearId;
    return { id, data, customStats, materias, equipped };
  };

  const slots = schema.slots.filter(s => s.slot > 0 || s.slot === -12).map(({ slot }) => {
    const ofSlot = jobGears.filter(gear => gear.slot === Math.abs(slot));
    const inRange = ofSlot.filter(gear => gear.level >= minLevel && gear.level <= maxLevel);
    const gears = shuffled(inRange).slice(0, randInt(0, 4)).map(data => makeGear(data, slot, false));
    if (rand() < 0.4 && ofSlot.length > 0) {
      // 已裝備的裝備：可能在範圍外，也可能與候選相同
      const data = rand() < 0.5 && inRange.length > 0 ? pick(inRange) : pick(ofSlot);
      gears.push(makeGear(data, slot, true));
    }
    return { slot, gears };
  });

  const foodCenter = syncLevel ?? G.syncLevelOfJobLevels[jobLevel];
  const jobFoods = foodData.filter(food => food.slot === -1 && G.jobCategories[food.jobCategory][job] &&
    (levelSynced ? food.level >= foodCenter - 120 && food.level <= foodCenter + 40 : food.level >= 600));
  const foodCount = randInt(0, 5);
  const foods = shuffled(jobFoods).slice(0, foodCount).map((data, k) => ({ data, equipped: k === 0 && rand() < 0.3 }));

  const description = `#${caseSeed} ${job}${levelSynced ? ` ${jobLevel}級` : ''} ${minLevel}-${maxLevel} GCD${gcdTarget.toFixed(2)} 禁斷${overmeldLimit}` +
    `${syncLevel !== undefined ? ` 同步${syncLevel}` : ''} 食物${foods.length} ` +
    `候選${slots.map(s => s.gears.length).join('/')}`;
  return { job, jobLevel, syncLevel, baseStats, slots, foods, gcdTarget, overmeldLimit, description };
}

/** 依「套用此配置」的規則計算一件裝備的屬性：受管理屬性鑲該孔最高等級，其餘魔晶石保留原等級；materiaStats 為 undefined 時不更動 */
function gearStatsOf(input: OptimizerInput, gear: OptimizerGear, materiaStats: (G.Stat | undefined)[] | undefined,
  managedStats: G.Stat[], problems?: string[], customStats = gear.customStats): G.Stats {
  const schema = G.jobSchemas[input.job] as G.JobSchema;
  const materiaTotals: G.Stats = {};
  gear.materias.forEach((materia, index) => {
    let stat: G.Stat | undefined;
    let grade: G.MateriaGrade | undefined;
    if (materiaStats === undefined) {
      stat = materia.stat;
      grade = materia.grade;
    } else {
      stat = materiaStats[index];
      if (stat === undefined) return;
      if (managedStats.includes(stat)) {
        grade = G.materiaTopGrade(gear.data, index);
        if (grade === undefined) problems?.push(`第 ${index + 1} 孔無法鑲嵌魔晶石`);
        if (index >= gear.data.materiaSlot + input.overmeldLimit) problems?.push('超出禁斷孔數');
        if (stat === 'TEN') problems?.push('鑲了堅韌');
      } else {
        if (stat !== materia.stat) problems?.push(`第 ${index + 1} 孔的非管理屬性被改動`);
        grade = materia.grade;
      }
    }
    if (stat !== undefined && grade !== undefined) {
      materiaTotals[stat] = (materiaTotals[stat] ?? 0) + G.materias[stat]![grade - 1];
    }
  });
  return G.calcGearStats(gear.data, {
    mainStat: schema.mainStat,
    secondaryStat: schema.secondaryStat,
    customStats,
    syncedLevel: G.calcSyncedLevel(gear.data, input.jobLevel, input.syncLevel),
    materiaStats: materiaTotals,
  });
}

/** 與介面相同的屬性合計（基礎屬性中沒有的屬性不計）與食物加成 */
function finalStatsOf(input: OptimizerInput, totals: G.Stats, food: G.Food | undefined): G.Stats {
  const stats: G.Stats = { ...input.baseStats };
  for (const [ stat, value ] of Object.entries(totals) as [G.Stat, number][]) {
    if (stats[stat] !== undefined) stats[stat] = stats[stat]! + value;
  }
  if (food !== undefined) {
    for (const [ stat, max ] of Object.entries(food.stats) as [G.Stat, number][]) {
      if (stats[stat] === undefined) continue;
      const rate = food.statRates[stat];
      stats[stat] = stats[stat]! + (rate === undefined ? max : Math.min(max, G.floor(stats[stat]! * rate / 100)));
    }
  }
  return stats;
}

/** 依「套用此配置」的規則從頭重算結果的傷害與 GCD，回傳發現的問題 */
function validate(input: OptimizerInput, result: OptimizerResult): string[] {
  const problems: string[] = [];
  const totals: G.Stats = {};
  const usedSlots = new Set<number>();
  for (const { slot, id, materiaStats, customStats } of result.gears) {
    const gear = input.slots.find(s => s.slot === slot)?.gears.find(g => g.id === id);
    if (gear === undefined) {
      problems.push(`部位 ${slot} 選了不在候選中的裝備 ${id}`);
      continue;
    }
    if (usedSlots.has(slot)) problems.push(`部位 ${slot} 選了兩次`);
    usedSlots.add(slot);
    const gearProblems: string[] = [];
    // 幻境武器最終階段必須帶有符合規則的分配（展開後的候選本身已帶有固定的分配），其他裝備不得更動自訂屬性
    const allocations = relicAllocationsFor(input.job, gear.data);
    const effective = customStats ?? gear.customStats ?? {};
    if (allocations === undefined ? customStats !== undefined : !allocations.some(a => sameStats(a, effective))) {
      gearProblems.push(`自訂屬性 ${JSON.stringify(effective)} 不符規則`);
    }
    const stats = gearStatsOf(input, gear, materiaStats, result.managedStats, gearProblems, customStats ?? gear.customStats);
    problems.push(...gearProblems.map(problem => `部位 ${slot} ${problem}`));
    for (const [ stat, value ] of Object.entries(stats) as [G.Stat, number][]) {
      totals[stat] = (totals[stat] ?? 0) + value;
    }
  }
  const rings = result.gears.filter(g => Math.abs(g.slot) === 12)
    .map(g => input.slots.find(s => s.slot === g.slot)!.gears.find(x => x.id === g.id)?.data);
  if (rings.length === 2 && rings[0]?.id === rings[1]?.id && rings[0]?.unique) problems.push('同一件唯一戒指裝備兩次');

  const food = input.foods.find(f => f.data.id === result.foodId)?.data;
  if (result.foodId !== undefined && food === undefined) problems.push(`食物 ${result.foodId} 不在候選中`);
  const stats = finalStatsOf(input, totals, food);
  const damage = G.calcDamage(input.job, input.jobLevel, stats, input.baseStats)!.damage;
  if (Math.abs(damage - result.damage) > 1e-9 * Math.abs(damage)) {
    problems.push(`重算傷害 ${damage} 與結果 ${result.damage} 不符`);
  }
  const gcd = G.calcGcd(input.job, input.jobLevel, stats[result.speedStat] ?? 0);
  if (Math.abs(gcd - result.gcd) > 1e-9) problems.push(`重算 GCD ${gcd} 與結果 ${result.gcd} 不符`);
  if (!result.gcdUnmet && Math.round(gcd * 100) > Math.round(input.gcdTarget * 100)) {
    problems.push(`GCD ${gcd} 未達目標 ${input.gcdTarget}`);
  }
  return problems;
}

/**
 * 精確對照：逐部位合併並剔除「七個維度（含速度與堅韌）都不優於另一個狀態」的狀態。
 * 傷害對每個維度都是單調不減，速度則截斷於需求量，因此這樣剔除不會失去最佳解。
 * 另以最簡單的盒狀上界剪枝：目前狀態加上「其餘每個部位各維度的最大值」仍低於 lowerBound 的狀態直接剔除。
 * lowerBound 傳入新版結果的傷害（其可行性另由 validate 確認），因此只要存在比新版更好的配置就一定會被找到。
 * 與最佳化器完全分開實作（只共用遊戲公式），魔晶石直接窮舉每個可用孔洞的四種屬性。
 * 狀態數超過上限時回傳 undefined（略過）；超過時間上限時拋出 EXHAUSTIVE_TIMEOUT
 */
const EXHAUSTIVE_TIMEOUT = new Error('精確對照逾時');
function exhaustive(input: OptimizerInput, lowerBound = -Infinity, timeLimitMs = 60_000,
  stateLimit = 300_000): number | undefined {
  const deadline = Date.now() + timeLimitMs;
  let checks = 0;
  const checkTime = () => {
    if ((++checks & 1023) === 0 && Date.now() > deadline) throw EXHAUSTIVE_TIMEOUT;
  };
  const schema = G.jobSchemas[input.job] as G.JobSchema;
  const mainStat = schema.mainStat!;
  const speedStat: G.Stat = schema.stats.includes('SPS') ? 'SPS' : 'SKS';
  const managedStats: G.Stat[] = ['CRT', 'DET', 'DHT', speedStat];
  const dims: G.Stat[] = [mainStat === 'VIT' ? 'STR' : mainStat, mainStat === 'MND' || mainStat === 'INT' ? 'MDMG' : 'PDMG',
    speedStat, 'CRT', 'DET', 'DHT', 'TEN'];
  const SPD = 2;
  const vectorOf = (stats: G.Stats) => dims.map(stat => input.baseStats[stat] === undefined ? 0 : stats[stat] ?? 0);
  const prune = (vectors: number[][]) => {
    const unique = Array.from(new Map(vectors.map(v => [v.join(), v])).values());
    const sumOf = (v: number[]) => v.reduce((x, y) => x + y, 0);
    unique.sort((a, b) => sumOf(b) - sumOf(a));
    const front: number[][] = [];
    const n = dims.length;
    for (const v of unique) {
      checkTime();
      let dominated = false;
      for (let f = 0; f < front.length && !dominated; f++) {
        const u = front[f];
        let k = 0;
        while (k < n && u[k] >= v[k]) k++;
        dominated = k === n;
      }
      if (!dominated) front.push(v);
    }
    return front;
  };
  const optionsOf = (gear: OptimizerGear) => {
    if (G.calcSyncedLevel(gear.data, input.jobLevel, input.syncLevel) !== undefined) {
      return [vectorOf(gearStatsOf(input, gear, undefined, managedStats))];
    }
    const base = gear.materias.map(m => m.stat !== undefined && !managedStats.includes(m.stat) ? m.stat : undefined);
    const free = gear.materias.map((_, index) => index)
      .filter(index => base[index] === undefined && index < gear.data.materiaSlot + input.overmeldLimit &&
        G.materiaTopGrade(gear.data, index) !== undefined);
    const vectors: number[][] = [];
    for (let code = 0; code < 4 ** free.length; code++) {
      const materiaStats = base.slice();
      free.forEach((index, k) => { materiaStats[index] = managedStats[Math.floor(code / 4 ** k) % 4]; });
      vectors.push(vectorOf(gearStatsOf(input, gear, materiaStats, managedStats)));
    }
    return prune(vectors);
  };
  const zero = [new Array(dims.length).fill(0) as number[]];
  const layers: number[][][] = [];
  for (const { slot, gears } of input.slots) {
    if (Math.abs(slot) === 12) continue;
    layers.push(gears.length === 0 ? zero : prune(gears.flatMap(optionsOf)));
  }
  const ringSlots = input.slots.filter(s => Math.abs(s.slot) === 12);
  if (ringSlots.length === 2) {
    const [ a, b ] = ringSlots.map(s => s.gears.map(gear => ({ gear, options: optionsOf(gear) })));
    const pairs: number[][] = [];
    for (const x of a) {
      for (const y of b) {
        if (x.gear.data.id === y.gear.data.id && x.gear.data.unique) continue;
        for (const u of x.options) for (const v of y.options) pairs.push(u.map((value, k) => value + v[k]));
      }
    }
    layers.push(pairs.length === 0 ? zero : prune(pairs));
  }

  const baseSpeed = input.baseStats[speedStat] ?? 0;
  const maxGearSpeed = layers.reduce((sum, options) => sum + Math.max(...options.map(v => v[SPD])), 0);
  const foods = input.foods.length > 0 ? input.foods.map(f => f.data) : [undefined];
  const reaches = (gearSpeed: number, food: G.Food | undefined) => {
    const speed = finalStatsOf(input, { [speedStat]: gearSpeed }, food)[speedStat] ?? baseSpeed;
    return Math.round(G.calcGcd(input.job, input.jobLevel, speed) * 100) <= Math.round(input.gcdTarget * 100);
  };
  let needs = foods.map(food => {
    for (let g = 0; g <= maxGearSpeed; g++) if (reaches(g, food)) return g;
    return undefined;
  });
  if (needs.every(need => need === undefined)) needs = foods.map(() => maxGearSpeed);  // 無法達到 GCD 目標時改為速度最大化

  const damageOf = (v: number[], food: G.Food | undefined) => {
    const totals: G.Stats = {};
    dims.forEach((stat, d) => { if (d !== SPD) totals[stat] = v[d]; });
    return G.calcDamage(input.job, input.jobLevel, finalStatsOf(input, totals, food), input.baseStats)!.damage;
  };
  // suffixMax[i]：第 i 層之後（含）每個維度可再增加的最大值
  const suffixMax = layers.map(() => new Array(dims.length).fill(0) as number[]);
  suffixMax.push(new Array(dims.length).fill(0) as number[]);
  for (let i = layers.length - 1; i >= 0; i--) {
    suffixMax[i] = suffixMax[i + 1].map((x, d) => x + Math.max(...layers[i].map(v => v[d])));
  }
  const threshold = lowerBound - 1e-12 * Math.abs(lowerBound);

  let best = -Infinity;
  for (const need of new Set(needs.filter((x): x is number => x !== undefined))) {
    const needFoods = foods.filter((_, k) => needs[k] === need);
    let states = zero;
    for (let i = 0; i < layers.length; i++) {
      if (states.length * layers[i].length > 20_000_000) return undefined;
      const next: number[][] = [];
      for (const state of states) {
        checkTime();
        for (const option of layers[i]) {
          const v = state.map((x, k) => x + option[k]);
          v[SPD] = Math.min(v[SPD], need);
          const optimistic = v.map((x, k) => x + suffixMax[i + 1][k]);
          if (optimistic[SPD] < need) continue;
          if (threshold > -Infinity && needFoods.every(food => damageOf(optimistic, food) < threshold)) continue;
          next.push(v);
        }
      }
      states = prune(next);
      if (states.length > stateLimit) return undefined;
    }
    for (const food of needFoods) {
      for (const v of states) {
        if (v[SPD] < need) continue;
        best = Math.max(best, damageOf(v, food));
      }
    }
  }
  return best === -Infinity ? undefined : best;
}

const rand = mulberry32(seed);
let compared = 0;
let skipped = 0;
let failures = 0;
let gcdUnmetCount = 0;
let currentTime = 0;
let referenceTime = 0;
let exhaustiveTime = 0;
let slowest = { elapsed: 0, description: '' };
let exhaustiveCompared = 0;
let exhaustiveUnfinished = 0;
let exhaustiveReused = 0;
let tankBetter = 0;
let maxRelativeGap = 0;
for (let k = 0; k < caseCount; k++) {
  // 約兩成情境改為等級同步：主亂數照常產生一般情境（後續情境的輸入不受影響），再以此情境專屬的亂數重新產生
  const syncRand = mulberry32(seed * 1000003 + k);
  const normalInput = buildRandomInput(rand, k);
  const input = syncRand() < 0.2 ? buildRandomInput(syncRand, k, true) : normalInput;
  if (only !== undefined && !only.includes(k)) continue;
  const report = (message: string) => {
    failures++;
    console.log(`★ ${input.description}：${message}`);
  };
  const run = (label: string, optimize: (input: OptimizerInput) => OptimizerResult) => {
    const start = Date.now();
    try {
      return { result: optimize(input), elapsed: Date.now() - start };
    } catch (error) {
      return { error: `${label}：${error instanceof Error ? error.message : String(error)}`, elapsed: Date.now() - start };
    }
  };
  const nowRun = run('新版', current.optimize);
  // 舊版與精確對照不會分配幻境武器最終階段的屬性，改為展開成各種分配的候選
  const expanded = expandRelics(input);
  const refRun = run('舊版', () => (reference.optimize as unknown as (input: OptimizerInput) => OptimizerResult)(expanded));
  currentTime += nowRun.elapsed;
  if (nowRun.elapsed > slowest.elapsed) slowest = { elapsed: nowRun.elapsed, description: input.description };
  if (nowRun.elapsed > 5000) console.log(`慢：新版 ${(nowRun.elapsed / 1000).toFixed(1)} 秒，舊版 ${(refRun.elapsed / 1000).toFixed(1)} 秒（${input.description}）`);
  referenceTime += refRun.elapsed;
  if (only !== undefined) {
    console.log(input.description);
    for (const { slot, gears } of input.slots) {
      console.log(`  部位 ${slot}：` + gears.map(g => `${g.id}（品級${g.data.level}${g.equipped ? '、已裝備' : ''}` +
        `${g.data.equipLevelVariable ? '、品級可變' : ''}${g.data.customizable ? '、可自訂' : ''}、` +
        `孔${g.data.materiaSlot}${g.data.materiaAdvanced ? '+禁斷' : ''}、` +
        `${g.materias.map(m => m.stat === undefined ? '空' : `${m.stat}${m.grade}`).join('/')}` +
        `${g.customStats !== undefined ? ` 自訂${JSON.stringify(g.customStats)}` : ''}）`).join('、'));
    }
    console.log(`  食物：${input.foods.map(f => f.data.id).join('、')}`);
    console.log(JSON.stringify({ now: nowRun, ref: refRun }, null, 1));
  }
  if (nowRun.error?.includes(current.TOO_MANY_STATES_MESSAGE) || refRun.error?.includes(current.TOO_MANY_STATES_MESSAGE)) {
    skipped++;
    continue;
  }
  if (nowRun.error !== undefined || refRun.error !== undefined) {
    report(`執行失敗：${[nowRun.error, refRun.error].filter(Boolean).join('；')}`);
    continue;
  }
  const now = nowRun.result!;
  const ref = refRun.result!;
  if (only !== undefined && Math.abs(now.damage - ref.damage) > 1e-9 * ref.damage) {
    // 除錯：把部位限制為舊版選的裝備後重算新版，找出是哪個部位的選擇被錯誤排除
    const restrict = (slots: number[]) => ({
      ...input,
      slots: input.slots.map(s => !slots.includes(s.slot) ? s :
        { ...s, gears: s.gears.filter(g => ref.gears.some(r => r.slot === s.slot && (r.id === g.id ||  // 展開的幻境武器
          relicAllocationsFor(input.job, g.data) !== undefined && Math.trunc(r.id / 100) === g.id))) }),
    });
    const all = run('新版', () => current.optimize(restrict(input.slots.map(s => s.slot))));
    console.log(`  全部部位限制為舊版選擇：新版 ${all.result?.damage ?? all.error}`);
    for (const { slot } of input.slots) {
      const one = run('新版', () => current.optimize(restrict([slot])));
      console.log(`  只限制部位 ${slot}：新版 ${one.result?.damage ?? one.error}`);
    }
    const onlyFood = run('新版', () => current.optimize({ ...input, foods: input.foods.filter(f => f.data.id === ref.foodId) }));
    console.log(`  食物限制為舊版選擇：新版 ${onlyFood.result?.damage ?? onlyFood.error}`);
  }
  compared++;
  if (now.gcdUnmet) gcdUnmetCount++;
  const gap = (ref.damage - now.damage) / ref.damage;
  if (input.baseStats.TEN !== undefined && gap < -1e-9) {
    // 舊版的堅韌只在暴擊、信念、直擊相同時才比較，坦克可能錯過更好的解；新版較高時以精確對照確認
    tankBetter++;
  } else {
    maxRelativeGap = Math.max(maxRelativeGap, Math.abs(gap));
    if (Math.abs(gap) > 1e-9) report(`新版 ${now.damage} 與舊版 ${ref.damage} 不同（差 ${(gap * 100).toFixed(4)}%）`);
  }
  const needExhaustive = exhaustiveAll || (input.baseStats.TEN !== undefined && gap < -1e-9);
  const exhaustiveStart = Date.now();
  let exact: number | undefined;
  let exactTimedOut = false;
  if (needExhaustive) {
    const key = `${seed}#${k}`;
    const fingerprint = fingerprintOf(expanded);
    const record = exhaustiveRecords[key];
    if (!refreshExhaustive && record?.fingerprint === fingerprint) {
      exact = record.exact;
      exhaustiveReused++;
    } else {
      try {
        exact = exhaustive(expanded, now.damage, exhaustiveTimeLimitMs);
      } catch (error) {
        if (error !== EXHAUSTIVE_TIMEOUT) throw error;
        exactTimedOut = true;
      }
      if (exact !== undefined) {
        exhaustiveRecords[key] = { fingerprint, description: input.description, exact,
          elapsed: Date.now() - exhaustiveStart, recordedAt: new Date().toISOString().slice(0, 10) };
        saveExhaustiveRecords();  // 每完成一個就寫入，長時間執行中斷也不會遺失
      }
    }
  }
  exhaustiveTime += Date.now() - exhaustiveStart;
  if (exactTimedOut || (exact === undefined && needExhaustive)) {
    // 精確對照只是額外確認，做不完不算失敗；新版結果仍經過 validate 從頭重算
    exhaustiveUnfinished++;
    console.log(`⚠ ${input.description}：精確對照${exactTimedOut ? '逾時' : '狀態過多'}，未能確認是否為最佳解` +
      `（可用 --seed=${seed} --only=${k} --exhaustive-time=0 單獨補跑）`);
  } else if (exact !== undefined) {
    exhaustiveCompared++;
    const exactGap = (exact - now.damage) / exact;
    maxRelativeGap = Math.max(maxRelativeGap, Math.abs(exactGap));
    if (Math.abs(exactGap) > 1e-9) report(`新版 ${now.damage} 與精確對照 ${exact} 不同（差 ${(exactGap * 100).toFixed(4)}%）`);
  }
  if (now.gcdUnmet !== ref.gcdUnmet) report(`GCD 是否達成的判斷不同（新版 ${now.gcdUnmet}，舊版 ${ref.gcdUnmet}）`);
  for (const problem of validate(input, now)) report(`新版結果有誤：${problem}`);
  for (const problem of validate(expanded, ref)) report(`舊版結果有誤：${problem}`);
  if ((k + 1) % 50 === 0) console.log(`已完成 ${k + 1} / ${caseCount}`);
}
console.log(`種子 ${seed}：比對 ${compared} 個情境（其中 ${gcdUnmetCount} 個 GCD 目標無法達成），` +
  `精確對照完成 ${exhaustiveCompared} 個（沿用紀錄 ${exhaustiveReused} 個，未完成 ${exhaustiveUnfinished} 個），` +
  `坦克新版優於舊版 ${tankBetter} 個，` +
  `略過 ${skipped} 個（組合過多），不一致 ${failures} 項，最大相對差 ${maxRelativeGap}`);
console.log(`總耗時：新版 ${(currentTime / 1000).toFixed(1)} 秒，舊版 ${(referenceTime / 1000).toFixed(1)} 秒，` +
  `精確對照 ${(exhaustiveTime / 1000).toFixed(1)} 秒`);
console.log(`新版最慢：${(slowest.elapsed / 1000).toFixed(1)} 秒（${slowest.description}）`);
console.log(failures === 0 ? '全部通過' : '有不一致');
process.exit(failures === 0 ? 0 : 1);
