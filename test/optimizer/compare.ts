// 自動配裝最佳化的新舊版比對：以真實裝備資料建立多種情境，分別用 src/optimizer.ts（新版）與
// test/optimizer/reference.ts（舊版）計算，確認兩者的每威力傷害期望完全相同，並列出耗時與記憶體。
// 舊版的堅韌只在平手時比較，坦克新版較高時，改以幻武固定為新版分配的備份（current-backup.ts）重算確認。
//
// 用法：
//   npm run test-optimizer                          一般情境
//   npm run test-optimizer -- --heavy               另外加入舊版會記憶體不足的重度情境
//   npm run test-optimizer -- --filter=PCT          只跑名稱包含指定文字的情境
//   npm run test-optimizer -- --refresh-reference   重新執行舊版並更新記錄（遊戲資料更新後使用）
//   npm run test-optimizer -- --print-fingerprints  列出各情境輸入的指紋
//   npm run test-optimizer -- --backup              另外執行 current-backup.ts（目前演算法的備份）並對照
//   npm run test-optimizer -- --bis=<目錄>         另外以 bis-adapter.cjs 執行 bis.xivtc.com 的求解器並對照計時；
//                                                   <目錄> 為本機的 bis.xivtc.com 原始碼（沒有授權聲明，不放進專案）
//
// 舊版的演算法不再變動，其結果記錄於 reference-results.json 並直接沿用，不必每次重跑。
// 記錄附有輸入指紋（情境設定與裝備、食物資料的雜湊）；指紋不符（例如遊戲資料更新）時會自動重新執行舊版並更新記錄。
// 舊版、備份與外部求解器不會分配幻境武器最終階段的屬性，輸入會先展開成各種分配的候選（見 relic.ts）。
//
// 每次計算都在獨立的 Node 程序中執行（堆積上限 4 GB，接近瀏覽器的限制），單一情境記憶體不足不會中斷整體比對。

import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as G from '../../src/game';
import * as current from '../../src/optimizer';
import * as reference from './reference';
import * as backup from './current-backup';
import { expandRelics, sameStats } from './relic';
import type { OptimizerInput, OptimizerResult } from '../../src/optimizer';

interface Scenario {
  name: string,
  job: G.Job,
  range: [number, number],
  gcd: number,
  overmeld?: number,
  hiddenSources?: string[],
  foodMaxLevel?: number,
  heavy?: boolean,  // 舊版可能記憶體不足的情境
  bisRuleDiffers?: boolean,  // 外部求解器規則不同、結果本來就可能不同的情境（不計為失敗）
}

const scenarios: Scenario[] = [];
for (const job of ['PLD', 'WAR', 'GNB', 'WHM', 'AST', 'SAM', 'DRG', 'NIN', 'BRD', 'DNC', 'BLM', 'PCT'] as G.Job[]) {
  for (const gcd of [2.5, 2.4]) {
    scenarios.push({ name: `${job} 780-795 GCD${gcd.toFixed(2)}`, job, range: [780, 795], gcd });
  }
}
scenarios.push(
  { name: 'SAM 780-795 GCD2.14', job: 'SAM', range: [780, 795], gcd: 2.14 },
  { name: 'SAM 780-795 GCD2.50 隱藏零式與絕境', job: 'SAM', range: [780, 795], gcd: 2.5, hiddenSources: ['零式', '絕境'] },
  { name: 'BLM 780-795 GCD2.40 不禁斷', job: 'BLM', range: [780, 795], gcd: 2.4, overmeld: 0 },
  { name: 'WHM 780-795 GCD2.40 食物上限740', job: 'WHM', range: [780, 795], gcd: 2.4, foodMaxLevel: 740 },
  // GCD 目標無法達成時，本專案改為速度最大化，bis.xivtc.com 則改求最接近目標的 GCD，結果本來就可能不同
  { name: 'PCT 780-795 GCD1.50（無法達成）', job: 'PCT', range: [780, 795], gcd: 1.5, bisRuleDiffers: true },
  { name: 'PCT 780-795 GCD2.30', job: 'PCT', range: [780, 795], gcd: 2.3 },
  { name: 'AST 780-795 GCD2.30', job: 'AST', range: [780, 795], gcd: 2.3 },
  { name: 'PCT 770-795 GCD2.40', job: 'PCT', range: [770, 795], gcd: 2.4, heavy: true },
  { name: 'PCT 760-795 GCD2.30', job: 'PCT', range: [760, 795], gcd: 2.3, heavy: true },
  { name: 'DRG 760-795 GCD2.40', job: 'DRG', range: [760, 795], gcd: 2.4, heavy: true },
  { name: 'BLM 730-795 GCD2.30', job: 'BLM', range: [730, 795], gcd: 2.3, heavy: true },
);

