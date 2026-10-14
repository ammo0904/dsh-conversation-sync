import path from 'node:path'
import fs from 'node:fs/promises'
import { SyncClient } from './core.mjs'
import { withSessionLease } from './dsh-lease.mjs'
import { attachTitlePrefix } from './title-prefix.mjs'
export const name='conversation-sync'
export const inject=['connection','configEditor','profileContext','sessions','sessionTitle']
export function validateSettings(input={}) {
  const value={}
  const url=String(input.apiBaseUrl||'').trim().replace(/\/$/,'')
  if(url) { const u=new URL(url); if(u.username||u.password||u.search||u.hash||!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))) throw new Error('請使用 HTTPS VPS 位址；本機測試可使用 HTTP') }
  value.apiBaseUrl=url
  value.deviceName=String(input.deviceName||'').trim().slice(0,80)
  if(!value.deviceName) throw new Error('請填寫裝置名稱')
  value.titlePrefix=String(input.titlePrefix??'')
  if(value.titlePrefix.length>40||/[\r\n\x00-\x1f]/.test(value.titlePrefix)) throw new Error('會話標題前綴最多 40 字，不能包含換行或控制字元')
  value.restoreProjectKey=String(input.restoreProjectKey||'')
  if(value.restoreProjectKey&&(value.restoreProjectKey==='.'||value.restoreProjectKey==='..'||!/^[-A-Za-z0-9_.~]+$/.test(value.restoreProjectKey))) throw new Error('請從本機專案清單選擇還原位置')
  for(const key of ['autoUpload','autoDownload']) value[key]=Boolean(input[key])
  value.enabled=input.enabled!==false
  value.pollIntervalMinutes=Number(input.pollIntervalMinutes||0)
  if(!Number.isInteger(value.pollIntervalMinutes)||value.pollIntervalMinutes<0||value.pollIntervalMinutes>10080) throw new Error('同步間隔需為 0–10080 分鐘')
  return value
}
export function apply(ctx) {
  const home=ctx.profileContext.home || process.env.DSH_HOME
  if(!home) throw new Error('找不到 DSH_HOME；無法確認對話資料目錄')
  let client, signature, tail=Promise.resolve(),disposed=false,timer
  const current=()=>{ const item=ctx.configEditor.configuration().find(x=>x.entry.options.id==='conversation-sync'); if(!item)throw new Error('找不到對話同步設定');return {item,config:{...item.inherited,...item.override}} }
  ctx.effect(()=>attachTitlePrefix(ctx,()=>current().config.enabled===false?'':current().config.titlePrefix||''))
  const getClient=()=>{ const {config}=current();const next=JSON.stringify([config.apiBaseUrl,config.deviceName,config.restoreProjectKey]);if(!client||signature!==next){signature=next;client=new SyncClient({home,apiBaseUrl:config.apiBaseUrl,deviceName:config.deviceName,restoreProjectKey:config.restoreProjectKey,withSessionLease})}return client }
  const serialize=operation=>{const next=tail.then(operation);tail=next.catch(()=>{});return next}
  const projects=async()=>{try{return (await fs.readdir(path.join(home,'sessions'),{withFileTypes:true})).filter(x=>x.isDirectory()&&!x.name.startsWith('.')).map(x=>({key:x.name,label:x.name}))}catch(e){if(e.code==='ENOENT')return [];throw e}}
  const automatic=direction=>serialize(async()=>{if(disposed)return;const {config}=current();if(config.enabled===false||!config.apiBaseUrl)return;const c=getClient();if(!(await c.status()).tokenConfigured)return;await c.sync(direction)}).catch(e=>ctx.logger?.warn?.(`對話同步：${e.message}`))
  ctx.on('session/event',(_session,event)=>{if(event.type==='turn/end'&&current().config.autoUpload)void automatic({upload:true,download:false})})
  ctx.effect(()=>{timer=setInterval(()=>{const {config}=current();if(config.autoDownload&&config.pollIntervalMinutes>0){const now=Date.now();if(now-(lastPoll||0)>=config.pollIntervalMinutes*60000){lastPoll=now;void automatic({upload:false,download:true})}}},15000);void Promise.resolve().then(()=>{if(current().config.autoDownload)void automatic({upload:false,download:true})});return()=>{disposed=true;clearInterval(timer)}})
  let lastPoll=Date.now()
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/conversation-sync',methods:['GET','POST'],requestBody:'buffered',fetch:async request=>{
    try{
      if(request.method==='GET'){const {config}=current();return Response.json({ok:true,version:'0.4.0',value:config,sync:await getClient().status(),projects:await projects(),backups:await getClient().backups()})}
      const body=await request.json()
      return await serialize(async()=>{
        if(body.action==='save'){const value=validateSettings(body.value);const {item}=current();await ctx.configEditor.edit(item.entry,existing=>({...existing,...value}));if((current().config.titlePrefix||'')!==value.titlePrefix) throw new Error('前綴尚未套用，請重新啟動 DSH 後再儲存');return Response.json({ok:true,message:'設定已儲存。'})}
        const c=getClient()
        if(body.action==='register'){await c.register(String(body.enrollmentSecret||''));return Response.json({ok:true,message:'裝置配對完成。'})}
        if(body.action==='sync'){const result=await c.sync({upload:true,download:true});return Response.json({ok:true,result,message:`上傳 ${result.uploaded}、下載 ${result.downloaded}、衝突 ${result.conflicts}、暫緩 ${result.deferred}。`})}
        if(body.action==='test'){const response=await fetch(`${current().config.apiBaseUrl}/health`,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('VPS 健康檢查失敗');const remote=await response.json();if(remote.service!=='dsh-conversation-sync-server')throw new Error('此位址不是對話同步服務');return Response.json({ok:true,message:'VPS 連線正常。'})}
        throw new Error('不支援的操作')
      })
    }catch(e){return Response.json({ok:false,message:e.message},{status:400})}
  }}))
}
