// 0.5.1 忽略清單測試：不同步、備份後從本機移除、不再被下載回來。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { SyncClient, ignoredIds } from './core.mjs'
import { encodeZstdContainer } from './zstd-frames.mjs'
import { projectKey } from './dsh-lease.mjs'

const LOCAL = 'C:\\Users\\admin\\Desktop\\Test'
const FOREIGN = 'C:\\Users\\USER\\Desktop\\test'
const uuid = () => crypto.randomUUID()

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-ignore-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true })
  return home
}

function log(id, cwd) {
  const header = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: `session-${id}`, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 }) + '\n', 'utf8')
  const events = Buffer.from(JSON.stringify({ type: 'user/message', seq: 2, data: { marker: id } }), 'utf8')
  return encodeZstdContainer([header, events])
}

async function place(home, projectDir, id, buffer) {
  const dir = path.join(home, 'sessions', projectDir, `session-${id}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), buffer)
  return dir
}

test('忽略清單可解析 session- 前綴、大小寫與多種分隔', () => {
  const a = uuid(), b = uuid()
  const set = ignoredIds(`session-${a.toUpperCase()}, ${b}\n`)
  assert.deepEqual([...set].sort(), [a, b].sort())
  assert.equal(ignoredIds('').size, 0)
  assert.equal(ignoredIds(undefined).size, 0)
})

test('忽略的對話不修復、不被下載回來，且會備份後從本機移除', async t => {
  const home = await makeHome(t)
  const key = projectKey(LOCAL)
  const ignoredId = uuid(), normalId = uuid(), remoteOnlyId = uuid()
  await place(home, key, ignoredId, log(ignoredId, FOREIGN)) // 錯位且被忽略
  await place(home, key, normalId, log(normalId, LOCAL))
  const statePath = path.join(home, 'conversation-sync-state.json')
  await fs.writeFile(statePath, JSON.stringify({ schema: 1, deviceId: uuid(), token: 't', sessions: { [ignoredId]: { version: 1, hash: 'x', logicalUpdatedAt: 1, projectKey: key, sessionId: `session-${ignoredId}` } }, lastSyncAt: 1, lastError: '' }))

  const client = new SyncClient({ home, apiBaseUrl: 'https://example.invalid', deviceName: 'dev', restoreProjectKey: key, ignoredSessionIds: `session-${ignoredId}` })
  assert.ok(client.ignored.has(ignoredId))

  // 遠端清單裡同時有「被忽略」與「只存在遠端」的對話
  const sha = data => crypto.createHash('sha256').update(data).digest('hex')
  const remoteBytes = log(remoteOnlyId, FOREIGN)
  const remoteFile = { name: 'session.v4.jsonl.zstd', hash: sha(remoteBytes), size: remoteBytes.length, base64: remoteBytes.toString('base64') }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async url => {
    calls.push(String(url))
    if (String(url).endsWith('/v1/sync/manifest')) {
      return new Response(JSON.stringify({ items: [
        { conversationId: ignoredId, version: 3, logicalUpdatedAt: 9, files: [{ name: 'session.v4.jsonl.zstd', hash: 'h', size: 1 }] },
        { conversationId: remoteOnlyId, version: 1, logicalUpdatedAt: 9, files: [{ name: remoteFile.name, hash: remoteFile.hash, size: remoteFile.size }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).includes(`/v1/sync/versions/${remoteOnlyId}/1`)) {
      return new Response(JSON.stringify({ conversationId: remoteOnlyId, version: 1, logicalUpdatedAt: 9, files: [remoteFile] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`不該發出這個請求：${url}`)
  }
  t.after(() => { globalThis.fetch = realFetch })

  const result = await client.sync({ upload: false, download: true })

  assert.equal(result.ignored, 1, '被忽略的對話應只計入 ignored')
  assert.equal(result.removed, 1, '被忽略的本機對話應被移除')
  assert.equal(result.backups.length, 1, '移除前應先備份')
  assert.equal(result.errors.length, 0)
  assert.ok(calls.some(u => u.includes(remoteOnlyId)), '未被忽略的遠端對話仍應照常處理')
  assert.ok(!calls.some(u => u.includes(ignoredId)), '不應對被忽略的對話發出下載請求')
  await assert.rejects(fs.stat(path.join(home, 'sessions', key, `session-${ignoredId}`)))
  await fs.stat(path.join(home, 'sessions', key, `session-${normalId}`))
  assert.deepEqual(await fs.readFile(path.join(result.backups[0], 'session', 'session.v4.jsonl.zstd')), log(ignoredId, FOREIGN))
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(state.sessions[ignoredId], undefined, '同步狀態應清掉被移除的對話')
})

test('removeIgnored 只影響清單中的對話', async t => {
  const home = await makeHome(t)
  const key = projectKey(LOCAL)
  const ignoredId = uuid(), keepId = uuid()
  const ignoredDir = await place(home, key, ignoredId, log(ignoredId, LOCAL))
  await place(home, key, keepId, log(keepId, LOCAL))
  await fs.writeFile(path.join(home, 'conversation-sync-state.json'), JSON.stringify({ schema: 1, deviceId: uuid(), token: 't', sessions: { [ignoredId]: { version: 2, hash: 'x', logicalUpdatedAt: 1, projectKey: key, sessionId: `session-${ignoredId}` }, [keepId]: { version: 2, hash: 'y', logicalUpdatedAt: 1, projectKey: key, sessionId: `session-${keepId}` } }, lastSyncAt: 1, lastError: '' }))

  const client = new SyncClient({ home, apiBaseUrl: '', deviceName: 'dev', restoreProjectKey: key, ignoredSessionIds: ignoredId })
  const result = await client.removeIgnored()
  assert.equal(result.removed, 1)
  assert.deepEqual(result.removedIds, [ignoredId])
  await assert.rejects(fs.stat(ignoredDir))
  await fs.stat(path.join(home, 'sessions', key, `session-${keepId}`))
  const state = JSON.parse(await fs.readFile(path.join(home, 'conversation-sync-state.json'), 'utf8'))
  assert.equal(state.sessions[ignoredId], undefined)
  assert.equal(state.sessions[keepId].version, 2)
  // 空清單不動作
  const none = new SyncClient({ home, apiBaseUrl: '', deviceName: 'dev', restoreProjectKey: key }).removeIgnored()
  assert.equal((await none).removed, 0)
})
