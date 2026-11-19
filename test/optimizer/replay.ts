// 使用者回報的配裝最佳化問題（計算過久或失敗，見 src/optimizerReport.ts）：從 Supabase 取回並保存在專案中，
// 作為演算法改良時可重複驗證的案例集。
//
// 用法：
//   npm run test-optimizer-replay                     從 Supabase 取回上次之後的新回報，存入 field-cases/ 並以目前版本重播新案例
//   npm run test-optimizer-replay -- --cases          重播 field-cases/ 中的所有案例，與記錄的結果比對（回歸測試）
//   npm run test-optimizer-replay -- --cases --update 重播後把記錄的結果更新為目前版本的結果（確認演算法改動符合預期後使用）
//   npm run test-optimizer-replay -- --file=<檔案>    改從本機 JSON 匯入回報（Supabase 匯出的資料列陣列）
//   npm run test-optimizer-replay -- --filter=PCT     只重播指定職業
//   npm run test-optimizer-replay -- --reference      另外以舊版（reference.ts）重算並比對傷害
//   npm run test-optimizer-replay -- --timeout=600    單次計算的逾時秒數（預設 600）
//
// 案例集（test/optimizer/field-cases/，納入版本控制）：
// - 每個不同的計算輸入一個檔案（<職業>-<輸入指紋>.json），相同輸入的多次回報合併在同一個案例的 reports。
// - expected 為加入案例時目前版本的結果（傷害與 GCD，或無法完成的原因），--cases 以此判斷結果是否改變。
// - 只保存演算法驗證需要的資料：不保存 User-Agent，環境資訊只留核心數與記憶體。
// - 已保存資料列的最大 id 即為取回進度，下次只取回更新的資料列；計算的後續結果（完成、取消等）晚到時也會補進對應案例。
//
// 從 Supabase 取回需要環境變數 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY（略過 RLS 讀取），
// 可寫在專案根目錄的 .env.local（不納入版本控制）。service_role 金鑰擁有完整權限，不可放進前端或提交。
//
// 與 compare.ts 相同，每次計算都在獨立的 Node 程序中執行（堆積上限 4 GB，接近瀏覽器的限制）。

import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as current from '../../src/optimizer';
import * as reference from './reference';
import { deserializeOptimizerInput } from '../../src/optimizerReportFormat';
import type { OptimizerInput, OptimizerResult } from '../../src/optimizer';
import type { OptimizerReportInput, OptimizerReportRow } from '../../src/optimizerReportFormat';

type Impl = 'current' | 'reference';

interface RunOutput {
  result?: { damage: number, gcd: number, gcdUnmet: boolean, elapsed: number, error?: string },
  error?: string,
  rssMB?: number,
}

// ---- 子程序：從標準輸入讀取計算輸入，執行單一計算

if (process.argv[2] === '--run') {
  const impl = process.argv[3] as Impl;
  let output: RunOutput;
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8')) as OptimizerInput;
    const optimize = impl === 'reference' ? reference.optimize : current.optimize;
    const result = optimize(input) as OptimizerResult & { error?: string };
    output = {
      result: { damage: result.damage, gcd: result.gcd, gcdUnmet: result.gcdUnmet, elapsed: result.elapsed,
        error: result.error },
    };
  } catch (error) {
    output = { error: error instanceof Error ? error.message : String(error) };
  }
  output.rssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// ---- 主程序

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const timeoutSeconds = Number(arg('timeout') ?? 600);
const filter = arg('filter');

