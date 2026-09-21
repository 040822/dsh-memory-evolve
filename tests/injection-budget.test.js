/**
 * 注入瘦身（2026-09-22）回归测试：快照预算、摘要注入、按轨裁剪、三轨 expand。
 *
 * 背景：快照是**每轮常驻**成本。改造前本机实测 3048 字符/轮（memory 轨 4 条
 * 全量 2132 + 固定文案 ~800）。改造后默认三轨走渐进式披露（摘要一行/条），
 * 并按 snapshotCharBudget 做总量硬约束；裁掉的条目必须仍能按 id 取回全文。
 *
 * 这些断言同时钉住"省 token"的成果不要被后续改动悄悄吃回去。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, autoSummary } from '../lib/store.js'
import { renderSnapshot, resolveConfig, DEFAULTS } from '../lib/index.js'
import { legacyIdFor, extractEntryId } from '../lib/sync/entryid.js'
import { SNAPSHOT_DICT, setLocale } from '../lib/i18n.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'injection-budget-'))
}

const agent = (cwd = '/proj/budget') => ({ id: 'a', session: { header: { cwd } } })

/** 造 n 条长条目（每条 body 字符数可控），返回 store。 */
function seed(dir, target, n, bodyLen, cwd = '/proj/budget') {
  const store = new MemoryStore(dir)
  for (let i = 0; i < n; i += 1) {
    store.add(target, `第 ${i} 条 ${'x'.repeat(bodyLen)}`, agent(cwd))
  }
  return store
}

