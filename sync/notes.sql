-- 主题笔记表
-- 用途：online-v1 主页的「笔记」模块，记录主题级思考，正文里可内嵌片段引用（.ref-inline）。
-- 存储：标题 / 标签 / 正文 HTML（正文含内联引用块，引用通过 data-clip-id 关联 clips 表）。
-- 安全模型：与 clips 表一致 —— 匿名只读；登录用户（authenticated）可写/改/删。

create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default '',
  tags       jsonb default '[]'::jsonb,   -- ["设卡人", "挡拆", ...] 纯标签字符串数组
  body       text not null default '',     -- 正文 HTML（含 .ref-inline 内联引用块）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notes_created_at_idx on public.notes (created_at desc);

-- 开启 RLS
alter table public.notes enable row level security;

-- 匿名只读（游客可浏览笔记，但不能写）
drop policy if exists "笔记公开读" on public.notes;
create policy "笔记公开读" on public.notes
  for select to anon, authenticated
  using (true);

-- 登录用户可新增笔记
drop policy if exists "笔记登录用户可写" on public.notes;
create policy "笔记登录用户可写" on public.notes
  for insert to authenticated
  with check (true);

-- 登录用户可改自己的笔记（这里不区分归属，所有登录用户都可改任意笔记；
-- 单人使用场景足够。若要多用户隔离，可加 user_id 列并改成 owner 匹配）
drop policy if exists "笔记登录用户可改" on public.notes;
create policy "笔记登录用户可改" on public.notes
  for update to authenticated
  using (true)
  with check (true);

-- 登录用户可删笔记
drop policy if exists "笔记登录用户可删" on public.notes;
create policy "笔记登录用户可删" on public.notes
  for delete to authenticated
  using (true);
