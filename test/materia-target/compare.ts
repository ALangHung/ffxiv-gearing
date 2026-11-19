// 生產／採集職業魔晶石最佳化（src/materiaTarget.ts）的結果記錄與比對：
// 以真實裝備資料建立固定情境，計算「最少魔晶石」與「最高數值」兩種方案，與 results.json 中記錄的結果比對，
// 確認之後修改演算法或程式時結果不變，並列出耗時。
//
// 用法：
//   npm run test-materia-target                     比對全部情境
//   npm run test-materia-target -- --filter=CRP     只跑名稱包含指定文字的情境
//   npm run test-materia-target -- --update         以目前的結果更新記錄（確認結果正確後使用）
//
// 記錄附有輸入指紋（情境設定與裝備、食物資料的雜湊）；指紋不符（例如遊戲資料更新）時只提示，不計為失敗，
// 確認新結果合理後以 --update 更新記錄。
// 結果不同時分為兩種：數值（最終數值、未達量、孔數、期望消耗）不同為失敗；
// 數值相同但魔晶石配置不同（同分時的取捨改變）只提示。

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as G from '../../src/game';
import { optimizeMateriaTarget } from '../../src/materiaTarget';
import type { MateriaTargetInput, MateriaTargetSolution } from '../../src/materiaTarget';

interface Scenario {
  name: string,
  job: G.Job,
  range: [number, number],  // 每個部位取此品級範圍內最高品級的裝備（同品級優先 HQ）
  targets: G.Stats,
  overmeld: number,
  consumables?: string[],  // 食物、藥品名稱
  presetMaterias?: [number, G.Stat, G.MateriaGrade][],  // 每件裝備預先鑲嵌：[孔洞索引, 屬性, 等級]
}

const scenarios: Scenario[] = [];
for (const overmeld of [0, 1, 2, 5]) {
  scenarios.push({
    name: `CRP 750 目標5000/5000/600 禁斷${overmeld}`, job: 'CRP', range: [750, 750],
    targets: { CMS: 5000, CRL: 5000, CP: 600 }, overmeld,
  });
}
scenarios.push(
  { name: 'CRP 750 無目標 滿禁斷', job: 'CRP', range: [750, 750], targets: {}, overmeld: 5 },
  { name: 'CRP 750 目標低於目前', job: 'CRP', range: [750, 750], targets: { CMS: 4500, CRL: 4500, CP: 550 }, overmeld: 5 },
  { name: 'CRP 750 只要求製作力', job: 'CRP', range: [750, 750], targets: { CP: 590 }, overmeld: 5 },
  { name: 'CRP 750 接近上限 6000/5050/590', job: 'CRP', range: [750, 750],
    targets: { CMS: 6000, CRL: 5050, CP: 590 }, overmeld: 5 },
  { name: 'CRP 750 接近上限 6090/5060/570', job: 'CRP', range: [750, 750],
    targets: { CMS: 6090, CRL: 5060, CP: 570 }, overmeld: 5 },
  { name: 'CRP 750 目標5900/4950/580', job: 'CRP', range: [750, 750],
    targets: { CMS: 5900, CRL: 4950, CP: 580 }, overmeld: 5 },
  { name: 'CRP 750 無法達成（全部）', job: 'CRP', range: [750, 750],
    targets: { CMS: 99999, CRL: 99999, CP: 9999 }, overmeld: 5 },
  { name: 'CRP 750 無法達成（作業精度）', job: 'CRP', range: [750, 750],
    targets: { CMS: 99999, CRL: 4900, CP: 580 }, overmeld: 5 },
  { name: 'CRP 750 食物與藥品 5600/5200/700', job: 'CRP', range: [750, 750],
    targets: { CMS: 5600, CRL: 5200, CP: 700 }, overmeld: 5, consumables: ['椒麻鰻魚', '魔匠藥液'] },
  { name: 'CRP 750 已鑲嵌魔晶石 5600/5000/600', job: 'CRP', range: [750, 750],
    targets: { CMS: 5600, CRL: 5000, CP: 600 }, overmeld: 2, presetMaterias: [[0, 'CP', 11], [1, 'CMS', 12]] },
  { name: 'CUL 750 目標5200/5100/620 禁斷2', job: 'CUL', range: [750, 750],
    targets: { CMS: 5200, CRL: 5100, CP: 620 }, overmeld: 2 },
  { name: 'MIN 750 目標5000/5000/1000', job: 'MIN', range: [750, 750],
    targets: { GTH: 5000, PCP: 5000, GP: 1000 }, overmeld: 5 },
  { name: 'MIN 750 無法達成（全部）', job: 'MIN', range: [750, 750],
    targets: { GTH: 99999, PCP: 99999, GP: 9999 }, overmeld: 5 },
  { name: 'MIN 750 目標5800/5900/1100', job: 'MIN', range: [750, 750],
    targets: { GTH: 5800, PCP: 5900, GP: 1100 }, overmeld: 5 },
  { name: 'MIN 750 目標5500/5500/1050 禁斷2', job: 'MIN', range: [750, 750],
    targets: { GTH: 5500, PCP: 5500, GP: 1050 }, overmeld: 2 },
  { name: 'BTN 750 食物 5400/5400/1000', job: 'BTN', range: [750, 750],
    targets: { GTH: 5400, PCP: 5400, GP: 1000 }, overmeld: 5, consumables: ['醬炒飯'] },
  { name: 'FSH 750 目標5300/5300/1000 禁斷1', job: 'FSH', range: [750, 750],
    targets: { GTH: 5300, PCP: 5300, GP: 1000 }, overmeld: 1 },
);

