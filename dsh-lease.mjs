import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
let bindings
// Matches DSH 0.2.0-rc.2 session-persistence-jsonl's Windows semaphore protocol.
export async function withSessionLease(directory, id, callback) {
  if (process.platform !== 'win32') throw Object.assign(new Error('尚未提供此平台的 DSH 寫入鎖，暫緩還原'), { code: 'EBUSY' })
  if (!bindings) {
    const kernel = (await import('koffi')).default.load('kernel32.dll')
    bindings = {
      create: kernel.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*','int','int','str16']),
      wait: kernel.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr','uint']),
      release: kernel.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr','int','void*']),
      close: kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
    }
  }
  const name = `Local\\dsh-session-lock-${crypto.createHash('sha256').update(path.resolve(directory,'session.lock').toLowerCase()).digest('hex')}`
  const handle = bindings.create(null,1,1,name)
  if (!handle) throw new Error('無法建立 DSH 寫入鎖')
  const wait = bindings.wait(handle,0)
  if (wait !== 0) { bindings.close(handle); throw Object.assign(new Error(`對話 ${id} 正在使用，暫緩更新`), { code: 'EBUSY' }) }
  try { await fs.mkdir(directory,{recursive:true}); return await callback() }
  finally { const released=bindings.release(handle,1,null); const closed=bindings.close(handle); if(!released||!closed) throw new Error('DSH 寫入鎖釋放失敗') }
}
export function projectKey(cwd) {
  let readable='', separator=false
  for (let i=0;i<cwd.length;i++) {
    const ch=cwd[i]
    if ('/\\:'.includes(ch)) { if(!separator) readable+='-'; separator=true }
    else { readable+=ch!=='~'&&/^[A-Za-z0-9._-]$/.test(ch)?ch:'~'+cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4,'0'); separator=false }
  }
  return `--${(readable.replace(/^-+/,'')||'root').slice(0,251)}--`
}
