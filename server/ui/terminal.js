import { T } from './i18n.js'
import { state, hosts, hostListeners } from './state.js'
import { esc } from './format.js'
import { navigatedInApp, mosaicPanes } from './router.js'
import { postJson } from './machines.js'

// web terminal: xterm.js (loaded on first use) over one WebSocket per tab
let xtermReady = null
function loadXterm() {
  if (xtermReady) return xtermReady
  // Served by squadra-server itself (vendor/): no third-party scripts.
  const css = document.createElement('link')
  css.rel = 'stylesheet'
  css.href = '/vendor/xterm.css'
  document.head.appendChild(css)
  const script = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s) })
  xtermReady = script('/vendor/xterm.js').then(() => script('/vendor/addon-fit.js'))
  xtermReady.catch(() => { xtermReady = null })
  return xtermReady
}

const b64bytes = b => Uint8Array.from(atob(b), c => c.charCodeAt(0))

export const termLink = {
  ws: null, ready: false, views: new Set(), backoff: 1000, timer: null,
  retry() {
    for (const v of this.views) v.overlay(T.termLinkDown)
    if (this.views.size) { clearTimeout(this.timer); this.timer = setTimeout(() => this.ensure(), this.backoff); this.backoff = Math.min(this.backoff * 2, 15000) }
  },
  ensure() {
    if (this.ws || this.connecting || !state.token) return
    // A one-time ticket (the token itself never goes in the socket request):
    // the server only accepts the socket with it.
    this.connecting = true
    postJson('/api/terminal/ticket', {}).then(({ ticket }) => {
      this.connecting = false
      if (!this.ws && this.views.size) this.open(ticket)
    }, () => { this.connecting = false; if (state.token) this.retry() })
  },
  open(ticket) {
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal`, ['squadra', `auth.${ticket}`])
    ws.onmessage = ev => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.t === 'ready') { this.ready = true; this.backoff = 1000; for (const v of this.views) v.attach(); return }
      for (const v of this.views) if (v.host === m.host && v.term === m.term) v.onMessage(m)
    }
    ws.onclose = ev => {
      if (this.ws !== ws) return
      this.ws = null
      this.ready = false
      this.retry()
    }
  },
  send(m) { if (this.ready && this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)) },
  add(v) { this.views.add(v); this.ensure(); if (this.ready) v.attach() },
  remove(v) { this.send({ t: 'detach', host: v.host, term: v.term }); this.views.delete(v) },
  close() { clearTimeout(this.timer); const ws = this.ws; this.ws = null; this.ready = false; this.views.clear(); ws?.close() },
}
export class TermView {
  // compact: a pane of a mosaic (no long hint underneath, never focused by
  // itself); root gets "term-focused" while typing goes to this terminal.
  constructor(host, term, root, { compact = false } = {}) {
    this.host = host
    this.term = term
    this.dead = false
    this.compact = compact
    this.root = root
    root.innerHTML = `<div class="term-box"><div class="term-over">${T.termLoading}</div></div><div class="term-foot"></div>`
    this.box = root.querySelector('.term-box')
    this.over = root.querySelector('.term-over')
    this.foot = root.querySelector('.term-foot')
    this.renderFoot()
    loadXterm().then(() => { if (!this.dead) this.start() }, () => this.overlay(T.termLoadFailed))
  }

  renderFoot() {
    const h = hosts.get(this.host)
    const ro = h?.info?.allow_input === false
    this.foot.innerHTML = (ro ? `<span class="ro">👁 ${T.readOnly}</span><span>${esc(T.typingOff)}</span>` : this.compact ? '' : `<span>${esc(T.termHint(h?.name ?? this.host))}</span>`) +
      (this.notice ? `<span class="ro">⚠ ${T.machineSays}: ${esc(this.notice)}</span>` : '')
  }

  // A pasted image, at most the size Claude uses (1568 px on its long side)
  // and small enough to send: PNG, or WebP/JPEG, smaller if needed.
  async pasteImage(file) {
    if (hosts.get(this.host)?.info?.allow_input === false) return this.toast(T.typingOff)
    try {
      const bmp = await createImageBitmap(file)
      let scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height))
      let data = null, type = null
      for (let i = 0; i < 6 && !data; i++, scale *= 0.75) {
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale))
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
        for (const [t, q] of [['image/png'], ['image/webp', 0.9], ['image/jpeg', 0.85]]) {
          const blob = await new Promise(r => c.toBlob(r, t, q))
          if (!blob || blob.type !== t || blob.size > 580_000) continue
          const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(blob) })
          data = url.slice(url.indexOf(',') + 1); type = t
          break
        }
      }
      bmp.close?.()
      if (!data) throw new Error('too large')
      termLink.send({ t: 'image', host: this.host, term: this.term, type, data })
      this.toast(T.imageSent)
      this.x.focus()
    } catch { this.toast(T.imageFailed) }
  }

  // A short note over the terminal ("Copied").
  toast(text) {
    this.box.querySelector('.term-toast')?.remove()
    const t = document.createElement('div')
    t.className = 'term-toast'
    t.textContent = text
    this.box.appendChild(t)
    setTimeout(() => t.remove(), 1200)
  }

  start() {
    const dark = { background: '#161513', foreground: '#ecebe7', cursor: '#e0855f', selectionBackground: '#4a4740' }
    this.x = new window.Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13.5, cursorBlink: true, scrollback: 5000, theme: dark, allowProposedApi: false,
      // (On macOS, Option+drag selects even when the program uses the mouse;
      // Shift+drag does everywhere.)
      macOptionClickForcesSelection: true,
      // Links printed by the program (OSC 8): only http(s), after a confirmation, in a new tab.
      // Only plain http(s) links, shown as they are (no user:password@, no
      // control or direction characters that could make it read otherwise).
      linkHandler: { activate: (e, uri) => {
        let u
        try { u = new URL(uri) } catch { return }
        if (!/^https?:$/.test(u.protocol) || u.username || u.password || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(uri)) return
        if (confirm(`${T.openLink}\n${u.href}`)) window.open(u.href, '_blank', 'noopener,noreferrer')
      } },
    })
    this.fit = new window.FitAddon.FitAddon()
    this.x.loadAddon(this.fit)
    this.x.open(this.box)
    this.fitNow()
    // Copying, as in usual terminals: what is selected is copied by itself;
    // Ctrl+Shift+C (Cmd+C on macOS) copies too, and so does Ctrl+C while
    // something is selected (without a selection it still goes to Claude).
    const copy = async () => {
      const text = this.x.getSelection()
      if (!text) return false
      try { await navigator.clipboard.writeText(text) } catch {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch {}
        ta.remove()
        this.x.focus()
      }
      this.toast(T.copied)
      return true
    }
    let selTimer = null
    this.x.onSelectionChange(() => {
      clearTimeout(selTimer)
      if (this.x.hasSelection()) selTimer = setTimeout(() => { void copy() }, 250)
    })
    this.x.attachCustomKeyEventHandler(e => {
      // Ctrl+V pastes (text or an image) instead of sending ^V to Claude,
      // whose own image paste reads the machine's clipboard, not this one.
      if (e.type === 'keydown' && e.code === 'KeyV' && e.ctrlKey && !e.altKey && !e.metaKey) return false
      if (e.type !== 'keydown' || e.code !== 'KeyC' || !this.x.hasSelection()) return true
      if ((e.ctrlKey && !e.altKey) || (e.metaKey && !e.ctrlKey)) {
        e.preventDefault()
        void copy().then(() => this.x.clearSelection())
        return false
      }
      return true
    })
    // What xterm.js answers by itself to a program's queries (device
    // attributes, cursor position, modes, focus) isn't sent: tmux already
    // answers them, and every dashboard watching would type them in again.
    // (Unless a key was just pressed: Shift+F3 also looks like a report.)
    let keyAt = 0
    this.box.addEventListener('keydown', () => { keyAt = performance.now() }, true)
    const REPORT = /^(?:\x1b\[[?>=]?[\d;]*c|\x1b\[\??\d+;\d+R|\x1b\[\??[\d;]*\$y|\x1bP[01]\$r[^\x1b]*\x1b\\|\x1b\[[IO]|\x1b\[[\d;]*t|\x1b\][\d;]*rgb:[^\x07\x1b]*(?:\x07|\x1b\\))+$/
    this.x.onData(data => {
      if (hosts.get(this.host)?.info?.allow_input === false) return
      if (REPORT.test(data) && performance.now() - keyAt > 100) return
      termLink.send({ t: 'in', host: this.host, term: this.term, data })
    })
    // Pasted text can't carry escape sequences (they could end bracketed
    // paste and run what follows): control and bidi characters are dropped.
    this.box.addEventListener('paste', e => {
      // An image (a screenshot): sent to the machine, which hands it to
      // Claude Code. (Claude Code can't read this browser's clipboard.)
      const text = e.clipboardData?.getData('text') ?? ''
      const image = text ? null : [...(e.clipboardData?.items ?? [])].find(i => i.kind === 'file' && /^image\//.test(i.type))?.getAsFile()
      if (image) { e.preventDefault(); e.stopPropagation(); void this.pasteImage(image); return }
      const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u115f\u1160\u17b4\u17b5\u2065\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}\p{Cf}]/gu, '')
      if (clean !== text) { e.preventDefault(); e.stopPropagation(); this.x.paste(clean) }
    }, true)
    let resizeTimer = null
    this.x.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => termLink.send({ t: 'resize', host: this.host, term: this.term, cols, rows }), 150)
    })
    this.ro = new ResizeObserver(() => this.fitNow())
    this.ro.observe(this.box)
    // Not when the page was opened straight on this terminal (e.g. from a
    // link): typing goes to a machine only after the user chose it here.
    // (Nor a mosaic's pane: there it is clicked first.)
    if (navigatedInApp && !this.compact) this.x.focus()
    this.x.textarea?.addEventListener('focus', () => this.root.classList.add('term-focused'))
    this.x.textarea?.addEventListener('blur', () => this.root.classList.remove('term-focused'))
    termLink.add(this)
  }

  fitNow() { try { this.fit?.fit() } catch {} }

  attach() {
    if (!this.x) return
    this.overlay(null)
    termLink.send({ t: 'attach', host: this.host, term: this.term, cols: this.x.cols, rows: this.x.rows })
  }

  refresh() { termLink.send({ t: 'refresh', host: this.host, term: this.term }) }

  overlay(text) {
    this.over.hidden = !text
    if (text) this.over.textContent = text
  }

  onMessage(m) {
    if (m.t === 'screen') { this.x.reset(); this.x.write(b64bytes(m.data)); this.overlay(null); return }
    if (m.t === 'out') { this.x.write(b64bytes(m.data)); return }
    if (m.t === 'exit') return this.overlay(T.termEnded)
    if (m.t === 'host_down') return this.overlay(T.termHostDown)
    // What the machine says goes next to the footer, never in place of it:
    // the read-only state shown always comes from the machine's settings.
    if (m.t === 'notice') { this.notice = String(m.text ?? '').slice(0, 300); this.renderFoot() }
  }

  destroy() {
    this.dead = true
    this.ro?.disconnect()
    if (this.x) termLink.remove(this)
    this.x?.dispose()
  }
}

// A machine that comes back: re-attach the terminal on screen.
hostListeners.add(h => {
  const terms = [state.termView, ...[...mosaicPanes.values()].filter(p => p.kind === 'term').map(p => p.view)]
  for (const v of terms) {
    if (!v || v.host !== h.id) continue
    v.renderFoot()
    if (h.online && !v.over.hidden && v.over.textContent === T.termHostDown) v.attach()
  }
})