// ---- 建立輸入

/* eslint-disable @typescript-eslint/no-require-imports */
const gearData: G.Gear[] = Array.from(new Map(['gears-recent', 'gears-730', 'gears-661', 'gears-645']
  .flatMap(file => require(`../../data/out/${file}`).default as G.Gear[])
  .map(gear => [gear.id, gear])).values());
const foodData = require('../../data/out/foods').default as G.Food[];
/* eslint-enable @typescript-eslint/no-require-imports */

interface BuiltInput {
  input: MateriaTargetInput,
  slotNames: Map<G.GearId, string>,
}

function buildInput(scenario: Scenario): BuiltInput {
  const { job, range: [ minLevel, maxLevel ] } = scenario;
  const schema = G.jobSchemas[job] as G.JobSchema;
  const baseStats: G.Stats = {};
  for (const stat of schema.stats) baseStats[stat] = G.baseStats[stat] as number ?? 0;
  const gears: MateriaTargetInput['gears'] = [];
  const slotNames = new Map<G.GearId, string>();
  for (const { slot, name } of schema.slots) {
    if (slot < 0 && slot !== -12 || slot === 17) continue;
    const candidates = gearData.filter(gear => gear.slot === Math.abs(slot) && G.jobCategories[gear.jobCategory][job] &&
      gear.level >= minLevel && gear.level <= maxLevel && gear.materiaSlot > 0 && !gear.obsolete)
      .sort((a, b) => b.level - a.level || (b.hq ? 1 : 0) - (a.hq ? 1 : 0) || a.id - b.id);
    // 唯一裝備不能裝備兩個，第二個戒指欄位改取下一件
    const gear = slot === -12 && candidates[0]?.unique ? candidates[1] : candidates[0];
    if (gear === undefined) continue;
    const materias: MateriaTargetInput['gears'][number]['materias'] =
      Array.from({ length: gear.materiaAdvanced ? 5 : gear.materiaSlot }, () => ({}));
    for (const [ index, stat, grade ] of scenario.presetMaterias ?? []) {
      if (index < materias.length) materias[index] = { stat, grade };
    }
    const id = (slot < 0 ? -gear.id : gear.id) as G.GearId;
    gears.push({ id, data: gear, materias });
    slotNames.set(id, `${name} ${gear.name}`);
  }
  const consumables = (scenario.consumables ?? []).map(name => {
    const food = foodData.find(f => f.name === name);
    if (food === undefined) throw new Error(`找不到食物或藥品：${name}`);
    return { stats: food.stats, statRates: food.statRates };
  });
  return {
    input: { stats: schema.stats, baseStats, gears, consumables, targets: scenario.targets, overmeldLimit: scenario.overmeld },
    slotNames,
  };
}

// ---- 結果整理

interface SolutionRecord {
  stats: G.Stats,
  shortfalls: G.Stats,
  slots: number,
  overmelds: number,
  expected: number,
  materias: { [gear: string]: string },
}

interface ScenarioRecord {
  fingerprint: string,
  recordedAt: string,
  minimal: SolutionRecord,
  maximal: SolutionRecord,
}

