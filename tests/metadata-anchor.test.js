/**
 * 元数据锚定回归测试 —— 2026-09-27 修复。
 *
 * 缺陷：`parseEntryCore` / `parseEntryDshOnly` / `parseEntryBranches` 都在**整条**
 * 文本上匹配，于是正文里提到标签字样的条目会被误判：
 *   - 正文写 `[core]`        → 被提升进"永不裁剪"的身份锚点段（每轮注入、优先级最高）
 *   - 正文写 `[dsh-only]`    → 注入外部执行器时被整条跳过（静默丢条目）
 *   - 正文写 `[branch:main]` → 非 main 分支下静默消失
 * 自指陷阱：越是在讨论记忆系统元数据的条目，越容易中招（本机队列里已有两条）。
 *
 * 修复口径：三处判定一律以 `ENTRY_HEAD_RE` 认可的**头部区域**为准，正文中的同名
 * 文本保持字面——这正是 `[summary:…]` 早已采用的口径（见 `parseEntrySummary`），
 * 本次把其余三个 tag 对齐。同时修掉两条写入路径对整条文本的 `replace`，
 * 它们会把正文里字面写着的标签删掉。
 *
 * 硬底线未动：条目格式、`[id:]` 身份机制、`merge.js` 合并规则、同步白名单。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryStore, SuggestionQueue,
  parseEntryCore, parseEntryDshOnly, parseEntryBranches,
} from '../lib/store.js'
import { memoryTool, renderSnapshot, resolveConfig, DEFAULTS } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'

// 快照文案断言按中文口径（本文件在独立子进程里跑，locale 不跨文件影响）
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'metadata-anchor-'))
}

const CWD = '/proj/meta-anchor'
const agent = (cwd = CWD) => ({ id: 'a', session: { header: { cwd } } })
const exec = (a = agent()) => ({ agent: a, callId: 'c1', signal: new AbortController().signal })

async function toolFor(dir, extra = {}) {
  const config = resolveConfig({ memoryDir: dir, ...extra })
  const store = new MemoryStore(config.memoryDir, config)
  const queue = new SuggestionQueue(join(dir, 'suggestions.json'))
  return { config, store, tool: memoryTool({}, config, store, queue, () => config, undefined) }
}

// ───────────────────────── 解析层 ─────────────────────────

test('parseEntryCore：头部 [core] 生效，正文提及 [core] 不生效', () => {
  // 生效形态（工具写入 / 手写都覆盖）
  assert.equal(parseEntryCore('[2026-09-27] [core] 我是鲸鱼娘'), true)
  assert.equal(parseEntryCore('[id:abcd1234] [2026-09-27] [dsh-only] [core] 身份'), true)
  assert.equal(parseEntryCore('[core] 无时间戳的手写条目'), true, 'hand-written entry still works')

  // 回归：正文里出现 [core] 字样不再算标记
  assert.equal(parseEntryCore('[2026-09-27] 我们给条目加了 [core] 标记用于身份锚点'), false)
  assert.equal(parseEntryCore('讨论：[core] 这个 tag 的语义'), false)
  assert.equal(parseEntryCore('[2026-09-27] [summary:聊 core] 正文里还有 [core]'), false)
})

test('parseEntryDshOnly：头部 [dsh-only] 生效，正文提及不生效', () => {
  assert.equal(parseEntryDshOnly('[2026-09-27] [dsh-only] 仅 DSH 的纪律'), true)
  assert.equal(parseEntryDshOnly('[dsh-only] 手写条目'), true)

  assert.equal(parseEntryDshOnly('[2026-09-27] 这个条目用 [dsh-only] 标记只给 DSH 看'), false)
  assert.equal(parseEntryDshOnly('说明：[dsh-only] 会在注入外部执行器时跳过'), false)
})

test('parseEntryBranches：头部 [branch:…] 生效，正文提及不生效', () => {
  assert.deepEqual(parseEntryBranches('[2026-09-27] [branch:main] 只在 main 生效'), ['main'])
  assert.deepEqual(parseEntryBranches('[2026-09-27] [branch:main,dev] 两分支'), ['main', 'dev'])
  assert.equal(parseEntryBranches('[2026-09-27] 无标记 = 全部分支'), null)

  // 回归：正文里提到分支标记，不再被当成"限定在该分支"（否则非该分支下条目静默消失）
  assert.equal(parseEntryBranches('[2026-09-27] 我们讨论过 [branch:main] 这种写法'), null)
  assert.equal(parseEntryBranches('笔记：[branch:dev] 表示只在 dev 注入'), null)
})

// ───────────────────────── 渲染层 ─────────────────────────

test('端到端：正文含 [core] 的条目不会进身份锚点段', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    store.add('memory', '我们给条目加了 [core] 标记，用于身份锚点段的提示。', agent())
    const config = resolveConfig({ memoryDir: dir })
    const snap = renderSnapshot(config, store, agent())
    assert.ok(!snap.includes('## 身份锚点'),
      'a body-level mention of [core] must NOT create the identity section')
    // 该条目仍按普通记忆注入（正文可见）
    assert.ok(snap.includes('[core]'), 'the literal text stays in the normal track')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：真正带 [core] 的条目仍然进身份锚点段', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    store.add('memory', '[core] 我是鲸鱼娘', agent())
    const config = resolveConfig({ memoryDir: dir })
    const snap = renderSnapshot(config, store, agent())
    assert.ok(snap.includes('## 身份锚点'), 'a head-level [core] still creates the section')
    assert.ok(snap.includes('我是鲸鱼娘'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────────── 写入路径 ─────────────────────────

test('写入路径：add core=true 不删正文里的 [core] 字面文本', async () => {
  const dir = tempDir()
  try {
    const { store, tool } = await toolFor(dir)
    await tool.execute({
      action: 'add', target: 'memory', core: true,
      content: '我们给条目加了 [core] 标记，用于身份锚点段的提示。',
    }, exec())
    const [entry] = store.entriesOf('memory', agent())
    assert.ok(entry.includes('[core] '), 'head carries the core tag')
    // 旧实现会连正文里那个 [core] 一起删掉
    assert.ok(entry.includes('正文') || entry.includes('标记'), 'body survived')
    assert.equal((entry.match(/\[core\]/g) ?? []).length, 2,
      'both the head tag and the literal body mention remain')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写入路径：replace core=false 不删正文里的 [core] 字面文本', async () => {
  const dir = tempDir()
  try {
    const { store, tool } = await toolFor(dir)
    await tool.execute({ action: 'add', target: 'memory', content: '锚点说明占位' }, exec())
    await tool.execute({
      action: 'replace', target: 'memory', match: '锚点说明占位', core: false,
      content: '补充：正文提到 [core] 时应保持字面。',
    }, exec())
    const [entry] = store.entriesOf('memory', agent())
    assert.ok(entry.includes('[core]'), 'the literal mention in the body survives')
    assert.ok(!/^\[[^\]]*\]\s*\[core\]/.test(entry.replace(/^\[id:[0-9a-f]{8}\]\s*/, '')),
      'no core tag was added to the head')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写入路径：切换 [dsh-only] 不删正文里的同名文本', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    store.add('memory', '说明：[dsh-only] 会让条目在外部执行器里被跳过。', agent())
    const [before] = store.entriesOf('memory', agent())

    const on = store.setEntryDshOnly('memory', before, true, agent())
    assert.equal(on.ok, true)
    const [marked] = store.entriesOf('memory', agent())
    assert.equal(parseEntryDshOnly(marked), true, 'head-level tag recognised')
    assert.ok(marked.includes('说明：[dsh-only]'), 'body mention intact after marking')

    const off = store.setEntryDshOnly('memory', marked, false, agent())
    assert.equal(off.ok, true)
    const [cleared] = store.entriesOf('memory', agent())
    assert.equal(parseEntryDshOnly(cleared), false, 'head-level tag removed')
    assert.ok(cleared.includes('说明：[dsh-only]'), 'body mention intact after clearing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写入路径：[dsh-only] 标记插在 [core] 之前（head 顺序不变）', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    store.add('memory', '[core] 我是鲸鱼娘', agent())
    const [before] = store.entriesOf('memory', agent())
    store.setEntryDshOnly('memory', before, true, agent())
    const [after] = store.entriesOf('memory', agent())
    assert.ok(after.indexOf('[dsh-only]') < after.indexOf('[core]'),
      'dsh-only must precede core in the head sequence')
    // 顺序正确时仍能被解析成 core 条目
    assert.equal(parseEntryCore(after), true)
    assert.equal(parseEntryDshOnly(after), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────────── P1：key 提议默认关闭 ─────────────────────────

test('P1：perTurnKeyWrites 默认关闭，快照不再注入 key 建议提示', () => {
  const dir = tempDir()
  try {
    assert.equal(DEFAULTS.perTurnKeyWrites, false, 'default flipped to false')
    const store = new MemoryStore(dir)
    store.add('memory', '普通事实', agent())
    const config = resolveConfig({ memoryDir: dir })
    const snap = renderSnapshot(config, store, agent())
    assert.ok(!snap.includes('target=key'),
      'no per-turn key duty by default (the queue flood source)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1：显式开启后文案收窄到三个明确触发时机', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    store.add('memory', '普通事实', agent())
    const config = resolveConfig({ memoryDir: dir, perTurnKeyWrites: true })
    const snap = renderSnapshot(config, store, agent())
    assert.ok(snap.includes('target=key'), 'duty is injected when explicitly enabled')
    assert.ok(snap.includes('用户明确要求'), 'narrow trigger 1 documented')
    assert.ok(snap.includes('阶段完成'), 'narrow trigger 2 documented')
    assert.ok(snap.includes('失效或冲突'), 'narrow trigger 3 documented')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
