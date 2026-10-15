window.__ModuleLoader__.load({id:'dsh-conversation-sync',factory:require=>{
 const React=require('react'),h=React.createElement
 const box={padding:10,border:'1px solid #666',borderRadius:6,background:'transparent',color:'inherit',font:'inherit'}
 function Panel(){
  const [data,setData]=React.useState(null),[value,setValue]=React.useState(null),[secret,setSecret]=React.useState(''),[busy,setBusy]=React.useState(false),[dirty,setDirty]=React.useState(false),[message,setMessage]=React.useState('')
  const load=async()=>{const r=await fetch('/api/conversation-sync',{cache:'no-store'});if(!r.headers.get('content-type')?.includes('application/json'))throw Error(r.status===404?'同步後端尚未啟動，請檢查元件狀態後重新啟動 DSH。':`同步 API 回傳 HTTP ${r.status}，請重新登入或檢查服務。`);const d=await r.json();if(!d.ok)throw Error(d.message);if(d.version!=='0.5.2')throw Error('新版後端尚未載入，請重新啟動 DSH 後再設定前綴。');setData(d);setValue(d.value)}
  React.useEffect(()=>{load().catch(e=>setMessage(e.message))},[])
  const change=(k,v)=>{setValue(x=>({...x,[k]:v}));setDirty(true)}
  const run=async action=>{setBusy(true);try{const r=await fetch('/api/conversation-sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,value,enrollmentSecret:action==='register'?secret:undefined})}),d=await r.json();if(!d.ok)throw Error(d.message);setMessage(d.message);if(action==='register')setSecret('');await load();if(action==='save'){const check=await(await fetch('/api/conversation-sync',{cache:'no-store'})).json();if(!check.ok||(check.value.titlePrefix||'')!==(value.titlePrefix||''))throw Error('前綴未成功保存，請重新啟動 DSH 後再試。');setDirty(false);}}catch(e){setMessage(e.message)}finally{setBusy(false)}}
  const field=(key,label,type='text')=>h('label',{style:{display:'grid',gap:6}},label,h('input',{style:box,type,disabled:busy,value:value[key]??'',onChange:e=>change(key,type==='number'?Number(e.target.value):e.target.value)}))
  const toggle=(key,label)=>h('label',null,h('input',{type:'checkbox',disabled:busy,checked:!!value[key],onChange:e=>change(key,e.target.checked)}),' ',label)
  const button=(action,label,disabled=false)=>h('button',{style:box,disabled:busy||disabled,onClick:()=>run(action)},label)
  if(!value)return h('p',null,message||'載入對話同步設定…')
  const sync=data.sync||{}
  return h('section',{style:{padding:20,maxWidth:850,display:'grid',gap:16}},h('h2',null,'DSH 對話雲端同步 v0.5.2'),
   h('div',{style:{display:'grid',gap:12,gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))'}},field('apiBaseUrl','VPS HTTPS 位址'),field('deviceName','這台電腦的名稱'),
     h('div',{style:{display:'grid',gap:6}},field('titlePrefix','新會話標題前綴'),h('small',null,'例如：家裡_ 或 公司_。儲存後的新會話自動命名會加上此前綴；空白表示關閉。既有與下載的對話不會改名。'),h('small',null,'預覽：',(value.titlePrefix||''),'這是一段會話')),
    h('label',{style:{display:'grid',gap:6}},'新下載對話的本機專案',h('select',{style:box,value:value.restoreProjectKey||'',disabled:busy,onChange:e=>change('restoreProjectKey',e.target.value)},h('option',{value:''},'請選擇還原專案'),...(data.projects||[]).map(p=>h('option',{key:p.key,value:p.key},p.label)))),field('pollIntervalMinutes','下載檢查間隔（分鐘，0 表示停用）','number'),h('label',{style:{display:'grid',gap:6}},'不要同步並從本機移除的會話 ID（每行一個）',h('textarea',{style:{...box,minHeight:72,fontFamily:'monospace'},disabled:busy,value:value.ignoredSessionIds??'',onChange:e=>change('ignoredSessionIds',e.target.value)})),),
   h('div',{style:{display:'grid',gap:8}},toggle('autoUpload','每輪對話結束後自動上傳'),toggle('autoDownload','啟動及定期下載')),
   h('label',{style:{display:'grid',gap:6}},'VPS 配對密語',h('input',{style:box,type:'password',autoComplete:'new-password',disabled:busy,value:secret,onChange:e=>setSecret(e.target.value)}),h('small',null,'配對成功後清空；不儲存在設定中。')),
   h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},button('save','儲存設定',!dirty),button('test','測試連線',dirty),button('register','配對裝置',dirty||!secret||sync.tokenConfigured),button('sync','立即同步',dirty||!sync.tokenConfigured),button('repair','修復已下載對話',dirty),button('removeIgnored','移除已忽略對話',dirty),h('button',{style:box,disabled:busy||dirty,onClick:()=>load().catch(e=>setMessage(e.message))},'重新整理')),
   h('div',{style:{...box,display:'grid',gap:8}},h('strong',null,'資料與同步狀態'),h('span',null,sync.tokenConfigured?'已配對':'尚未配對'),h('span',null,'最近同步：',sync.lastSyncAt?new Date(sync.lastSyncAt).toLocaleString('zh-TW'):'尚未同步'),sync.lastError&&h('span',null,'錯誤：',sync.lastError),h('span',null,'備份數：',(data.backups||[]).length),h('small',null,'已開啟的對話會暫緩還原，等待寫入鎖釋放。'),h('small',null,'若對話清單不見或打不開，按「修復已下載對話」修正舊版留下的跨機路徑錯位。'),h('small',null,'忽略清單中的會話不會同步，同步前會自動備份並從本機移除；填入會話 ID（每行一個）後按「移除已忽略對話」可立刻處理。')),
   h('details',null,h('summary',null,'本機備份清單'),...(data.backups||[]).map((b,i)=>h('div',{key:i,style:{overflowWrap:'anywhere'}},typeof b==='string'?b:JSON.stringify(b)))),
   message&&h('p',{role:'status'},message))
 }
 return {inject:['slots'],apply(ctx){ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:'dsh-conversation-sync'},Panel))}}
}})