function runChild(impl: Impl, input: OptimizerInput): RunOutput {
  const ret = childProcess.spawnSync(process.execPath,
    ['--max-old-space-size=4096', __filename, '--run', impl],
    { input: JSON.stringify(input), encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (ret.status !== 0 || !ret.stdout) {
    const reason = ret.error?.message.includes('ETIMEDOUT') ? `逾時（${timeoutSeconds} 秒）` :
      /heap out of memory/.test(ret.stderr) ? '記憶體不足' : `結束代碼 ${ret.status}`;
    return { error: reason };
  }
  return JSON.parse(ret.stdout) as RunOutput;
}

const succeeded = (output: RunOutput) => output.result !== undefined && output.result.error === undefined;
const failureReason = (output: RunOutput) => output.error ?? output.result?.error ?? '';
const describe = (output: RunOutput) => output.error !== undefined ? `失敗（${output.error}）` :
  output.result!.error !== undefined ? `中止（${output.result!.error}）` :
    `${output.result!.damage.toFixed(4)}  GCD ${output.result!.gcd.toFixed(2)}  ` +
    `${(output.result!.elapsed / 1000).toFixed(1)} 秒  ${output.rssMB} MB`;
const seconds = (ms?: number) => ms === undefined ? '?' : `${(ms / 1000).toFixed(1)} 秒`;

/** 案例名稱：職業、GCD 目標、禁斷上限與各部位候選數 */
function caseName(input: OptimizerReportInput): string {
  const counts = input.slots.map(s => s.gears.length).join('/');
  return `${input.job} GCD${input.gcdTarget.toFixed(2)} 禁斷${input.overmeldLimit} 候選 ${counts} 食物 ${input.foods.length}`;
}

const headCommit = (() => {
  try {
    return childProcess.execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

// ---- 案例集

// 打包後此檔案位於 dist/ 底下，案例集放在原始碼目錄（test/optimizer/）以便納入版本控制
const casesDir = path.resolve(path.dirname(__filename), '..', 'field-cases');

/** 同一次計算的後續結果 */
interface FieldFollowUp {
  id?: number,
  kind: string,
  elapsedMs?: number,
  error?: string,
  result?: { damage: number, gcd: number, gcdUnmet: boolean },
}

/** 一次附計算輸入的回報（slow 或 error） */
interface FieldReport {
  id?: number,
  runId: string,
  reportedAt: string,
  kind: string,
  elapsedMs?: number,
  error?: string,
  app: OptimizerReportRow['app'],
  client: { hardwareConcurrency?: number, deviceMemory?: number },
  followUps: FieldFollowUp[],
}

/** 記錄的結果：目前版本在 commit 時的傷害與 GCD，或無法完成的原因 */
type FieldExpected = { commit: string, recordedAt: string } &
  ({ damage: number, gcd: number, elapsedMs: number } | { error: string });

interface FieldCase {
  fingerprint: string,  // 計算輸入的雜湊，相同輸入只保留一個案例
  name: string,
  expected?: FieldExpected,
  reports: FieldReport[],
  input: OptimizerReportInput,
}

const caseFile = (c: FieldCase) => path.join(casesDir, `${c.input.job}-${c.fingerprint}.json`);

function loadCases(): FieldCase[] {
  if (!fs.existsSync(casesDir)) return [];
  return fs.readdirSync(casesDir).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')) as FieldCase);
}

/** 計算輸入很大且不會變動，寫成單行以減少檔案大小；其餘欄位縮排方便閱讀與比較差異 */
function saveCase(c: FieldCase): void {
  fs.mkdirSync(casesDir, { recursive: true });
  const { fingerprint, name, expected, reports, input } = c;
  const meta = { fingerprint, name, expected, reports };
  const text = JSON.stringify(meta, null, 2).replace(/\n}$/, `,\n  "input": ${JSON.stringify(input)}\n}\n`);
  fs.writeFileSync(caseFile(c), text);
}

const fingerprintOf = (input: OptimizerReportInput) =>
  crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 16);

const expectedOf = (output: RunOutput): FieldExpected => ({
  commit: headCommit,
  recordedAt: new Date().toISOString(),
  ...(succeeded(output) ?
    { damage: output.result!.damage, gcd: output.result!.gcd, elapsedMs: output.result!.elapsed } :
    { error: failureReason(output) }),
});

const describeExpected = (expected: FieldExpected) => 'error' in expected ? `無法完成（${expected.error}）` :
  `${expected.damage.toFixed(4)}  GCD ${expected.gcd.toFixed(2)}  ${seconds(expected.elapsedMs)}`;

// ---- 從 Supabase 取回回報

async function fetchRows(query: string): Promise<OptimizerReportRow[]> {
  // 後台顯示的 API URL 結尾帶有 /rest/v1/，貼上時一併去掉
  const url = process.env.SUPABASE_URL?.replace(/(\/rest\/v1)?\/*$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('需要環境變數 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY（可寫在 .env.local），或以 --file 指定本機檔案');
  }
  const headers: Record<string, string> = { apikey: key };
  // 舊式 service_role key 為 JWT，需同時放在 Authorization；新式 secret key（sb_secret_…）只需 apikey
  if (key.startsWith('eyJ')) headers['Authorization'] = `Bearer ${key}`;
  const rows: OptimizerReportRow[] = [];
  const pageSize = 50;  // 附輸入的資料列較大，分頁取回
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${url}/rest/v1/optimizer_reports?${query}&limit=${pageSize}&offset=${offset}`, { headers });
    if (!res.ok) throw new Error(`Supabase 回應 ${res.status} ${res.statusText}：${await res.text()}`);
    const page = await res.json() as OptimizerReportRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** 取回 id 大於 afterId 的資料列（依 id 排序）；--file 時改從本機檔案讀取 */
async function loadRows(afterId: number): Promise<OptimizerReportRow[]> {
  const file = arg('file');
  if (file !== undefined) {
    const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as OptimizerReportRow[] | { rows: OptimizerReportRow[] };
    return (Array.isArray(data) ? data : data.rows).filter(r => r.id === undefined || r.id > afterId);
  }
  console.log(`從 Supabase 取回 id > ${afterId} 的回報…`);
  return fetchRows(`select=*&id=gt.${afterId}&order=id.asc`);
}

/** 同一次計算的後續結果摘要 */
function describeFollowUps(report: FieldReport): string {
  if (report.followUps.length === 0) {
    return report.kind === 'slow' ? '，沒有後續結果（計算可能仍在進行、關閉頁面時未送出，或瀏覽器分頁當掉）' : '';
  }
  return '，' + report.followUps.map(r => {
    switch (r.kind) {
      case 'done': return `之後完成（${seconds(r.elapsedMs)}${r.result ? `，${r.result.damage.toFixed(4)}` : ''}）`;
      case 'cancelled': return `之後被取消（${seconds(r.elapsedMs)}）`;
      case 'abandoned': return `之後關閉頁面（${seconds(r.elapsedMs)}）`;
      case 'error': return `之後失敗（${seconds(r.elapsedMs)}：${r.error ?? ''}）`;
      default: return r.kind;
    }
  }).join('，');
}

function printReport(report: FieldReport): void {
  const { app, client } = report;
  console.log(`    回報 ${report.reportedAt.slice(0, 16).replace('T', ' ')}：` +
    `${report.kind === 'slow' ? '計算過久' : '失敗'}（${seconds(report.elapsedMs)}` +
    `${report.error ? `：${report.error}` : ''}）${describeFollowUps(report)}`);
  console.log(`      環境：版本 ${app.version}（${app.commit !== '' ? app.commit.slice(0, 7) : '未知 commit'}），` +
    `資料 ${app.patch}，${client.hardwareConcurrency ?? '?'} 核心，` +
    `記憶體 ${client.deviceMemory !== undefined ? `${client.deviceMemory} GB` : '?'}`);
}

/** 以目前版本（與 --reference 時的舊版）重算；回傳目前版本的輸出與舊版不一致的次數 */
function replay(fieldCase: FieldCase): { output?: RunOutput, mismatches: number } {
  let input: OptimizerInput;
  try {
    input = deserializeOptimizerInput(fieldCase.input);
  } catch (error) {
    console.log(`    ★ 無法還原輸入：${error instanceof Error ? error.message : String(error)}`);
    return { mismatches: 0 };
  }
  const output = runChild('current', input);
  console.log(`    目前版本：${describe(output)}`);
  let mismatches = 0;
  if (flag('reference')) {
    const ref = runChild('reference', input);
    let note = '';
    if (succeeded(ref) && succeeded(output)) {
      const consistent = ref.result!.damage === output.result!.damage;
      note = consistent ? '（與目前版本一致）' : '（★ 與目前版本不一致）';
      if (!consistent) mismatches++;
    }
    console.log(`    舊版：${describe(ref)}${note}`);
  }
  return { output, mismatches };
}

/** 取回新回報並存入案例集，重播新加入的案例並記錄結果 */
async function pullReports(): Promise<number> {
  const cases = loadCases();
  const byFingerprint = new Map(cases.map(c => [c.fingerprint, c]));
  const caseOfRun = new Map(cases.flatMap(c => c.reports.map(r => [r.runId, c] as const)));
  const lastId = Math.max(0, ...cases.flatMap(c => c.reports.flatMap(r => [r.id ?? 0, ...r.followUps.map(f => f.id ?? 0)])));
  const rows = await loadRows(lastId);
  const changed = new Set<FieldCase>();
  const added: FieldCase[] = [];
  let skipped = 0;
  // 附輸入的回報先處理，後續結果才找得到對應的計算
  for (const row of [ ...rows.filter(r => r.input), ...rows.filter(r => !r.input) ]) {
    if (row.input) {
      if (caseOfRun.has(row.run_id)) continue;  // 已保存（例如 --file 重複匯入）
      const fingerprint = fingerprintOf(row.input);
      let fieldCase = byFingerprint.get(fingerprint);
      if (fieldCase === undefined) {
        fieldCase = { fingerprint, name: caseName(row.input), reports: [], input: row.input };
        byFingerprint.set(fingerprint, fieldCase);
        added.push(fieldCase);
      }
      fieldCase.reports.push({
        id: row.id,
        runId: row.run_id,
        reportedAt: row.created_at ?? new Date().toISOString(),
        kind: row.kind,
        elapsedMs: row.elapsed_ms,
        error: row.error ?? undefined,
        app: row.app,
        client: { hardwareConcurrency: row.client.hardwareConcurrency, deviceMemory: row.client.deviceMemory },
        followUps: [],
      });
      caseOfRun.set(row.run_id, fieldCase);
      changed.add(fieldCase);
    } else {
      const fieldCase = caseOfRun.get(row.run_id);
      const report = fieldCase?.reports.find(r => r.runId === row.run_id);
      if (fieldCase === undefined || report === undefined || (row.id !== undefined && report.followUps.some(f => f.id === row.id))) {
        skipped++;
        continue;
      }
      report.followUps.push({
        id: row.id,
        kind: row.kind,
        elapsedMs: row.elapsed_ms,
        error: row.error ?? undefined,
        result: row.result ?? undefined,
      });
      changed.add(fieldCase);
    }
  }
  console.log(`取回 ${rows.length} 筆：新案例 ${added.length} 個，更新既有案例 ${changed.size - added.length} 個` +
    `${skipped > 0 ? `，略過 ${skipped} 筆沒有對應計算的後續結果` : ''}`);
  for (const fieldCase of changed) saveCase(fieldCase);

  let failures = 0;
  const targets = added.filter(c => filter === undefined || c.input.job === filter);
  for (const [ index, fieldCase ] of targets.entries()) {
    console.log(`[新案例 ${index + 1}/${targets.length}] ${fieldCase.name}  ${path.basename(caseFile(fieldCase))}`);
    fieldCase.reports.forEach(printReport);
    const { output, mismatches } = replay(fieldCase);
    failures += mismatches + (output !== undefined && succeeded(output) ? 0 : 1);
    if (output !== undefined) {
      fieldCase.expected = expectedOf(output);
      saveCase(fieldCase);
    }
  }
  if (targets.length < added.length) {
    console.log(`${added.length - targets.length} 個新案例被 --filter 排除，尚未記錄結果（之後以 --cases --update 記錄）`);
  }
  console.log(`案例集：${casesDir}（共 ${byFingerprint.size} 個案例）`);
  return failures;
}

/** 重播案例集，與記錄的結果比對；--update 時把有變化的案例記錄為目前版本的結果 */
function runCases(): number {
  const update = flag('update');
  const cases = loadCases().filter(c => filter === undefined || c.input.job === filter);
  if (cases.length === 0) {
    console.log(`${casesDir} 沒有案例`);
    return 0;
  }
  const counts = { same: 0, changed: 0, improved: 0, unfinished: 0, updated: 0 };
  let failures = 0;
  for (const [ index, fieldCase ] of cases.entries()) {
    console.log(`[${index + 1}/${cases.length}] ${fieldCase.name}  ${path.basename(caseFile(fieldCase))}  ` +
      `回報 ${fieldCase.reports.length} 次`);
    const { output, mismatches } = replay(fieldCase);
    const expected = fieldCase.expected;
    console.log(`    記錄：${expected !== undefined ?
      `${describeExpected(expected)}（${expected.commit !== '' ? expected.commit.slice(0, 7) : '未知 commit'}）` : '無'}`);
    let verdict: string;
    if (output === undefined || !succeeded(output)) {
      verdict = expected !== undefined && 'error' in expected ? '仍無法完成' : '★ 無法完成';
      counts.unfinished++;
    } else if (expected === undefined || 'error' in expected) {
      verdict = '改善：記錄時無法完成，現在可以完成';
      counts.improved++;
    } else if (output.result!.damage === expected.damage) {
      verdict = '一致';
      counts.same++;
    } else {
      verdict = `★ 傷害${output.result!.damage > expected.damage ? '較高' : '較低'}` +
        `（${(output.result!.damage - expected.damage).toExponential(3)}）`;
      counts.changed++;
    }
    console.log(`    ${verdict}`);
    failures += mismatches;
    if (update) {
      if (output !== undefined && verdict !== '一致') {
        fieldCase.expected = expectedOf(output);
        saveCase(fieldCase);
        counts.updated++;
      }
    } else if (verdict.startsWith('★')) {
      failures++;
    }
  }
  console.log(`一致 ${counts.same}，傷害改變 ${counts.changed}，改善 ${counts.improved}，無法完成 ${counts.unfinished}` +
    `${update ? `；已更新 ${counts.updated} 個案例的記錄` : ''}`);
  return failures;
}

if (process.argv[2] !== '--run') {
  (async () => {
    const failures = flag('cases') ? runCases() : await pullReports();
    console.log(failures === 0 ? '全部通過' : `${failures} 個問題`);
    process.exit(failures === 0 ? 0 : 1);
  })().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
