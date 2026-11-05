import { T, LOCALE } from './i18n.js'
import { views, state, sessions } from './state.js'
import { esc, hhmm, num, dur, now } from './format.js'
import { api } from './api.js'
import {
  MAX_VIEW_ITEMS, MAX_VIEW_HTML, MAX_VIEW_TAGS, tagsIn, clipEsc, MAX_RENDER_TEXT, mdCached, status,
} from './content.js'
import { msgTag } from './topbar.js'
import { showLogin } from './app.js'

// ChatView: one session's conversation. Used by mosaic panes and the full view.
export class ChatView {
  constructor(name, { full = false } = {}) {
    this.name = name
    this.full = full
    this.items = []           // sorted by ts
    this.keys = new Set()     // de-dup
    this.nextBefore = null
    this.hasMore = true
    this.loading = false
    this.unseen = 0
    this.openGroups = new Map() // group key -> user choice
    this.el = document.createElement('div')
    this.el.className = 'chat'
    this.el.innerHTML = `<div class="scroll"><div class="items"></div></div><button class="jump" hidden>${T.jump(0)}</button><div class="status"><span class="dot"></span><span class="txt"></span></div>`
    this.scrollEl = this.el.querySelector('.scroll')
    this.itemsEl = this.el.querySelector('.items')
    this.jumpEl = this.el.querySelector('.jump')
    this.scrollEl.addEventListener('scroll', () => this.onScroll())
    this.jumpEl.addEventListener('click', () => this.toBottom())
    this.itemsEl.addEventListener('toggle', e => {
      const d = e.target
      if (d.classList?.contains('tools')) this.openGroups.set(d.dataset.g, d.open)
    }, true)
    views.add(this)
    this.renderStatus()
    this.loadOlder(true)
  }

  destroy() { views.delete(this) }

  // The chat was cleared on the server: start over.
  reset() {
    // A page still on its way belongs to the view before the reset: ignored.
    this.gen = (this.gen ?? 0) + 1
    this.loading = false
    this.gapAfter = false
    this.items = []
    this.keys = new Set()
    this.nextBefore = null
    this.hasMore = true
    this.unseen = 0
    this.jumpEl.hidden = true
    this.render()
    this.loadOlder(true)
  }

  key(it) { return it.t === 'message' ? `m${it.id}` : `e${it.id}` }

  // older: these items come from scrolling up (they are the oldest ones).
  add(list, { live = false, older = false } = {}) {
    let added = 0
    // What arrives live goes at the end, whatever time the session put on
    // it (an event dated in the past must not slip in above, unseen); the
    // time shown is still its own. A reload orders everything by time.
    let last = this.items.length ? this.items[this.items.length - 1] : null
    for (const it of list) {
      const k = this.key(it)
      if (this.keys.has(k)) continue
      this.keys.add(k)
      if (live && last) it.order = Math.max(it.ts, last.order ?? last.ts)
      this.items.push(it)
      if (live) last = it
      added++
    }
    if (!added) return 0
    this.items.sort((a, b) => (a.order ?? a.ts) - (b.order ?? b.ts) || (a.id ?? 0) - (b.id ?? 0))
    // Keep the view bounded. Scrolling up drops the newest items (the
    // "jump" button loads the latest again); new items drop the oldest
    // (scrolling up loads them again).
    if (this.items.length > MAX_VIEW_ITEMS) {
      // Reading back (scrolled up, or a page on its way): new items don't
      // push the old ones out from under the reader; they wait behind the
      // jump button.
      if (older || (live && (this.loading || !this.atBottom()))) {
        const drop = this.items.splice(MAX_VIEW_ITEMS)
        for (const it of drop) this.keys.delete(this.key(it))
        this.gapAfter = true
        this.jumpEl.hidden = false
        this.jumpEl.textContent = T.jump(this.unseen)
      } else {
        const drop = this.items.splice(0, this.items.length - MAX_VIEW_ITEMS)
        for (const it of drop) this.keys.delete(this.key(it))
        // Scrolling up continues from the newest item dropped (by its own
        // time): nothing between it and what is shown is skipped, whatever
        // times a session put on its events (repeats are de-duplicated).
        // (In the server's order: time, then events before messages, then id.)
        const rank = x => (x.t === 'event' ? 1 : 0)
        const c = drop.reduce((a, b) => (b.ts > a.ts || (b.ts === a.ts && (rank(b) > rank(a) || (rank(b) === rank(a) && (b.id ?? 0) > (a.id ?? 0)))) ? b : a))
        // (+1: the server returns what is strictly older, and c must come back too.)
        this.nextBefore = `${c.ts}:${c.t === 'event' ? 1 : 0}:${c.id + 1}`
        this.evictions = (this.evictions ?? 0) + 1
        this.hasMore = true
      }
    }
    if (live && !this.atBottom()) { this.unseen += added; this.jumpEl.hidden = false; this.jumpEl.textContent = T.jump(this.unseen) }
    return added
  }