// ---- 建立輸入（與 Store.gearOptimizationInput 相同的規則，所有孔洞為空、無已裝備的裝備）

/* eslint-disable @typescript-eslint/no-require-imports */
const gearData: G.Gear[] = Array.from(new Map(['gears-recent', 'gears-730', 'gears-661', 'gears-645']
  .flatMap(file => require(`../../data/out/${file}`).default as G.Gear[])
  .map(gear => [gear.id, gear])).values());
const foodData = require('../../data/out/foods').default as G.Food[];
/* eslint-enable @typescript-eslint/no-require-imports */

function buildInput(scenario: Scenario): OptimizerInput {
  const { job, range: [ minLevel, maxLevel ], hiddenSources = [], foodMaxLevel } = scenario;
  const schema = G.jobSchemas[job] as G.JobSchema;
  const jobLevel = schema.jobLevel;
  const levelModifier = G.jobLevelModifiers[jobLevel];
  const baseStats: G.Stats = { PDMG: 0, MDMG: 0, DLY: 0 };
  for (const stat of schema.stats) {
    const baseStat = G.baseStats[stat] ?? 0;
    baseStats[stat] = typeof baseStat === 'number' ? baseStat :
      G.floor(levelModifier[baseStat] * ((schema.statModifiers as G.Stats | undefined)?.[stat] ?? 100) / 100) +
      (G.clanStats[stat]?.[0] ?? 0);
  }
  const candidates = gearData.filter(gear => G.jobCategories[gear.jobCategory][job] &&
    gear.level >= minLevel && gear.level <= maxLevel && gear.equipLevel <= jobLevel && !gear.obsolete &&
    !hiddenSources.some(source => (gear.source ?? '').startsWith(source)));
  const slots = schema.slots.filter(s => s.slot > 0 || s.slot === -12).map(({ slot }) => ({
    slot,
    gears: candidates.filter(gear => gear.slot === Math.abs(slot)).map(gear => ({
      id: (slot < 0 ? -gear.id : gear.id) as G.GearId,
      data: gear,
      customStats: gear.customizable ? {} : undefined,
      materias: Array.from({ length: gear.materiaAdvanced ? 5 : gear.materiaSlot }, () => ({})),
      equipped: false,
    })),
  }));
  const foods = foodData.filter(food => food.slot === -1 && G.jobCategories[food.jobCategory][job] &&
    (foodMaxLevel === undefined ? 'best' in food : food.level <= foodMaxLevel))
    .map(data => ({ data, equipped: false }));
  return { job, jobLevel, baseStats, slots, foods, gcdTarget: scenario.gcd, overmeldLimit: scenario.overmeld ?? 5 };
}

// ---- 子程序：執行單一計算

/** 新版為幻境武器最終階段選的分配（坦克比對時用來固定備份的候選） */
interface RelicChoice { slot: number, id: G.GearId, customStats: G.Stats }

interface RunOutput {
  result?: Partial<Pick<OptimizerResult, 'gcd' | 'gcdUnmet' | 'stats' | 'foodId'>> &
    { damage: number, elapsed: number, gears?: string, error?: string, relics?: RelicChoice[] },
  error?: string,
  rssMB?: number,
}

type Impl = 'current' | 'reference' | 'backup' | 'bis';

interface ExternalOptimizer {
  optimize: (input: OptimizerInput, game: typeof G) => Promise<{ damage?: number, elapsed: number, error?: string }>,
}
declare const __non_webpack_require__: (id: string) => unknown;  // 執行時才載入的外部模組，不經打包

