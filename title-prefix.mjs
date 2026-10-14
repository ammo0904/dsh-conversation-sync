const eligibleSessions = new WeakMap()

function isLocalNewSession(session) {
  const header = session?.header
  if (!header || header.isSeeded === true || header.parentSession !== undefined) return false
  return typeof session.snapshotEvents === 'function' && session.snapshotEvents().length === 0
}

function prefixText(prefix) {
  return typeof prefix === 'string' ? prefix : String(prefix ?? '')
}

/**
 * 接到官方 SessionTitleService 的自動標題事件，為本機新會話加上主機前綴。
 * @param {object} ctx Cordis 外掛內容，必須提供 on()。
 * @param {() => string|Promise<string>} getPrefix 取得目前主機前綴的函式。
 * @returns {() => void} 解除事件監聽的函式。
 */
export function attachTitlePrefix(ctx, getPrefix) {
  if (!ctx || typeof ctx.on !== 'function') throw new TypeError('title prefix requires a context with on()')
  if (typeof getPrefix !== 'function') throw new TypeError('title prefix requires getPrefix()')
  const titleService = ctx.sessionTitle
  if (!titleService || typeof titleService.get !== 'function' || typeof titleService.rename !== 'function') {
    ctx.logger?.warn?.('對話標題前綴：找不到官方 sessionTitle 服務，已停用')
    return () => {}
  }

  const onCreated = session => {
    if (!isLocalNewSession(session)) return
    if (titleService.get(session) !== undefined) return
    eligibleSessions.set(session, { applying: false, done: false })
  }

  const onEvent = (session, event) => {
    if (event?.type !== 'session/title' || event.data?.source?.kind === 'user') return
    const state = eligibleSessions.get(session)
    if (!state || state.done || state.applying) return
    const title = typeof event.data?.title === 'string' ? event.data.title : ''
    if (!title) return
    state.applying = true
    Promise.resolve().then(() => getPrefix()).then(prefixValue => {
      const prefix = prefixText(prefixValue)
      if (!prefix || title.startsWith(prefix)) return
      if (titleService.get(session)?.title !== title) return
      titleService.rename(session, `${prefix}${title}`)
    }).catch(error => {
      ctx.logger?.warn?.(`對話標題前綴：${error?.message ?? error}`)
    }).finally(() => {
      state.applying = false
      state.done = true
    })
  }

  const disposeCreated = ctx.on('session/created', onCreated, { global: true })
  const disposeEvent = ctx.on('session/event', onEvent, { global: true })
  return () => {
    disposeCreated?.()
    disposeEvent?.()
  }
}
