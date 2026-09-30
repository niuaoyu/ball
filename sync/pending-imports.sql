-- tactic-lab 待导入队列表
-- 用途：油猴脚本在微博页标记片段后，把「视频页地址 + 起止时间 + 标签」写进这里，
--       电脑端 node import.js --queue 批量消费，按需下载裁剪。
-- 安全模型：公开匿名可 INSERT（和 clips 表同样的公开可读思路），
--           但只有 service_role 能 UPDATE/DELETE（防止被篡改、被删）。

create table if not exists public.pending_imports (
  id          text primary key,          -- 脚本生成的 clip 前缀 id（uid）
  fid         text not null,             -- 微博 fid，如 1034:5347658597072899
  page_url    text not null,             -- 标记时的视频页地址（用于 yt-dlp 重新解析）
  title       text default '',           -- 视频标题（脚本从 document.title 摘）
  start_sec   double precision not null, -- 片段起点（视频 currentTime，秒）
  end_sec     double precision not null, -- 片段终点（秒）
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
