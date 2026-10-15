// 0.5.0 修復功能測試：0.1.0 下載造成的 cross-machine cwd 錯位。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { SyncClient } from './core.mjs'
import { encodeZstdContainer, zstdFrameRanges } from './zstd-frames.mjs'
import { projectKey } from './dsh-lease.mjs'

const LOCAL = 'C:\\Users\\admin\\Desktop\\Test'
const FOREIGN = 'C:\\Users\\USER\\Desktop\\test'
const uuid = () => crypto.randomUUID()
const sessionDirName = id => `session-${id}`

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-repair-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true })
  return home
}

function log(id, cwd, marker) {
  const header = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: `session-${id}`, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 }) + '\n', 'utf8')
  const events = Buffer.from(JSON.stringify({ type: 'user/message', seq: 2, data: { marker } }), 'utf8')
  return encodeZstdContainer([header, events])
}

async function place(home, projectDir, id, buffer) {
  const dir = path.join(home, 'sessions', projectDir, sessionDirName(id))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), buffer)
  return dir
}

test('修復錯位對話並保留事件格位元組', async t => {
  const home = await makeHome(t)
  const key = projectKey(LOCAL)
  const healthyId = uuid(), foreignId = uuid()
  await place(home, key, healthyId, log(healthyId, LOCAL, 'healthy'))
  const foreignDir = await place(home, key, foreignId, log(foreignId, FOREIGN, 'foreign'))
  const foreignPath = path.join(foreignDir, 'session.v4.jsonl.zstd')
  const before = await fs.readFile(foreignPath)
  const beforeFrames = zstdFrameRanges(before)
  assert.equal(beforeFrames.frames.length, 2)

  // 模擬 0.1.0 下載後的同步狀態：記錄的是未映射的檔案雜湊
  const statePath = path.join(home, 'conversation-sync-state.json')
  await fs.writeFile(statePath, JSON.stringify({ schema: 1, deviceId: uuid(), token: 'x', sessions: { [foreignId]: { version: 3, hash: 'stale', logicalUpdatedAt: 1, projectKey: key, sessionId: sessionDirName(foreignId) } }, lastSyncAt: 1, lastError: '' }))

  const client = new SyncClient({ home, apiBaseUrl: '', deviceName: '公司電腦', restoreProjectKey: key })
  const result = await client.repair()
  assert.equal(result.repaired, 1)
  assert.equal(result.repairedFiles, 1)
  assert.equal(result.errors.length, 0)
  assert.equal(result.backups.length, 1)

  const after = await fs.readFile(foreignPath)
  const afterFrames = zstdFrameRanges(after)
  const head = JSON.parse((await import('node:zlib')).zstdDecompressSync(after.subarray(0, afterFrames.frames[0].end)).toString('utf8'))
  assert.equal(head.cwd, LOCAL)
  assert.equal(head.id, `session-${foreignId}`)
  // 事件格（第一格之後）必須位元組完全相同
  assert.deepEqual(after.subarray(afterFrames.frames[0].end), before.subarray(beforeFrames.frames[0].end))
  // 備份內容必須是修復前的原始位元組
  const backup = result.backups[0]
  assert.deepEqual(await fs.readFile(path.join(backup, 'session', 'session.v4.jsonl.zstd')), before)
  // 狀態已更新，避免把改寫後的版本推回 VPS
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(state.sessions[foreignId].version, 3)
  assert.notEqual(state.sessions[foreignId].hash, 'stale')
  // 健康對話沒有被動到
  const healthyPath = path.join(home, 'sessions', key, sessionDirName(healthyId), 'session.v4.jsonl.zstd')
  assert.equal(zstdFrameRanges(await fs.readFile(healthyPath)).frames.length, 2)
  // 重複執行必須是幂等的
  const again = await client.repair()
  assert.equal(again.repaired, 0)
  assert.equal(again.repairedFiles, 0)
})

test('dryRun 只檢查不寫入', async t => {
  const home = await makeHome(t)
  const key = projectKey(LOCAL)
  const healthyId = uuid(), foreignId = uuid()
  await place(home, key, healthyId, log(healthyId, LOCAL, 'healthy'))
  const dir = await place(home, key, foreignId, log(foreignId, FOREIGN, 'foreign'))
  const client = new SyncClient({ home, apiBaseUrl: '', deviceName: '公司電腦', restoreProjectKey: key })
  const result = await client.repair({ dryRun: true })
  assert.equal(result.repaired, 1)
  assert.equal(result.backups.length, 0)
  const raw = await fs.readFile(path.join(dir, 'session.v4.jsonl.zstd'))
  const frames = zstdFrameRanges(raw)
  const head = JSON.parse((await import('node:zlib')).zstdDecompressSync(raw.subarray(0, frames.frames[0].end)).toString('utf8'))
  assert.equal(head.cwd, FOREIGN)
})

test('推不出本機路徑時列為待處理，不亂改', async t => {
  const home = await makeHome(t)
  const key = projectKey(LOCAL)
  const foreignId = uuid()
  const dir = await place(home, key, foreignId, log(foreignId, FOREIGN, 'foreign'))
  const client = new SyncClient({ home, apiBaseUrl: '', deviceName: '公司電腦', restoreProjectKey: key })
  const result = await client.repair()
  assert.equal(result.repaired, 0)
  assert.equal(result.unresolved.length, 1)
  const raw = await fs.readFile(path.join(dir, 'session.v4.jsonl.zstd'))
  const frames = zstdFrameRanges(raw)
  const head = JSON.parse((await import('node:zlib')).zstdDecompressSync(raw.subarray(0, frames.frames[0].end)).toString('utf8'))
  assert.equal(head.cwd, FOREIGN)
})
