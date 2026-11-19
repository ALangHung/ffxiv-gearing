-- 配裝最佳化的問題回報（前端見 src/optimizerReport.ts，重播腳本見 test/optimizer/replay.ts）
-- 在 Supabase 專案的 SQL Editor 執行一次即可；可重複執行（已存在的物件會略過或取代）。
--
-- 權限設計：
-- - anon（前端使用的公開金鑰）只能新增，不能讀取、修改或刪除；新增時需使用 Prefer: return=minimal。
-- - 重播腳本以 service_role 金鑰讀取（略過 RLS），此金鑰只放在本機的 .env.local。

create table if not exists public.optimizer_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  run_id uuid not null,  -- 同一次計算的各筆回報相同
  kind text not null,
  elapsed_ms integer,
  error text,
  app jsonb not null default '{}',  -- { version, commit, patch }
  client jsonb not null default '{}',  -- { userAgent, hardwareConcurrency, deviceMemory }
  result jsonb,  -- done：{ damage, gcd, gcdUnmet }
  input jsonb,  -- slow／error：計算輸入（格式見 src/optimizerReportFormat.ts）

  constraint optimizer_reports_kind check (kind in ('slow', 'error', 'done', 'cancelled', 'abandoned')),
  -- slow 必須附輸入；error 可附可不附（已回報 slow 的計算失敗時不再重複附上）；其餘不附
  constraint optimizer_reports_input_kind check (
    (kind <> 'slow' or input is not null) and (kind in ('slow', 'error') or input is null)),
  constraint optimizer_reports_elapsed check (elapsed_ms is null or elapsed_ms between 0 and 86400000),
  constraint optimizer_reports_error_size check (error is null or char_length(error) <= 2000),
  constraint optimizer_reports_meta_size check (
    octet_length(app::text) <= 1000 and octet_length(client::text) <= 2000 and
    (result is null or octet_length(result::text) <= 1000)),
  -- 單一職業最寬的品級範圍約數百 KB，保留餘裕
  constraint optimizer_reports_input_size check (input is null or octet_length(input::text) <= 2000000)
);

create index if not exists optimizer_reports_created_at on public.optimizer_reports (created_at);
create index if not exists optimizer_reports_run_id on public.optimizer_reports (run_id);

alter table public.optimizer_reports enable row level security;

-- Supabase 預設會把 public schema 新資料表的所有權限授予 anon／authenticated，先全部收回
revoke all on table public.optimizer_reports from anon, authenticated;
grant insert (run_id, kind, elapsed_ms, error, app, client, result, input)
  on table public.optimizer_reports to anon;
-- 建立專案時若取消「自動公開新資料表」，service_role 不會自動取得權限；明確授予供重播腳本讀取與清理
grant select, delete on table public.optimizer_reports to service_role;

drop policy if exists optimizer_reports_anon_insert on public.optimizer_reports;
create policy optimizer_reports_anon_insert on public.optimizer_reports
  for insert to anon with check (true);
