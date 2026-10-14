import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import * as zlib from 'node:zlib'
import { decodeZstdContainer, isZstdContainer, remapSessionLogCwd } from './zstd-frames.mjs'
import { projectKey } from './dsh-lease.mjs'

const UUID = /^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const excluded = name => /(?:lock|migration|fork)/i.test(name) || /\.remote-/i.test(name)
const validName = name => NAME.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
export function bundleHash(files) {
  return sha(JSON.stringify(files.map(({ name, hash }) => ({ name, hash })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
}
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(tmp, 'wx', 0o600)
    await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null
    await fs.rename(tmp, file)
    await fs.chmod(file, 0o600)
  } finally { await handle?.close(); await fs.rm(tmp, { force: true }) }
}
async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
function eventTime(data, name) {
  if (!/\.jsonl(?:\.zstd)?$/i.test(name)) return 0
  if (/\.zstd$/i.test(name)) {
    if (!zlib.zstdDecompressSync) throw new Error('Zstandard session scanning requires Node.js with zstd support')
    data = decodeZstdContainer(data)
  }
  let max = 0
  for (const line of data.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    // DSH seq values are epoch milliseconds; other common event time fields are supported.
    for (const value of [event.seq, event.timestamp, event.time, event.createdAt, event.updatedAt, event.event?.seq, event.event?.timestamp]) {
      const number = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
      if (Number.isSafeInteger(number) && number >= 0) max = Math.max(max, number)
    }
  }
  return max
}
async function locked(dir) { return (await entries(dir)).some(e => /lock/i.test(e.name)) }
const validPath = name => typeof name === 'string' && name.split('/').every(part => validName(part) && part !== '.' && part !== '..' && !excluded(part))
async function snapshot(dir, skipped = []) {
  const files = []; let fallback = 0; let logical = 0
  async function visit(current, prefix = '') {
    for (const e of await entries(current)) {
      if (excluded(e.name)) continue
      const name = prefix ? `${prefix}/${e.name}` : e.name
      if (!validName(e.name) || e.name === '.' || e.name === '..') { skipped.push({ path: path.join(current, e.name), reason: 'unsupported file name' }); continue }
      if (e.isDirectory()) { await visit(path.join(current, e.name), name); continue }
      if (!e.isFile()) { skipped.push({ path: path.join(current, e.name), reason: 'unsupported file type' }); continue }
      const absolute = path.join(current, e.name)
      const data = await fs.readFile(absolute); const stat = await fs.stat(absolute)
      files.push({ name, hash: sha(data), size: data.length, data })
      logical = Math.max(logical, eventTime(data, name)); fallback = Math.max(fallback, Math.floor(stat.mtimeMs))
    }
  }
  await visit(dir)
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (files.length > 128 || new Set(files.map(f => f.name.toLowerCase())).size !== files.length) throw new Error('Unsupported bundle: too many files or case-insensitive duplicate names')
  return { files, hash: bundleHash(files), logicalUpdatedAt: logical || fallback, eventTimestamp: logical > 0 }
}
async function inventory(dir, prefix = '') {
  const out = []
  for (const entry of await entries(dir)) {
    const relative = path.join(prefix, entry.name); const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await inventory(absolute, relative))
    else if (entry.isFile()) out.push({ name: relative, hash: sha(await fs.readFile(absolute)) })
    else throw new Error('Cannot safely back up a session containing symlinks or special files')
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Standalone single-user sync client. home must be the actual DSH_HOME, never a workspace. */
export class SyncClient {
  constructor(config) {
    if (!config?.home) throw new Error('home is required')
    if (config.apiBaseUrl) {
      const url = new URL(config.apiBaseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid apiBaseUrl')
    }
    if (config.restoreProjectKey && (!/^[a-zA-Z0-9_~.-]+$/.test(config.restoreProjectKey) || ['.', '..'].includes(config.restoreProjectKey))) throw new Error('Invalid restoreProjectKey')
    this.config = { ...config, home: path.resolve(config.home), sessionRoot: path.resolve(config.sessionRoot ?? path.join(config.home, 'sessions')), apiBaseUrl: (config.apiBaseUrl ?? '').replace(/\/$/, '') }
    this.stateFile = path.join(this.config.home, 'conversation-sync-state.json')
    this.backupRoot = path.join(this.config.home, 'conversation-sync-backups')
    this.queue = Promise.resolve()
  }
  _serialized(work) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result }
  async _load() {
    if (this.state) return
    try { this.state = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); if (this.state.schema !== 1 || !this.state.sessions || !this.state.deviceId) throw new Error('Invalid sync state') }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.state = { schema: 1, deviceId: crypto.randomUUID(), token: '', sessions: {}, lastSyncAt: null, lastError: '' } }
  }
  async _save() { await atomic(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`) }
  async _request(route, body, secret) {
    if (!this.config.apiBaseUrl) throw new Error('apiBaseUrl is required for network operations')
    const headers = { 'content-type': 'application/json' }
    if (secret !== undefined) headers['x-enrollment-secret'] = secret
    else { if (!this.state.token) throw new Error('Device is not registered'); headers.authorization = `Bearer ${this.state.token}` }
    const response = await fetch(`${this.config.apiBaseUrl}${route}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    const value = await response.json()
    if (!response.ok && response.status !== 409) throw new Error(`Sync API ${response.status}: ${value.message ?? 'request failed'}`)
    return { status: response.status, value }
  }
  register(secret) { return this._serialized(async () => {
    await this._load()
    if (this.state.token) return { deviceId: this.state.deviceId, registered: true }
    if (!this.config.deviceName?.trim()) throw new Error('deviceName is required for registration')
    const response = await this._request('/v1/devices/register', { deviceId: this.state.deviceId, name: this.config.deviceName }, secret)
    if (response.status !== 201 || !response.value.token) throw new Error(response.value.message ?? 'Registration failed')
    this.state.token = response.value.token; await this._save()
    return { deviceId: this.state.deviceId, registered: true }
  }) }
  async _scan() {
    const sessions = new Map(); const skipped = []; const duplicate = new Set()
    for (const project of await entries(this.config.sessionRoot)) {
      if (!project.isDirectory() || excluded(project.name)) continue
      for (const session of await entries(path.join(this.config.sessionRoot, project.name))) {
        const match = UUID.exec(session.name)
        if (!session.isDirectory() || !match) continue
        const id = match[1].toLowerCase(); const dir = path.join(this.config.sessionRoot, project.name, session.name)
        if (sessions.has(id) || duplicate.has(id)) { sessions.delete(id); duplicate.add(id); skipped.push({ path: dir, reason: 'ambiguous duplicate conversation UUID' }); continue }
        const item = { conversationId: id, projectKey: project.name, sessionId: session.name, dir, locked: await locked(dir), ...await snapshot(dir, skipped) }
        const known = this.state.sessions[id]
        if (known?.hash === item.hash) item.logicalUpdatedAt = known.logicalUpdatedAt
        if (item.files.length) sessions.set(id, item)
      }
    }
    return { sessions, skipped, duplicate }
  }
  list() { return this._serialized(async () => { await this._load(); const scan = await this._scan(); return { sessions: [...scan.sessions.values()].map(({ files, dir, ...item }) => ({ ...item, files: files.map(({ data, ...file }) => file) })), skipped: scan.skipped } }) }
  status() { return this._serialized(async () => { await this._load(); const { token, ...state } = this.state; return { ...structuredClone(state), tokenConfigured: Boolean(token), home: this.config.home, sessionRoot: this.config.sessionRoot } }) }
  backups() { return this._serialized(async () => (await entries(this.backupRoot)).filter(e => e.isDirectory()).map(e => path.join(this.backupRoot, e.name)).sort()) }
  async _backup(dir) {
    const target = path.join(this.backupRoot, `${Date.now()}-${crypto.randomUUID()}`)
    const before = await inventory(dir)
    await fs.mkdir(target, { recursive: true, mode: 0o700 }); await fs.cp(dir, path.join(target, 'session'), { recursive: true, errorOnExist: true, force: false })
    if (JSON.stringify(before) !== JSON.stringify(await inventory(path.join(target, 'session'))) || JSON.stringify(before) !== JSON.stringify(await inventory(dir))) throw new Error('Backup verification failed; session changed')
    await atomic(path.join(target, 'manifest.json'), JSON.stringify({ source: dir, files: before }))
    return target
  }
  _remember(id, record, item) { this.state.sessions[id] = { version: record.version, hash: item.hash, logicalUpdatedAt: record.logicalUpdatedAt, projectKey: item.projectKey, sessionId: item.sessionId } }
  /**
   * 某個本機專案目錄所代表的路徑。只採用「header cwd 的 projectKey 等於該目錄名」
   * 的既有對話，確保推得的路徑與目錄一致；推不出來時回傳空字串（不做映射）。
   * @param {string} key 專案目錄名（sessions 下的第一層目錄）。
   */
  async _projectCwd(key) {
    this.projectCwds ??= new Map()
    if (this.projectCwds.has(key)) return this.projectCwds.get(key)
    let found = ''
    if (key) {
      const projectDir = path.join(this.config.sessionRoot, key)
      outer: for (const session of await entries(projectDir)) {
        if (!session.isDirectory() || excluded(session.name)) continue
        for (const file of await entries(path.join(projectDir, session.name))) {
          if (!file.isFile() || !/\.jsonl(?:\.zstd)?$/i.test(file.name)) continue
          let raw
          try { raw = await fs.readFile(path.join(projectDir, session.name, file.name)) } catch { continue }
          let text
          try { text = (isZstdContainer(raw) ? decodeZstdContainer(raw) : raw).toString('utf8') } catch { continue }
          const newline = text.indexOf('\n')
          if (newline < 0) continue
          try {
            const header = JSON.parse(text.slice(0, newline))
            if (typeof header?.cwd !== 'string' || !header.cwd) continue
            if (projectKey(header.cwd) !== key) continue
            found = header.cwd
            break outer
          } catch { /* 略過無法解析的檔案 */ }
        }
      }
    }
    this.projectCwds.set(key, found)
    return found
  }
  async _download(id, record, local, result, leased = false) {
    if (!local && !this.config.restoreProjectKey) { result.errors.push({ conversationId: id, message: 'restoreProjectKey is required for a new remote session' }); return }
    const response = await this._request(`/v1/sync/versions/${id}/${record.version}`); const data = response.value
    if (data.conversationId !== id || data.version !== record.version || data.logicalUpdatedAt !== record.logicalUpdatedAt || !Array.isArray(data.files) || !data.files.length || data.files.length > 128) throw new Error('Invalid download metadata')
    const seen = new Set()
    const files = data.files.map(file => {
      if (!validPath(file.name) || seen.has(file.name.toLowerCase()) || typeof file.base64 !== 'string') throw new Error('Invalid download file name')
      seen.add(file.name.toLowerCase()); const bytes = Buffer.from(file.base64, 'base64')
      if (bytes.toString('base64') !== file.base64 || sha(bytes) !== file.hash || bytes.length !== file.size) throw new Error('Download hash verification failed')
      return { ...file, data: bytes }
    })
    if (bundleHash(files) !== bundleHash(record.files)) throw new Error('Download bundle hash mismatch')
    let sessionId = local?.sessionId ?? id
    if (!local) {
      for (const file of files) {
        if (file.name.includes('/') || !/\.jsonl(?:\.zstd)?$/i.test(file.name)) continue
        let bytes = file.data
        if (/\.zstd$/i.test(file.name)) bytes = zlib.zstdDecompressSync(bytes)
        try {
          const header = JSON.parse(bytes.toString('utf8').split(/\r?\n/)[0])
          if (typeof header.id === 'string' && UUID.exec(header.id)?.[1].toLowerCase() === id) { sessionId = header.id; break }
        } catch { /* Other JSONL event formats may not carry a header ID. */ }
      }
    }
    const dir = local?.dir ?? path.join(this.config.sessionRoot, this.config.restoreProjectKey, sessionId)
    // 跨機路徑映射：DSH 會以 header cwd 推算檔案必須存在的路徑，跨機還原若不映射
    // 會被判定為損毀的 session log。目標路徑由「檔案將落地的那個專案目錄」推得；
    // 只改第一格 header，事件內容（歷史紀錄）保持原樣。
    const restoreCwd = await this._projectCwd(local?.projectKey ?? this.config.restoreProjectKey)
    if (restoreCwd) {
      for (const file of files) {
        if (!/\.jsonl(?:\.zstd)?$/i.test(file.name)) continue
        const mapped = remapSessionLogCwd(file.data, restoreCwd)
        if (!mapped.changed) continue
        file.data = mapped.buffer
        file.size = mapped.buffer.length
        file.hash = sha(mapped.buffer)
        file.base64 = mapped.buffer.toString('base64')
        result.remapped++
      }
    }
    if (!leased) {
      if (typeof this.config.withSessionLease !== 'function') { result.deferred++; return }
      let invoked = false
      await this.config.withSessionLease(dir, sessionId, async () => { invoked = true; await this._download(id, record, local, result, true) })
      if (!invoked) result.deferred++
      return
    }
    const stable = async () => {
      // The lease provider owns lock detection while this callback holds its lease.
      const current = await snapshot(dir)
      return current.hash === (local?.hash ?? bundleHash([]))
    }
    if (!await stable()) { result.deferred++; return }
    let hadTarget = false
    try {
      const stat = await fs.lstat(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) { result.deferred++; return }
      hadTarget = true
      if (!local && (await entries(dir)).some(entry => !/lock/i.test(entry.name))) { result.deferred++; return }
    } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (local) { const backup = await this._backup(dir); result.backups.push(backup); result.backup ??= backup }
    await fs.mkdir(path.dirname(dir), { recursive: true })
    const stage = path.join(path.dirname(dir), `.conversation-sync-stage-${crypto.randomUUID()}`)
    const rollback = path.join(path.dirname(dir), `.conversation-sync-rollback-${crypto.randomUUID()}`)
    let moved = false
    await fs.mkdir(stage, { recursive: true, mode: 0o700 })
    try {
      // Build a complete replacement beside the target, retaining local-only and nested files.
      if (hadTarget) await fs.cp(dir, stage, { recursive: true, force: false, errorOnExist: false })
      for (const file of files) await atomic(path.join(stage, file.name), file.data)
      if (!await stable()) { result.deferred++; return }
      if (hadTarget) { await fs.rename(dir, rollback); moved = true }
      try { await fs.rename(stage, dir) }
      catch (e) { if (moved) { await fs.rename(rollback, dir); moved = false }; throw e }
      const restored = { ...await snapshot(dir), projectKey: local?.projectKey ?? this.config.restoreProjectKey, sessionId }
      this._remember(id, data, restored); result.downloaded++
    } finally {
      await fs.rm(stage, { recursive: true, force: true })
      if (moved) await fs.rm(rollback, { recursive: true, force: true })
    }
  }
  sync({ upload = true, download = true } = {}) { return this._serialized(async () => {
    await this._load()
    const result = { uploaded: 0, downloaded: 0, conflicts: 0, unchanged: 0, deferred: 0, remapped: 0, backup: null, backups: [], errors: [], skipped: [] }
    if (!upload && !download) return result
    try {
      const manifest = (await this._request('/v1/sync/manifest')).value
      const scan = await this._scan(); result.skipped = scan.skipped
      const remote = new Map(manifest.items.map(r => [r.conversationId, r]))
      const ids = new Set([...scan.sessions.keys(), ...remote.keys()])
      for (const id of ids) {
        if (scan.duplicate.has(id)) { result.deferred++; continue }
        const local = scan.sessions.get(id); let head = remote.get(id); const known = this.state.sessions[id]
        try {
          if (local?.locked) { result.deferred++; continue }
          if (local && head && local.hash === bundleHash(head.files)) { this._remember(id, head, local); result.unchanged++; continue }
          if (local && head && known?.version === head.version && known.hash === local.hash) { result.unchanged++; continue }
          if (!local) { if (download && head) await this._download(id, head, null, result); continue }
          const changed = !known || known.hash !== local.hash
          if (upload && changed) {
            if (await locked(local.dir) || (await snapshot(local.dir)).hash !== local.hash) { result.deferred++; continue }
            const payload = { conversationId: id, parentVersion: known?.version ?? null, logicalUpdatedAt: local.logicalUpdatedAt, files: local.files.map(f => ({ name: f.name, hash: f.hash, base64: f.data.toString('base64') })) }
            const response = await this._request('/v1/sync/versions', payload)
            if (response.status === 201) { this._remember(id, response.value, local); result.uploaded++; continue }
            result.conflicts++; head = response.value.current
            if (head && local.logicalUpdatedAt > head.logicalUpdatedAt) {
              // Conflict is retained first. Promote with one CAS only; a racing new head is never blindly overwritten.
              if (await locked(local.dir) || (await snapshot(local.dir)).hash !== local.hash) { result.deferred++; continue }
              const promoted = await this._request('/v1/sync/versions', { ...payload, parentVersion: head.version })
              if (promoted.status === 201) { this._remember(id, promoted.value, local); result.uploaded++ }
              else { result.conflicts++; result.deferred++ }
              continue
            }
            if (!head || local.logicalUpdatedAt === head.logicalUpdatedAt) { result.deferred++; continue }
          }
          if (download && head && (!changed || head.logicalUpdatedAt > local.logicalUpdatedAt)) await this._download(id, head, local, result)
          else result.deferred++
        } catch (e) { if (e.code === 'EBUSY') result.deferred++; else result.errors.push({ conversationId: id, message: e.message }) }
      }
      this.state.lastSyncAt = Date.now(); this.state.lastError = result.errors.map(e => e.message).join('; '); await this._save()
      return result
    } catch (e) { this.state.lastError = e.message; await this._save(); throw e }
  }) }
}