if (process.argv[2] === '--run') {
  const [ , , , impl, json, extraArg ] = process.argv as [string, string, string, Impl, string, string?];  // extraArg：bis 為轉接程式路徑，其他為固定的幻武分配
  const scenario = JSON.parse(json) as Scenario;
  (async () => {
    let output: RunOutput;
    try {
      if (impl === 'bis') {
        const external = __non_webpack_require__(extraArg!) as ExternalOptimizer;
        const result = await external.optimize(expandRelics(buildInput(scenario)), G);
        output = result.error !== undefined || result.damage === undefined ?
          { error: result.error ?? '沒有結果' } :
          { result: { damage: result.damage, elapsed: result.elapsed } };
      } else {
        const optimize = impl === 'reference' ? reference.optimize : impl === 'backup' ? backup.optimize : current.optimize;
        // 舊版與備份不會分配幻境武器最終階段的屬性，改為展開成各種分配的候選；
        // 第三個參數有值時，只保留新版選的分配（見主程序的坦克比對）
        let input = impl === 'current' ? buildInput(scenario) : expandRelics(buildInput(scenario));
        if (extraArg !== undefined) {
          const relics = JSON.parse(extraArg) as RelicChoice[];
          input = { ...input, slots: input.slots.map(s => {
            const pick = relics.find(r => r.slot === s.slot);
            return pick === undefined ? s : { ...s, gears: s.gears.filter(g =>
              Math.trunc(g.id / 100) === pick.id && sameStats(g.customStats ?? {}, pick.customStats)) };
          }) };
        }
        const result = optimize(input) as OptimizerResult & { error?: string };
        output = {
          result: {
            damage: result.damage, gcd: result.gcd, gcdUnmet: result.gcdUnmet, stats: result.stats,
            elapsed: result.elapsed, foodId: result.foodId, error: result.error,
            gears: result.gears.map(g => `${g.slot}:${Math.abs(g.id)}:${(g.materiaStats ?? []).join('/')}`).join(' '),
            relics: result.gears.flatMap(({ slot, id, customStats }) =>
              customStats === undefined ? [] : [{ slot, id, customStats }]),
          },
        };
      }
    } catch (error) {
      output = { error: error instanceof Error ? error.message : String(error) };
    }
    output.rssMB = Math.round(process.resourceUsage().maxRSS / 1024);
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  })();
}

// ---- 主程序

