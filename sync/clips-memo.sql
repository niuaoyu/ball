-- clips 表新增 memo 字段（思考笔记）
-- 用途：网页端播放浮层 / 编辑弹层里的「思考笔记」，与「油猴备注=标题」彻底分开。
--
-- 背景：历史链路里，油猴脚本的「备注」输入框实际是当「标题」用的
--   （sync.js: title = clip.note || matchTitle），导致 clips.note 字段和 title 重复。
--   现在把「真正的思考笔记」独立到 memo 字段，note 字段保留作历史兼容、不再新写。
--
-- 字段语义（最终版）：
--   title  卡片标题（油猴「备注」一句话概括片段）
--   note   历史遗留字段（= title，废弃，不再新写）
--   memo   思考笔记（网页端写，本迁移新增）

alter table public.clips add column if not exists memo text not null default '';

-- （可选）把历史里 note 与 title 重复的数据，把 note 清空以保持干净
-- 注意：这只会影响「note == title」的冗余数据；如果某条 note 是独立内容则保留。
-- update public.clips set note = '' where note = title;