  accepts(it) {
    if (it.t === 'event') return it.session === this.name
    if (it.from === this.name || it.target === this.name) return true
    return it.target?.startsWith('#') && state.groups.some(g => g.id === it.target && g.members.includes(this.name))
  }

  atBottom() { return this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight < 60 }
  toBottom() {
    // Newer items were dropped while reading back: load the latest again.
    if (this.gapAfter) return this.reset()
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight; this.unseen = 0; this.jumpEl.hidden = true
  }

  onScroll() {
    if (this.atBottom() && !this.gapAfter) { this.unseen = 0; this.jumpEl.hidden = true }
    if (this.scrollEl.scrollTop < 80) this.loadOlder()
  }

  async loadOlder(first = false) {
    if (this.loading || !this.hasMore) return
    this.loading = true
    const gen = this.gen // a reset() meanwhile makes this answer stale
    const evicted = this.evictions ?? 0 // and live items dropped meanwhile set their own cursor
    try {
      const q = `/api/timeline?session=${encodeURIComponent(this.name)}&limit=${this.full ? 200 : 120}${this.nextBefore != null ? `&before=${this.nextBefore}` : ''}`
      const r = await api(q)
      if (gen !== this.gen) return
      // Live items were dropped while this page was on its way: the page
      // would leave a hole above them. Dropped; the next scroll asks again
      // from the right place.
      if ((this.evictions ?? 0) !== evicted) { this.hasMore = true; this.render(); return }
      this.nextBefore = r.next_before
      this.hasMore = r.has_more && r.items.length > 0
      const fromBottom = this.scrollEl.scrollHeight - this.scrollEl.scrollTop
      this.add(r.items, { older: !first })
      this.render()
      if (first) this.toBottom()
      else this.scrollEl.scrollTop = this.scrollEl.scrollHeight - fromBottom // keep the reader in place
    } catch (e) {
      if (e.status === 401) return showLogin(T.tokenInvalid)
      // The server refused the request: don't ask again on every scroll.
      if (e.status >= 400 && e.status < 500) { this.hasMore = false; this.render() }
    } finally {
      if (gen === this.gen) this.loading = false
    }
  }

  live(it) {
    if (!this.accepts(it)) return false
    if (this.gapAfter) {
      // Reading far back: count it; the jump button loads the latest.
      if (this.keys.has(this.key(it))) return false
      this.unseen++
      this.jumpEl.textContent = T.jump(this.unseen)
      return true
    }
    const stick = this.atBottom()
    if (!this.add([it], { live: true })) return false
    this.scheduleRender(stick)
    return true
  }