function runChild(impl: Impl, scenario: Scenario, extraArg?: string): RunOutput {
  const ret = childProcess.spawnSync(process.execPath,
    ['--max-old-space-size=4096', __filename, '--run', impl, JSON.stringify(scenario),
      ...(extraArg !== undefined ? [extraArg] : [])],
    { encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  if (ret.status !== 0 || !ret.stdout) {
    const reason = ret.error?.message.includes('ETIMEDOUT') ? '逾時' :
      /heap out of memory/.test(ret.stderr) ? '記憶體不足' : `結束代碼 ${ret.status}`;
    return { error: reason };
  }
  return JSON.parse(ret.stdout) as RunOutput;
}

interface ReferenceRecord {
  fingerprint: string,
  recordedAt: string,
  output: RunOutput,
}
// 打包後此檔案位於 dist/ 底下，記錄檔放在原始碼目錄（test/optimizer/）以便納入版本控制
const recordPath = path.resolve(path.dirname(__filename), '..', 'reference-results.json');
const records: Record<string, ReferenceRecord> = fs.existsSync(recordPath) ?
  JSON.parse(fs.readFileSync(recordPath, 'utf8')).results : {};
const saveRecords = () => fs.writeFileSync(recordPath, JSON.stringify({
  說明: '舊版（test/optimizer/reference.ts）在各情境的執行結果，由 compare.ts 自動維護；fingerprint 為輸入的雜湊，不符時會重新執行',
  results: records,
}, null, 2) + '\n');
const fingerprintOf = (scenario: Scenario) =>
  crypto.createHash('sha1').update(JSON.stringify(expandRelics(buildInput(scenario)))).digest('hex').slice(0, 16);

const heavy = process.argv.includes('--heavy');
const refreshReference = process.argv.includes('--refresh-reference');
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice('--filter='.length);
const describe = (output: RunOutput) => output.error !== undefined ? `失敗（${output.error}）` :
  output.result!.error !== undefined ? `中止（${output.result!.error}）` :
    `${output.result!.damage.toFixed(4)}  ${(output.result!.elapsed / 1000).toFixed(1)} 秒  ${output.rssMB} MB`;

const runBackup = process.argv.includes('--backup');
const bisDir = process.argv.find(arg => arg.startsWith('--bis='))?.slice('--bis='.length);
// 打包後此檔案位於 dist/ 底下；轉接程式放在原始碼目錄，外部原始碼目錄以環境變數傳給子程序
const bisAdapterPath = path.resolve(path.dirname(__filename), '..', 'bis-adapter.cjs');
if (bisDir !== undefined) process.env.BIS_XIVTC_DIR = path.resolve(bisDir);
// 與新版比對：完全相同，或（外部求解器以 log 加總計算時）相對誤差在 1e-9 以內
const compareTo = (output: RunOutput, base: RunOutput, exact: boolean) => {
  if (output.result === undefined || output.result.error !== undefined) return '';
  if (base.result === undefined || base.result.error !== undefined) return '';
  const diff = output.result.damage / base.result.damage - 1;
  if (exact ? diff === 0 : Math.abs(diff) < 1e-9) return '（與新版一致）';
  return `（★ 與新版差 ${(diff * 100).toFixed(4)}%）`;
};

if (process.argv[2] !== '--run' && process.argv.includes('--print-fingerprints')) {
  for (const scenario of scenarios) console.log(`${fingerprintOf(scenario)}  ${scenario.name}`);
  process.exit(0);
}

let failures = 0;
if (process.argv[2] !== '--run') for (const scenario of scenarios) {
  if (scenario.heavy && !heavy) continue;
  if (filter !== undefined && !scenario.name.includes(filter)) continue;
  const now = runChild('current', scenario);
  const fingerprint = fingerprintOf(scenario);
  let record = records[scenario.name];
  if (refreshReference || record?.fingerprint !== fingerprint) {
    record = { fingerprint, recordedAt: new Date().toISOString().slice(0, 10), output: runChild('reference', scenario) };
    records[scenario.name] = record;
    saveRecords();
  }
  const ref = record.output;
  let verdict: string;
  let exactNote: string | undefined;
  if (now.result !== undefined && ref.result !== undefined && now.result.error === undefined) {
    verdict = now.result.damage === ref.result.damage ? '一致' : '★ 不一致';
    // 舊版的堅韌只在平手時比較，坦克在幻境武器選堅韌時新版可能較高；備份在展開大量分配後
    // 也可能找不到該解（實測如此）。此時把幻境武器固定為新版選的分配，以備份重算，
    // 傷害完全相同即確認新版的結果可行且數值正確（最佳性另由 fuzz 的精確對照涵蓋）
    const isTank = (G.jobSchemas[scenario.job] as G.JobSchema).stats.includes('TEN');
    const relics = now.result.relics ?? [];
    if (isTank && now.result.damage > ref.result.damage && relics.length > 0) {
      const check = runChild('backup', scenario, JSON.stringify(relics));
      const fixed = relics.map(r => Object.entries(r.customStats).map(([ k, v ]) => `${k}${v}`).join('/')).join('、');
      if (check.result !== undefined && check.result.error === undefined && check.result.damage === now.result.damage) {
        verdict = '坦克新版較高';
        exactNote = `備份（幻武固定為 ${fixed}）：${describe(check)}（與新版一致）`;
      } else {
        exactNote = `備份（幻武固定為 ${fixed}）：${describe(check)}${compareTo(check, now, true)}`;
      }
    }
  } else if (now.result !== undefined && now.result.error === undefined) {
    verdict = scenario.heavy ? '舊版無法完成，僅記錄新版' : '★ 舊版無法完成';
  } else {
    verdict = '★ 新版無法完成';
  }
  if (verdict.startsWith('★')) failures++;
  console.log(`${verdict.padEnd(14)} ${scenario.name}`);
  console.log(`    新版：${describe(now)}`);
  console.log(`    舊版：${describe(ref)}（記錄於 ${record.recordedAt}）`);
  if (exactNote !== undefined) console.log(`    ${exactNote}`);
  const extras: [string, Impl, boolean][] = [];
  if (runBackup) extras.push([ '備份', 'backup', true ]);
  if (bisDir !== undefined) extras.push([ 'bis', 'bis', false ]);
  for (const [ label, impl, exact ] of extras) {
    const output = runChild(impl, scenario, impl === 'bis' ? bisAdapterPath : undefined);
    let note = compareTo(output, now, exact);
    if (impl === 'bis' && scenario.bisRuleDiffers && note.includes('★')) note = note.replace('★ ', '規則不同，');
    if (note.includes('★')) failures++;
    console.log(`    ${label}：${describe(output)}${note}`);
  }
}
if (process.argv[2] !== '--run') {
  console.log(failures === 0 ? '全部通過' : `${failures} 個情境有問題`);
  process.exit(failures === 0 ? 0 : 1);
}
