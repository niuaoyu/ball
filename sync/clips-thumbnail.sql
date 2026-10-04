-- clips 表新增 thumbnail_url 字段（卡片封面缩略图）
-- 用途：网页端卡片墙 / 引用选择器 / 笔记内联引用，用 <img> 加载缩略图 JPG 代替 <video>，
--       避免每次刷新为每个卡片拉完整视频导致加载缓慢。
--
-- 缩略图生成：sync.js 上传片段时用 ffmpeg 抽 0.5s 帧（宽 480px）→ R2 的 clips/{folder}/{id}.jpg，
--           并在本字段写入该 URL。
-- 历史数据：老片段没有 thumbnail_url，前端对空值回退显示占位图（▶ + 时长），不影响展示。

alter table public.clips add column if not exists thumbnail_url text;
