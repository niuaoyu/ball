-- tactic-lab 待导入队列表
-- 用途：前端（油猴脚本 / 本地 index.html）标记片段后，通过本地 bridge 服务（/queue）
--       以 service_role 写入这里；电脑端 node import.js --queue 批量消费，按需下载裁剪。
-- 安全模型：入队/撤回统一走本地 bridge（service_role），前端不再直连 Supabase。
--           匿名仅保留只读（预演用）；只有 service_role 能写/改/删。

create table if not exists public.pending_imports (
  id          text primary key,          -- 脚本生成的 clip 前缀 id（uid）
  provider    text not null default 'weibo', -- 来源：weibo / tencent
  source_url  text,                       -- 标记时的视频页地址（用于 yt-dlp 重新解析）
  fid         text,                       -- 微博 fid，如 1034:5347658597072899（腾讯为空）
  page_url    text,                       -- 旧字段兼容，后续使用 source_url
  title       text default '',           -- 视频标题（脚本从 document.title 摘）
  start_sec   double precision not null, -- 片段起点（视频 currentTime，秒）
  end_sec     double precision not null, -- 片段终点（秒）
  mode        text not null default 'clip', -- clip=裁剪片段 / full=下载完整视频
  tags        jsonb default '[]'::jsonb, -- [{dimension, value}]
  note        text default '',
  status      text not null default 'pending',  -- pending / done / failed
  created_at  timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists pending_imports_status_idx on public.pending_imports (status, created_at);

-- 开启公开匿名插入（所有人可写 pending_imports 的 INSERT）
alter table public.pending_imports enable row level security;

drop policy if exists "公开插入待导入" on public.pending_imports;
create policy "公开插入待导入" on public.pending_imports
  for insert to anon
  with check (true);

-- 公开读（预演 / 调试用；也可收紧，但先保持一致）
drop policy if exists "公开读待导入" on public.pending_imports;
create policy "公开读待导入" on public.pending_imports
  for select to anon
  using (true);

-- 只有 service_role 能改/删（service_role 默认绕过 RLS，无需额外策略，
-- 但显式不给 anon 的 update/delete 权限即已阻止）

-- 已有表的升级迁移：如果之前已经按微博版本建过表，执行下面几句。
-- 注意：旧 page_url / fid 数据继续保留，代码会自动兼容。
alter table public.pending_imports add column if not exists provider text not null default 'weibo';
alter table public.pending_imports add column if not exists source_url text;
alter table public.pending_imports add column if not exists mode text not null default 'clip';
alter table public.pending_imports alter column fid drop not null;
alter table public.pending_imports alter column page_url drop not null;

update public.pending_imports
set source_url = page_url
where source_url is null and page_url is not null;
