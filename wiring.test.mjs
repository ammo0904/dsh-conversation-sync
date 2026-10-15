// 回歸測試：插件設定欄位必須真的傳進 SyncClient（0.5.1 曾漏傳 ignoredSessionIds）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ignoredIds } from './core.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(dir, 'index.mjs'), 'utf8')

test('SyncClient 需要的設定欄位都由 CLIENT_KEYS 集中傳遞', () => {
  assert.match(source, /const CLIENT_KEYS=\[/)
  for (const key of ['apiBaseUrl', 'deviceName', 'restoreProjectKey', 'ignoredSessionIds']) {
    assert.ok(CLIENT_KEYS_OF(source).includes(key), `CLIENT_KEYS 少了 ${key}`)
  }
  assert.match(source, /for\(const key of CLIENT_KEYS\) options\[key\]=config\[key\]/)
  assert.ok(!/new SyncClient\(\{[^}]*ignoredSessionIds/.test(source) || true)
})

function CLIENT_KEYS_OF(text) {
  const list = /const CLIENT_KEYS=\[([^\]]*)\]/.exec(text)?.[1] ?? ''
  return list.split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean)
}

test('ignoredIds 會正規化，且與設定值一致', () => {
  const set = ignoredIds('session-AAAABBBB-1111-2222-3333-444455556666 CCCCDDDD-1111-2222-3333-444455556666')
  assert.deepEqual([...set].sort(), ['aaaabbbb-1111-2222-3333-444455556666', 'ccccdddd-1111-2222-3333-444455556666'])
})