function recordOf(solution: MateriaTargetSolution, slotNames: Map<G.GearId, string>): SolutionRecord {
  const materias: SolutionRecord['materias'] = {};
  for (const [ gearId, list ] of solution.gearMaterias) {
    materias[slotNames.get(gearId)!] = list.map(m => m === undefined ? '-' : G.getMateriaName(m.stat, m.grade, false))
      .join(' ');
  }
  return {
    stats: solution.stats,
    shortfalls: solution.shortfalls,
    slots: solution.slotCount,
    overmelds: solution.overmeldCount,
    expected: Math.round(solution.expectedConsumption * 100) / 100,
    materias,
  };
}

function fingerprintOf(scenario: Scenario, input: MateriaTargetInput): string {
  return crypto.createHash('sha256').update(JSON.stringify({ scenario, input })).digest('hex').slice(0, 16);
}

const numbersOf = (r: SolutionRecord) => JSON.stringify([r.stats, r.shortfalls, r.slots, r.overmelds, r.expected]);

// ---- 主程式

const resultsPath = path.resolve(__dirname, '../results.json');
const args = process.argv.slice(2);
const update = args.includes('--update');
const filter = args.find(arg => arg.startsWith('--filter='))?.slice('--filter='.length);

interface ResultsFile { 說明: string, results: { [name: string]: ScenarioRecord } }
const resultsFile: ResultsFile = fs.existsSync(resultsPath) ?
  JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as ResultsFile :
  { 說明: '', results: {} };
resultsFile.說明 = '生產／採集職業魔晶石最佳化（src/materiaTarget.ts）在各情境的計算結果，由 compare.ts 維護；' +
  'fingerprint 為輸入的雜湊，以 npm run test-materia-target -- --update 更新';

let failed = 0;
let changed = 0;
const today = new Date().toISOString().slice(0, 10);
for (const scenario of scenarios) {
  if (filter !== undefined && !scenario.name.includes(filter)) continue;
  const { input, slotNames } = buildInput(scenario);
  const fingerprint = fingerprintOf(scenario, input);
  const start = performance.now();
  const result = optimizeMateriaTarget(input);
  const elapsed = performance.now() - start;
  const record: ScenarioRecord = {
    fingerprint,
    recordedAt: today,
    minimal: recordOf(result.minimal, slotNames),
    maximal: recordOf(result.maximal, slotNames),
  };
  const recorded = resultsFile.results[scenario.name];
  let status: string;
  if (recorded === undefined) {
    status = '新情境';
    changed++;
  } else if (recorded.fingerprint !== fingerprint) {
    status = '輸入已變更（指紋不符），請確認後以 --update 更新記錄';
    changed++;
  } else {
    const notes: string[] = [];
    for (const key of ['minimal', 'maximal'] as const) {
      const label = key === 'minimal' ? '最少' : '最高';
      if (numbersOf(recorded[key]) !== numbersOf(record[key])) {
        notes.push(`${label}方案數值不同：記錄 ${numbersOf(recorded[key])}，目前 ${numbersOf(record[key])}`);
      } else if (JSON.stringify(recorded[key].materias) !== JSON.stringify(record[key].materias)) {
        notes.push(`${label}方案數值相同但魔晶石配置不同`);
      }
    }
    const isFailure = notes.some(note => note.includes('數值不同'));
    if (isFailure) failed++;
    status = notes.length === 0 ? '一致' : (isFailure ? '失敗：' : '提示：') + notes.join('；');
  }
  const summary = (r: SolutionRecord) => `${Object.values(r.stats).join('/')} ${r.slots}（${r.overmelds}）孔 ` +
    `期望${r.expected}`;
  console.log(`${scenario.name}：${elapsed.toFixed(0)} ms　最少 ${summary(record.minimal)}　` +
    `最高 ${summary(record.maximal)}　${status}`);
  if (update) resultsFile.results[scenario.name] = record;
}

if (update) {
  fs.writeFileSync(resultsPath, JSON.stringify(resultsFile, null, 2) + '\n', 'utf-8');
  console.log(`已更新 ${path.relative(process.cwd(), resultsPath)}`);
} else if (changed > 0) {
  console.log(`有 ${changed} 個情境沒有記錄或輸入已變更，確認結果後以 --update 更新記錄`);
}
if (failed > 0) {
  console.log(`${failed} 個情境的結果與記錄不同`);
  process.exitCode = 1;
}