test('快照预算是硬约束：超量记忆也不超过 snapshotCharBudget', () => {
  const dir = tempDir()
  try {
    const store = seed(dir, 'memory', 12, 300)
    const config = resolveConfig({ memoryDir: dir })
    const snap = renderSnapshot(config, store, agent())
    assert.ok(snap.length <= config.snapshotCharBudget,
      `snapshot ${snap.length} must stay within budget ${config.snapshotCharBudget}`)
    assert.ok(snap.length < 1200, 'and comfortably below the pre-slim baseline')
    // 摘要注入：不出现正文（正文片段 'xxxx' 只可能来自全量注入）
    assert.ok(!snap.includes('x'.repeat(120)), 'long bodies must not be injected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('按轨裁剪：从最旧条目开始裁，并追加"其余 N 条"取回提示', () => {
  const dir = tempDir()
  try {
    const store = seed(dir, 'memory', 12, 200)
    const config = resolveConfig({ memoryDir: dir })
    const snap = renderSnapshot(config, store, agent())
    assert.match(snap, /其余 \d+ 条用 memory action=list 读取/, 'trimmed hint present')
    const trimmed = Number(/其余 (\d+) 条/.exec(snap)[1])
    assert.ok(trimmed > 0 && trimmed < 12, `trimmed count ${trimmed} in (0,12)`)
    // 最旧的条目被裁（第 0 条），最新的保留
    assert.ok(!snap.includes('第 0 条'), 'oldest entries are trimmed first')
    assert.ok(snap.includes('第 11 条'), 'newest entry stays injected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('小数据量走全量注入（auto 双阈值内）', () => {
  const dir = tempDir()
  try {
    const store = seed(dir, 'memory', 2, 20)
    const config = resolveConfig({ memoryDir: dir })
    const snap = renderSnapshot(config, store, agent())
    assert.ok(snap.includes('第 0 条'), 'small track injects full text')
    assert.ok(!snap.includes('action=expand+id'), 'no summary hint for tiny tracks')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('三轨共用渐进式披露：memory / user / key 都按配置走摘要', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const a = agent()
    for (const target of ['memory', 'user', 'key']) {
      for (let i = 0; i < 4; i += 1) store.add(target, `[summary:${target}-${i} 摘要] ${target} 正文 ${i}`, a)
    }
    const config = resolveConfig({
      memoryDir: dir,
      memoryProgressiveDisclosure: 'on',
      userProgressiveDisclosure: 'on',
      keyProgressiveDisclosure: 'on',
    })
    const snap = renderSnapshot(config, store, a)
    for (const target of ['memory', 'user', 'key']) {
      assert.ok(snap.includes(`${target}-0 摘要`), `${target} summary injected`)
    }
    assert.ok(!snap.includes('正文 0'), 'no full body leaks in summary mode')
    // 每轨至少一条 + 取回提示（预算裁剪兜底）
    assert.ok(snap.includes('/'), 'snapshot rendered')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('expand：memory / user / key 三轨都能按 id 取回全文（摘要注入的 id 可展开）', async () => {
  const dir = tempDir()
  try {
    const { memoryTool } = await import('../lib/index.js')
    const { SuggestionQueue } = await import('../lib/store.js')
    const config = resolveConfig({ memoryDir: dir, memoryProgressiveDisclosure: 'on' })
    const store = new MemoryStore(config.memoryDir, config)
    const queue = new SuggestionQueue(join(dir, 'suggestions.json'))
    const tool = memoryTool({}, config, store, queue, () => config, undefined)
    const a = agent()
    const exec = { agent: a, callId: 'c1', signal: new AbortController().signal }

    for (const target of ['memory', 'user', 'key']) {
      store.add(target, `[summary:短摘要] ${target} 的完整正文内容`, a)
    }
    // memory / user：全局轨，无需 cwd 也能 expand
    for (const target of ['memory', 'user', 'key']) {
      const entries = store.entriesOf(target, a)
      const id = extractEntryId(entries[0]) ?? legacyIdFor(entries[0])
      const out = await tool.execute({ action: 'expand', target, id }, exec)
      assert.equal(out.ok, true, `${target} expand ok: ${out.message}`)
      assert.ok(out.entries[0].includes(`${target} 的完整正文内容`), `${target} full text returned`)
      assert.ok(!out.entries[0].includes('[summary:'), 'summary tag stripped')
    }
    // 未知 id → 明确报错（不抛）
    const miss = await tool.execute({ action: 'expand', target: 'memory', id: 'deadbeef' }, exec)
    assert.equal(miss.ok, false)
    // 不支持的轨 → 明确报错
    const badTrack = await tool.execute({ action: 'expand', target: 'daily', id: 'deadbeef' }, exec)
    assert.equal(badTrack.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('固定注入文案长度上限（zh/en）：防"每轮常驻"文案回涨', () => {
  const limits = {
    // key: [zh 上限, en 上限]
    'snap.sessionPlain': [80, 130],
    'snap.readHint': [60, 120],
    'snap.todoHint': [70, 160],
    'snap.feedbackDuty': [60, 170],
    'snap.turnEndHead': [95, 220],
    'snap.subagentTurnEndHead': [80, 190],
    'snap.batchWriteDuty': [70, 160],
    'snap.keyDuty': [65, 160],
    'snap.writeGuardWarning': [165, 350],
  }
  for (const [key, [zhMax, enMax]] of Object.entries(limits)) {
    const pair = SNAPSHOT_DICT[key]
    assert.ok(Array.isArray(pair) && pair.length === 2, `${key} must be a [zh,en] pair`)
    assert.ok(pair[0].length <= zhMax, `${key} zh ${pair[0].length} > ${zhMax}`)
    assert.ok(pair[1].length <= enMax, `${key} en ${pair[1].length} > ${enMax}`)
  }
})

test('快照总长度：本机量级数据（4 条长记忆）下 zh/en 都远低于旧基线', () => {
  const dir = tempDir()
  const saved = process.env.DSH_LOCALE
  try {
    const store = seed(dir, 'memory', 4, 500)
    const config = resolveConfig({ memoryDir: dir })
    for (const locale of ['zh', 'en']) {
      setLocale(locale)
      const snap = renderSnapshot(config, store, agent())
      // 旧基线：本机真实数据 zh 3048 / en 4519 字符（全量注入 + 长文案）
      assert.ok(snap.length <= 1400, `${locale} snapshot ${snap.length} <= 1400`)
      assert.ok(snap.length <= config.snapshotCharBudget + 200, `${locale} within budget envelope`)
    }
  } finally {
    setLocale('zh')
    if (saved === undefined) delete process.env.DSH_LOCALE
    else process.env.DSH_LOCALE = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('默认配置：三轨渐进式披露默认 auto（省 token 不依赖用户手动开启）', () => {
  assert.equal(DEFAULTS.memoryProgressiveDisclosure, 'auto')
  assert.equal(DEFAULTS.userProgressiveDisclosure, 'auto')
  assert.equal(DEFAULTS.keyProgressiveDisclosure, 'auto')
  assert.equal(DEFAULTS.trackFullInjectThreshold, 3)
  assert.equal(DEFAULTS.trackFullInjectCharLimit, 1500)
  assert.equal(DEFAULTS.snapshotCharBudget, 1200)
})

test('autoSummary 兜底长度受控（无 [summary:] 的旧条目不会把快照撑爆）', () => {
  const line = autoSummary('【很长的正文首行】' + 'y'.repeat(300), 90)
  assert.ok(line.length <= 90, `autoSummary length ${line.length} <= 90`)
})
