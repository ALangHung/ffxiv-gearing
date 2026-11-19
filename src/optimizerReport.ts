// 配裝最佳化的問題回報：計算過久或失敗時，自動把計算條件送到 Supabase，
// 供重播腳本（npm run test-optimizer-replay）取回分析、改進演算法。
//
// 建置時設定 SUPABASE_URL 與 SUPABASE_ANON_KEY 才會啟用（見 rspack.config.cjs，開發模式預設不啟用），
// 啟用時介面會告知使用者。資料表與權限見 supabase/optimizer_reports.sql：anon 只能新增，無法讀取任何回報。
//
// 回報流程（同一次計算的各筆回報以 run_id 串起，實作見 src/stores/Store.ts）：
// - 計算超過 SLOW_THRESHOLD 仍未完成時送出 slow（附計算輸入）；
//   之後該次計算完成、失敗、被取消或關閉頁面時，再補送 done／error／cancelled／abandoned（不附輸入）。
// - 計算在 SLOW_THRESHOLD 內失敗時送出 error（附計算輸入）。

import type { OptimizerReportRow } from './optimizerReportFormat';

declare const __VERSION__: string;
declare const __PATCH__: string;
declare const __COMMIT__: string;
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

export const optimizerReportEnabled = __SUPABASE_URL__ !== '' && __SUPABASE_ANON_KEY__ !== '';

/** 計算超過此時間（毫秒）仍未完成時，自動回報 slow */
export const SLOW_THRESHOLD = 30_000;

/** 每次載入頁面最多送出的回報筆數，避免異常狀況下大量送出 */
const MAX_REPORTS_PER_PAGE = 20;
let reportCount = 0;

export const optimizerReportApp: OptimizerReportRow['app'] = {
  version: __VERSION__,
  commit: __COMMIT__,
  patch: __PATCH__,
};

export function optimizerReportClient(): OptimizerReportRow['client'] {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
  };
}

/** 產生 run_id；randomUUID 只在安全環境（HTTPS、localhost）可用 */
export function newOptimizerRunId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 新增一筆回報。keepalive 用於關閉頁面時送出（內容需小於 64 KB，因此只用於不附輸入的後續回報）。
 * 使用 return=minimal：anon 沒有讀取權限，要求回傳新增的資料會被 RLS 拒絕。
 */
export async function sendOptimizerReport(row: OptimizerReportRow, keepalive = false): Promise<void> {
  if (!optimizerReportEnabled) throw new Error('未設定回報服務');
  if (reportCount >= MAX_REPORTS_PER_PAGE) throw new Error('本頁面的回報次數已達上限');
  reportCount++;
  const headers: Record<string, string> = {
    'apikey': __SUPABASE_ANON_KEY__,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };
  // 舊式 anon key 為 JWT，需同時放在 Authorization；新式 publishable key（sb_publishable_…）只需 apikey
  if (__SUPABASE_ANON_KEY__.startsWith('eyJ')) headers['Authorization'] = `Bearer ${__SUPABASE_ANON_KEY__}`;
  const res = await fetch(`${__SUPABASE_URL__}/rest/v1/optimizer_reports`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
    keepalive,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json() as { message?: string };
      if (body.message) message += `：${body.message}`;
    } catch {
      // 回應不是 JSON
    }
    throw new Error(message);
  }
}