  // A burst of changes re-renders once per frame, not once per change.
  scheduleRender(stick = false) {
    this.stick = this.stick || stick
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null
        this.render()
        if (this.stick) this.toBottom()
        this.stick = false
      })
    }
  }

  // --- rendering ---------------------------------------------------------------
  render() {
    const html = []
    if (this.hasMore) html.push(`<div class="older">${this.loading ? T.loading : T.scrollMore}</div>`)
    else {
      const cleared = sessions.get(this.name)?.cleared_at
      const when = cleared ? new Date(cleared).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : ''
      if (this.items.length === 0) html.push(`<div class="older">${cleared ? T.clearedEmpty(when) : T.noActivity}</div>`)
      else html.push(`<div class="older">${cleared ? T.clearedTop(when) : T.historyStart}</div>`)
    }

    const a = sessions.get(this.name)?.activity
    this.pairTools()
    const parts = []
    let group = null
    const flush = () => { if (group) { parts.push({ group, n: group.list.length }); group = null } }
    for (const it of this.items) {
      if (it.t === 'event' && (it.kind === 'tool_start' || it.kind === 'tool_end' || it.kind === 'subagent_start' || it.kind === 'subagent_stop')) {
        if (it.kind === 'tool_end' && this.started.has(it.ref)) continue // shown with its start
        if (!group) group = { key: this.key(it), list: [] }
        group.list.push(it)
        continue
      }
      if (it.t === 'event' && (it.kind === 'usage' || (it.kind === 'prompt' && it.channel))) continue
      flush()
      parts.push({ it, n: 1 })
    }
    flush()
    // At most MAX_VIEW_HTML of markup (and MAX_VIEW_TAGS tags) per redraw,
    // newest first: a session can't make every redraw of its view parse
    // megabytes (escaping can multiply a text's size). Older items are left
    // out, and say so; a group of tools too big for what is left shows its
    // newest tools.
    const left = { chars: MAX_VIEW_HTML, tags: MAX_VIEW_TAGS }
    const shown = []
    let hidden = 0
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      const h = p.group ? this.renderGroup(p.group, a, left) : this.renderItem(p.it)
      const tags = tagsIn(h)
      if (h.length > left.chars || tags > left.tags) { for (let j = 0; j <= i; j++) hidden += parts[j].n; break }
      shown.push(h)
      left.chars -= h.length
      left.tags -= tags
    }
    if (hidden) html.push(`<div class="older">${T.olderHidden(hidden)}</div>`)
    this.itemsEl.innerHTML = html.join('') + shown.reverse().join('')
  }

  // Each tool's end, wherever it fell: messages can come between a tool's start
  // and its end (its own reply, the permission it waits for) and split their
  // groups. And the tools that will never end (a denied permission gives no
  // end): those of the main agent when its turn ends, all when the session does.
  pairTools() {
    this.started = new Set()
    this.endOf = new Map()
    this.stopped = new Set()
    for (const it of this.items) {
      if (it.t !== 'event' || !it.ref) continue
      if (it.kind === 'tool_start') this.started.add(it.ref)
      else if (it.kind === 'tool_end') this.endOf.set(it.ref, it)
    }
    let open = []
    for (const it of this.items) {
      if (it.t !== 'event') continue
      if (it.kind === 'tool_start' && !this.endOf.has(it.ref)) open.push(it)
      const over = it.kind === 'session_end' || (it.kind === 'session_start' && it.source !== 'compact')
      if (over || (it.kind === 'stop' && !it.agent)) {
        for (const t of open) if (over || !t.agent) this.stopped.add(t)
        open = open.filter(t => !this.stopped.has(t))
      }
    }
  }

  renderItem(it) {
    if (it.t === 'message') {
      const file = it.file ? `${it.text ? '\n' : ''}📎 ${esc(it.file.name)}` : ''
      if (it.system) return `<div class="sysline notice">${esc(it.text)}<div class="t">${hhmm(it.ts)} · ${T.serverNotice}</div></div>`
      if (it.from === this.name) {
        return `<div class="sent"><div class="h">→ <b>${esc(it.target)}</b>${msgTag(it)} · ${hhmm(it.ts)}${it.edited_at ? ` · ${T.editedMark}` : ''}</div><div class="x">${clipEsc(it, 'text', MAX_RENDER_TEXT)}${file}</div></div>`
      }
      return `<div class="row-user"><div class="bubble-head"><b>${esc(it.from)}</b>${it.target.startsWith('#') ? T.inGroup(esc(it.target)) : ''}${msgTag(it)} · ${hhmm(it.ts)}${it.edited_at ? ` · ${T.editedMark}` : ''}</div><div class="bubble in">${clipEsc(it, 'text', MAX_RENDER_TEXT)}${file}</div></div>`
    }
    switch (it.kind) {
      case 'prompt': return `<div class="row-user"><div class="bubble-head"><b>${T.you}</b> · ${hhmm(it.ts)}</div><div class="bubble">${clipEsc(it, 'text', MAX_RENDER_TEXT)}</div></div>`
      case 'text': return `<div class="assistant">${mdCached(it)}</div>`
      case 'stop': return `<div class="divider">${T.turnEnded} · ${hhmm(it.ts)}${num(it.background_tasks) ? ` · ${T.background(num(it.background_tasks))}` : ''}</div>`
      case 'notification': return `<div class="sysline warn">⏳ ${it.text ? clipEsc(it, 'text', 500) : esc(it.type)} · ${hhmm(it.ts)}</div>`
      case 'compact': return `<div class="sysline">${T.compactingLine} · ${hhmm(it.ts)}</div>`
      case 'compacted': return `<div class="sysline">${T.compactedLine(it.trigger !== 'manual')} · ${hhmm(it.ts)}${it.summary ? `<details style="text-align:left"><summary>${T.compactSummary}</summary><pre style="white-space:pre-wrap;font:12px/1.4 var(--mono);background:var(--panel-2);padding:8px;border-radius:6px;max-height:300px;overflow:auto">${clipEsc(it, 'summary', MAX_RENDER_TEXT)}</pre></details>` : ''}</div>`
      case 'session_start': if (it.source === 'clear') return `<div class="sysline">🧹 ${T.contextCleared} · ${hhmm(it.ts)}</div>`
        return `<div class="sysline">${T.sessionStarted(it.source === 'resume')}${it.cwd ? T.inDir(esc(it.cwd)) : ''} · ${hhmm(it.ts)}</div>`
      case 'session_end': return `<div class="sysline">${T.sessionEnded}${it.reason ? ` (${esc(it.reason)})` : ''} · ${hhmm(it.ts)}</div>`
      case 'observe_start': return `<div class="sysline">${T.observing(esc(it.level))} · ${hhmm(it.ts)}</div>`
      default: return ''
    }
  }

  renderGroup(group, activity, left = { chars: Infinity, tags: Infinity }) {
    const tools = []
    for (const ev of group.list) {
      if (ev.kind === 'tool_start') tools.push({ start: ev, end: this.endOf.get(ev.ref) ?? null })
      else if (ev.kind === 'tool_end') tools.push({ start: { ...ev, summary: '' }, end: ev }) // its start isn't loaded
      else tools.push({ sub: ev })
    }
    const real = tools.filter(t => !t.sub)
    const running = real.filter(t => !t.end && !this.stopped.has(t.start))
    const failed = real.filter(t => t.end && t.end.ok === false)
    const noResult = real.some(t => !t.end && this.stopped.has(t.start))
    const names = [...new Set(real.map(t => toolName(t.start.tool)))]
    const waitingId = activity?.state === 'waiting' ? activity.tool?.id : null
    const st = running.length
      ? (running.some(t => t.start.ref === waitingId) ? `<span class="res err">${T.waitingPermission}</span>` : `<span class="res run">⏳ ${T.running(running.length)}</span>`)
      : failed.length ? `<span class="res err">✗ ${T.withErrors(failed.length)}</span>` : noResult ? `<span class="res">${T.noResult}</span>` : '<span class="res ok">✓</span>'
    const userChoice = this.openGroups.get(group.key)
    const open = userChoice ?? (running.length > 0)
    // Newest tools first, as many as fit in what the view has left.
    const rows = []
    let chars = left.chars - 4000, tags = left.tags - 40, k = tools.length
    for (; k > 0; k--) {
      const t = tools[k - 1]
      const row = t.sub ? `<div class="tool"><div class="line">🤖 <span class="arg">${T.subagent(t.sub.kind === 'subagent_start')}</span></div>${t.sub.text ? `<details><summary>${T.result}</summary><pre>${clipEsc(t.sub, 'text')}</pre></details>` : ''}</div>` : this.renderTool(t, waitingId)
      const n = tagsIn(row)
      if (row.length > chars || n > tags) break
      rows.push(row)
      chars -= row.length
      tags -= n
    }
    if (k) rows.push(`<div class="tool"><div class="line"><span class="arg">${T.olderHidden(k)}</span></div></div>`)
    rows.reverse()
    return `<details class="tools" data-g="${group.key}"${open ? ' open' : ''}>
        <summary><span>🔧</span><span class="names">${T.tools(real.length)} · ${esc(names.join(', '))}</span><span class="st">${st}</span></summary>
        <div class="list">${rows.join('')}</div></details>`
  }

  renderTool({ start, end }, waitingId) {
    let res
    if (!end && this.stopped.has(start)) res = `<span class="res">${T.noResult}</span>`
    else if (!end && start.ref === waitingId) res = `<span class="res err">${T.permShort}</span>`
    else if (!end) res = `<span class="res run" data-since="${start.ts}">⏳ ${dur(now() - start.ts)}</span>`
    else if (end.ok === false) res = `<span class="res err">✗ ${end.interrupted ? T.interrupted : end.summary ? clipEsc(end, 'summary', 300) : T.error}${end.duration_ms ? ` · ${dur(end.duration_ms)}` : ''}</span>`
    else res = `<span class="res ok">✓${end.summary ? ` ${clipEsc(end, 'summary', 300)}` : ''}${end.duration_ms ? ` · ${dur(end.duration_ms)}` : ''}</span>`
    const det = []
    if (start.detail) det.push(`<details><summary>${T.input}</summary><pre>${clipEsc(start, 'detail')}</pre></details>`)
    if (end?.detail) det.push(`<details><summary>${end.ok === false ? T.error : T.output}</summary><pre>${clipEsc(end, 'detail')}</pre></details>`)
    const sum = clipEsc(start, 'summary', 300)
    const tip = esc(String(start.summary ?? '').slice(0, 300)) // an attribute: plain text only
    return `<div class="tool"><div class="line"><span>${toolIcon(start.tool)}</span><span class="tn">${esc(toolName(start.tool))}</span>${start.agent ? `<span class="agent">${esc(start.agent)}</span>` : ''}<span class="arg" title="${tip}">${sum}</span>${res}</div>${det.join('')}</div>`
  }

  renderStatus() {
    const s = sessions.get(this.name)
    const st = status(s)
    const bar = this.el.querySelector('.status')
    bar.classList.toggle('waiting', !!st.waiting)
    bar.querySelector('.dot').className = `dot ${st.dot}`
    bar.querySelector('.txt').textContent = st.text
    bar.querySelector('.txt').title = st.text
  }

  tick() {
    for (const el of this.itemsEl.querySelectorAll('.res.run[data-since]')) el.textContent = `⏳ ${dur(now() - Number(el.dataset.since))}`
    this.renderStatus()
  }
}

const ICON = { Bash: '⚙️', Read: '📖', Write: '✏️', Edit: '✏️', MultiEdit: '✏️', NotebookEdit: '✏️', Grep: '🔎', Glob: '🔎', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖', Agent: '🤖', TodoWrite: '📋', Skill: '🧩' }
const toolIcon = t => (Object.hasOwn(ICON, t) ? ICON[t] : String(t).startsWith('mcp__') ? '🔌' : '🔧')
export const toolName = t => String(t ?? '').startsWith('mcp__') ? String(t).split('__').slice(1).join(' › ') : (t ?? '')
