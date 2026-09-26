# AGENTS.md —— dsh-memory-evolve

DSH 记忆插件（fork 自 `csyangwen/dsh-memory-evolve`，上游 base `c337dc1`）。本仓库是**开发副本**，本机 profile 以 `link:` 指向它。

## 硬底线（不可改）

- 条目格式：`[id:…] [日期] [git …] [branch:…] [dsh-only] [core] [summary:…] 正文`，条目之间以 `\n§\n` 分隔
- `[id:]` 身份机制、`legacyIdFor`、`lib/sync/merge.js` 合并规则、`lib/sync/filesets.js` 同步白名单 —— **一律不改**（它们是跨机同步的身份与合并基础）
- 头部标签有固定顺序（id → 时间戳 → git → branch → dsh-only → core → summary）；判断标签是否生效一律以**头部区域**为准（`lib/store.js` 的 `headRegionOf`），正文里同名文本保持字面

## 开发与验证

- 测试：`node --test 'tests/*.test.js'`。已知**环境性**失败（不算回归）：`update.test.js`（依赖 git 远端）、`search-docs.test.js`（平台探测）、`i18n.test.js`（跨日敏感）——判断改动是否有害，要看失败集合是否新增
- 改动涉及快照渲染/预算时，用工作区的 `tmp-budget-repro.mjs` 复核；预算契约是 `快照长度 ≤ max(snapshotCharBudget, 固定段长度)`，`[core]` 段在总预算内、优先保留、最后才被省略
- 常驻成本只花在"每轮都必须知道"的内容上；能按需读的一律不注入（project/daily 故意不进快照）

## 装机与发布

- 改完要 `sudo systemctl restart dsh-web.service` 才生效（link 装机，运行中的进程用的是旧代码）
- 本地产副本下**不要点插件「更新」按钮**（会 checkout 离开开发分支）
- 客户端是构建产物：`src/client/**` 改动需要 esbuild 重建 `lib/client.js`，**本机没有 esbuild** —— 未重建前不要改客户端源码
- 发布纪律与版本/Tag 纪律见仓库根 `AGENTS.md`（本地测试通过才谈推送；版本号与 tag 由用户决定）

## 设计约定

- `[core]` 的语义是"永久注入"，不是"重要"：写入前先问"不知道会不会出错"
- key 轨只放"当前仍有效、且模型在行动前不知道就容易犯错"的项目约束；写不进这个标准的，走 project（证据）或项目 AGENTS.md（规则）
