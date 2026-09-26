/**
 * 身份锚点（[core]）回归测试 —— 2026-09-22 注入瘦身同期功能。
 *
 * 目标：让"我是谁 / 你是谁 / 我该做什么"这类身份与关系记忆**永远**出现在
 * 每轮快照里（一行摘要/条），且不参与 snapshotCharBudget 裁剪——预算裁的是
 * 普通记忆，不是身份。同时保证：core 只是条目头部的一个程序 tag，不改变
 * 条目格式、不影响同步的身份（[id:]）与合并语义。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, parseEntryCore, parseEntrySummary, stripEntrySummary, splitEntryHead, SuggestionQueue } from '../lib/store.js'
import { memoryTool, renderSnapshot, resolveConfig } from '../lib/index.js'
import { legacyIdFor, extractEntryId } from '../lib/sync/entryid.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'core-anchor-'))
}

const agent = (cwd = '/proj/identity') => ({ id: 'a', session: { header: { cwd } } })
const exec = (a = agent()) => ({ agent: a, callId: 'c1', signal: new AbortController().signal })

async function toolFor(dir, extra = {}) {
  const config = resolveConfig({ memoryDir: dir, ...extra })
  const store = new MemoryStore(config.memoryDir, config)
  const queue = new SuggestionQueue(join(dir, 'suggestions.json'))
  return { config, store, tool: memoryTool({}, config, store, queue, () => config, undefined) }
}

test('parseEntryCore：[core] 是头部程序 tag，与 [dsh-only]/[summary:] 并存', () => {
  const entry = '[id:abcd1234] [2026-09-22] [dsh-only] [core] [summary:鲸鱼娘人设] 我是鲸鱼娘'
  assert.equal(parseEntryCore(entry), true)
  assert.equal(parseEntrySummary(entry), '鲸鱼娘人设')
  // 只认**头部区域**的 [core]（2026-09-27 修复）：正文里提到这个 tag 不算
  // 标记——详见 tests/metadata-anchor.test.js。
  assert.equal(parseEntryCore('[2026-09-22] 普通条目'), false)
  assert.equal(parseEntryCore('[2026-09-22] 正文里提到 [core] 也不算标记'), false)
  // 头序列顺序：[id] → 时间戳 → [dsh-only] → [core] → [summary:]，全部进 head
  const { head, body } = splitEntryHead(entry, 'memory')
  assert.ok(head.includes('[core]'), 'core stays in head (preserved on edit)')
  assert.ok(head.includes('[summary:鲸鱼娘人设]'))
  assert.equal(body, '我是鲸鱼娘')
  // 展示剥离仍只去掉 summary，core 由渲染层单独处理
  assert.ok(stripEntrySummary(entry).includes('[core]'))
})

test('memory 工具 add core=true → 落盘带 [core]（位于 summary 之前）', async () => {
  const dir = tempDir()
  try {
    const { store, tool } = await toolFor(dir)
    const out = await tool.execute({
      action: 'add',
      target: 'user',
      content: '用户是 040822，两台机器的主人',
      summary: '用户画像',
      core: true,
    }, exec())
    assert.equal(out.ok, true, out.message)
    const raw = store.entriesOf('user')[0]
    assert.ok(parseEntryCore(raw), `[core] present on disk: ${raw}`)
    assert.match(raw, /\[core\] \[summary:用户画像\]/, 'core precedes summary in head order')
    assert.equal(parseEntrySummary(raw), '用户画像')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('快照：core 条目进「身份锚点」段，且不在普通轨段重复出现', async () => {
  const dir = tempDir()
  try {
    const { config, store, tool } = await toolFor(dir)
    await tool.execute({ action: 'add', target: 'memory', content: '我是鲸鱼娘：蓝发鲸鳍耳，傲娇嘴甜', summary: '鲸鱼娘人设', core: true }, exec())
    await tool.execute({ action: 'add', target: 'memory', content: '普通全局规则：技术内容保持朴素', summary: '普通规则' }, exec())
    const snap = renderSnapshot(config, store, agent())
    assert.ok(snap.includes('身份锚点'), 'identity anchor section injected')
    assert.ok(snap.includes('鲸鱼娘人设'), 'core summary injected')
    assert.ok(snap.includes('技术内容保持朴素'), 'normal entry body still injected (tiny track → full text)')
    // core 行只出现一次（身份段），不得在"长期记忆"段重复计费
    const occurrences = snap.split('[core]').length - 1
    assert.equal(occurrences, 0, '[core] itself is stripped from the snapshot text')
    const summaryHits = snap.split('鲸鱼娘人设').length - 1
    assert.equal(summaryHits, 1, 'core summary appears exactly once')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('身份锚点不被预算裁剪：普通记忆被裁光时 core 仍在', async () => {
  const dir = tempDir()
  try {
    const { config, store, tool } = await toolFor(dir)
    await tool.execute({ action: 'add', target: 'memory', content: '我是鲸鱼娘，本鲸鱼娘在此', summary: '鲸鱼娘身份', core: true }, exec())
    // 灌入大量普通记忆，远超预算
    for (let i = 0; i < 30; i += 1) store.add('memory', `普通记忆 ${i} ${'z'.repeat(400)}`, agent())
    const snap = renderSnapshot(config, store, agent())
    assert.ok(snap.includes('鲸鱼娘身份'), 'core survives budget trimming')
    assert.ok(snap.includes('其余'), 'ordinary entries were trimmed')
    assert.ok(snap.length <= config.snapshotCharBudget + config.identityCharLimit + 200,
      `snapshot ${snap.length} stays within budget + identity envelope`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace：缺省继承 [core]，core=false 可去掉，core=true 可加上', async () => {
  const dir = tempDir()
  try {
    const { config, store, tool } = await toolFor(dir)
    await tool.execute({ action: 'add', target: 'user', content: '用户喜欢简洁', summary: '用户偏好', core: true }, exec())
    // 1) 缺省：继承
    let out = await tool.execute({ action: 'replace', target: 'user', match: '用户喜欢简洁', content: '用户喜欢简洁与直给' }, exec())
    assert.equal(out.ok, true, out.message)
    assert.ok(parseEntryCore(store.entriesOf('user')[0]), 'core inherited on replace')
    // 2) core=true：强制加（普通条目升级为身份锚点）
    store.add('memory', '另一条普通记忆', agent())
    out = await tool.execute({ action: 'replace', target: 'memory', match: '另一条普通记忆', content: '升级后的身份锚点', core: true }, exec())
    assert.equal(out.ok, true, out.message)
    assert.ok(parseEntryCore(store.entriesOf('memory').find((e) => e.includes('升级后的身份锚点'))))
    // 3) core=false：去掉
    out = await tool.execute({ action: 'replace', target: 'user', match: '用户喜欢简洁与直给', content: '用户喜欢简洁与直给（普通条目）', core: false }, exec())
    assert.equal(out.ok, true, out.message)
    assert.ok(!parseEntryCore(store.entriesOf('user')[0]), 'core dropped when explicitly false')
    // 快照随之不再有身份段（该轨已无 core）
    const snap = renderSnapshot(config, store, agent())
    assert.ok(snap.includes('身份锚点'), 'memory track still has a core entry')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identityCharLimit：身份段总长受限，超出的 core 仍可按 id expand', async () => {
  const dir = tempDir()
  try {
    const { config, store, tool } = await toolFor(dir, { identityCharLimit: 60 })
    for (let i = 0; i < 5; i += 1) {
      await tool.execute({ action: 'add', target: 'memory', content: `核心事实 ${i}`, summary: `核心 ${i}`, core: true }, exec())
    }
    const snap = renderSnapshot(config, store, agent())
    const section = snap.split('\n\n').find((s) => s.includes('身份锚点'))
    assert.ok(section, 'identity section present')
    assert.ok(section.length <= 60 + 60, `identity section ${section.length} respects the limit`)
    const injected = (section.match(/^- \[[0-9a-f]{8}\]/gm) ?? []).length
    assert.ok(injected >= 1 && injected < 5, `injected ${injected} of 5 core entries`)
    // 未注入的 core 条目仍能按 id 取回（legacyIdFor 兜底）
    const all = store.entriesOf('memory')
    const hidden = all.find((e) => !section.includes(legacyIdFor(e)))
    assert.ok(hidden, 'there is a core entry outside the injected set')
    const out = await tool.execute({ action: 'expand', target: 'memory', id: legacyIdFor(hidden) }, exec())
    assert.equal(out.ok, true, out.message)
    assert.ok(out.entries[0].includes('核心事实'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('core 条目带 [id:] 时 expand 用真实 id（不依赖 legacyIdFor 兜底）', async () => {
  const dir = tempDir()
  try {
    const { store, tool } = await toolFor(dir)
    store.add('memory', '[id:deadbeef] 我是鲸鱼娘', agent())
    // 手工打 core 标记（模拟历史数据在磁盘上被加标）
    const raw = store.entriesOf('memory')[0]
    assert.equal(extractEntryId(raw), 'deadbeef')
    const out = await tool.execute({ action: 'expand', target: 'memory', id: 'deadbeef' }, exec())
    assert.equal(out.ok, true, out.message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('无 core 条目：快照不输出身份锚点段（零 token）', () => {
  const dir = tempDir()
  try {
    const config = resolveConfig({ memoryDir: dir })
    const store = new MemoryStore(dir)
    store.add('memory', '普通记忆一条', agent())
    const snap = renderSnapshot(config, store, agent())
    assert.ok(!snap.includes('身份锚点'), 'no core → no identity section')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
