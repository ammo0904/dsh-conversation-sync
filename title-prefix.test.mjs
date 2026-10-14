import test from 'node:test'
import assert from 'node:assert/strict'
import { attachTitlePrefix } from './title-prefix.mjs'

function harness() {
  const listeners = new Map()
  const calls = []
  const titles = new WeakMap()
  const ctx = {
    sessionTitle: {
      get(session) {
        const title = titles.get(session)
        return title === undefined ? undefined : { title }
      },
      rename(session, title) {
        calls.push(title)
        titles.set(session, title)
      }
    },
    on(type, handler) {
      listeners.set(type, handler)
      return () => listeners.delete(type)
    },
    logger: { warn() {} }
  }
  return { ctx, calls, titles, listeners }
}

function session({ events = [], isSeeded = false, parentSession } = {}) {
  return {
    header: { isSeeded, ...(parentSession === undefined ? {} : { parentSession }) },
    snapshotEvents: () => events
  }
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

test('只為本機新會話的官方自動標題加上前綴', async () => {
  const h = harness()
  attachTitlePrefix(h.ctx, () => '家裡_')
  const s = session()
  h.listeners.get('session/created')(s)
  h.titles.set(s, '整理同步需求')
  h.listeners.get('session/event')(s, {
    type: 'session/title',
    data: { title: '整理同步需求', source: { kind: 'fallback' } }
  })
  await settle()
  assert.deepEqual(h.calls, ['家裡_整理同步需求'])
})

test('歷史、下載 seed 與 fork 會話不會被改名', async () => {
  const h = harness()
  attachTitlePrefix(h.ctx, () => '公司_')
  const old = session({ events: [{ type: 'user/message' }] })
  const seeded = session({ isSeeded: true })
  const fork = session({ parentSession: 'parent' })
  for (const s of [old, seeded, fork]) {
    h.listeners.get('session/created')(s)
    h.titles.set(s, '原標題')
    h.listeners.get('session/event')(s, {
      type: 'session/title',
      data: { title: '原標題', source: { kind: 'fallback' } }
    })
  }
  await settle()
  assert.deepEqual(h.calls, [])
})

test('不重複前綴，也忽略手動標題與遞迴事件', async () => {
  const h = harness()
  attachTitlePrefix(h.ctx, () => '家裡_')
  const s = session()
  h.listeners.get('session/created')(s)
  h.titles.set(s, '家裡_已加前綴')
  h.listeners.get('session/event')(s, {
    type: 'session/title',
    data: { title: '家裡_已加前綴', source: { kind: 'fallback' } }
  })
  h.listeners.get('session/event')(s, {
    type: 'session/title',
    data: { title: '使用者命名', source: { kind: 'user' } }
  })
  await settle()
  assert.deepEqual(h.calls, [])
})

test('前綴取得失敗時不會讓事件處理器拋出', async () => {
  const h = harness()
  attachTitlePrefix(h.ctx, async () => { throw new Error('設定尚未載入') })
  const s = session()
  h.listeners.get('session/created')(s)
  h.titles.set(s, '新會話')
  h.listeners.get('session/event')(s, {
    type: 'session/title',
    data: { title: '新會話', source: { kind: 'fallback' } }
  })
  await settle()
  assert.deepEqual(h.calls, [])
})
