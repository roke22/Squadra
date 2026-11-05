import { $ } from './dom.js'
import { T, COLLATOR } from './i18n.js'
import { sessions, hosts, state, hostListeners } from './state.js'
import { esc, dur, now, hhmm } from './format.js'
import { status } from './content.js'
import { setHtml } from './nav.js'
import { currentRoute } from './router.js'
import { sessionOn, roleTag, personaTag } from './topbar.js'
import { closeMenu, dialog, confirmDialog } from './dialogs.js'
import { newSessionDialog, templatesDialog } from './squads.js'
import { showLogin, serverVersion, olderThan } from './app.js'

// machines (squadra-host): list, add, rename, disconnect, open and close sessions

// The machine where a session runs, if it was opened from here.
// Only on the machine the server opened it on (host_id): another machine
// claiming a session with the same name never gets its terminal button.
export function terminalOf(name) {
  const owner = sessions.get(name)?.host_id
  if (!owner) return null
  const h = hosts.get(owner)
  const t = h?.online && h.info?.terminals?.find(x => x.id === name)
  return t ? { host: h, term: t } : null
}

export async function postJson(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
    body: JSON.stringify(body),
  })
  if (r.status === 401) { showLogin(T.tokenInvalid); throw new Error(T.unauthorized) }
  const j = await r.json()
  if (!j.ok) {
    const why = j.description.replace(/^(Bad Request|Conflict|Forbidden): /, '')
    // (A machine's own words are said to be its own, never the dashboard's.)
    const r = j.parameters?.reason
    throw new Error(r === 'name_in_use' ? T.nameTaken(body?.spec?.name ?? '') : r === 'open_on_host' ? T.openOnHost(body?.spec?.name ?? '') : r === 'machine_refused' ? `${T.machineSays}: «${why}»` : why)
  }
  return j.result
}

export function hostLine(h) {
  const i = h.info ?? {}
  return [i.hostname && i.hostname !== h.name ? i.hostname : '', [i.platform, i.arch].filter(Boolean).join(' '), i.claude ? `Claude ${i.claude.replace(/\s*\(Claude Code\)/, '')}` : '', i.tmux, i.version ? `host v${i.version}` : ''].filter(Boolean).join(' · ')
}

// A machine's allowed folders: removable, and one more can be added, when
// the machine lets the dashboard change them (squadra-host 0.0.3+).
function folderChips(h) {
  const i = h.info ?? {}
  const editable = h.online && i.folders_from_dashboard === true
  const chips = (i.folders ?? []).map(f => {
    const home = i.home && f === i.home
    return `<span class="fchip ${home ? 'home' : ''}" title="${esc(home ? T.homeFolder : f)}"><code>${home ? '🏠 ' : ''}${esc(f)}</code>${editable ? `<button type="button" data-hact="rmfolder" data-h="${esc(h.id)}" data-f="${esc(f)}" title="${esc(T.removeFolder(f))}" aria-label="${esc(T.removeFolder(f))}">✕</button>` : ''}</span>`
  }).join(' ')
  return `${chips || T.noFolders}${editable ? ` <button type="button" class="btn addf" data-hact="addfolder" data-h="${esc(h.id)}">${T.addFolder}</button>` : h.online && i.folders_from_dashboard === false && i.version ? ` <span class="t">(${T.foldersLocal})</span>` : ''}`
}

// Connected, disconnected, or enrolled and never connected yet.
export function hostState(h) {
  if (h.online) return T.hostOnline
  if (h.pending) return T.hostPending(h.created_at ? dur(now() - h.created_at) : '—')
  return T.hostOffline(h.last_seen_at ? dur(now() - h.last_seen_at) : '—')
}
export function renderHosts(only) {
  const list = [...hosts.values()].filter(h => !only || h.id === only).sort((a, b) => (b.online - a.online) || COLLATOR.compare(a.name, b.name))
  if (!list.length) { setHtml($('hosts'), `<div class="host-list"><div class="mosaic-empty">${only && hosts.size ? `${T.machineNotFound} <a href="#/hosts">${T.allMachines}</a>` : T.noMachines}</div></div>`); return }
  setHtml($('hosts'), `<div class="host-list">${list.map(h => {
    const i = h.info ?? {}
    const terms = i.terminals ?? []
    const rows = terms.map(t => {
      const s = sessionOn(h.id, t.id)
      return `<div class="term-row">
          <span class="dot ${s ? status(s).dot : ''}" title="${esc(s ? status(s).text : '')}"></span><span class="n">${esc(t.name)}</span>${roleTag(t.role)}${personaTag(t.persona)}
          <span class="m" title="${esc(t.folder ?? '')}">${esc(t.folder ?? '')}${t.role === 'worker' && t.coordinator ? ` · ${esc(T.coordinatorOf(t.coordinator))}` : ''}</span>
          <span class="acts">
            ${h.online ? `<button class="btn" data-go="#/t/${encodeURIComponent(h.id)}/${encodeURIComponent(t.id)}">${T.terminal}</button>` : ''}
            ${s ? `<button class="btn" data-go="#/s/${encodeURIComponent(t.id)}">${T.chat}</button>` : ''}
            ${h.online ? `<button class="btn danger" data-hact="kill" data-h="${esc(h.id)}" data-t="${esc(t.id)}">${T.closeSession}</button>` : ''}
          </span></div>`
    }).join('')
    return `<div class="host ${h.online ? '' : 'offline'}">
        <div class="host-head"><span class="dot ${h.online ? 'ok' : ''}"></span><span class="n">${esc(h.name)}</span>
          <span class="m">${hostState(h)}${hostLine(h) ? ` · ${esc(hostLine(h))}` : ''}</span>
          <span class="acts">${h.online ? `<button class="btn" data-hact="new" data-h="${esc(h.id)}">${T.newSession}</button>` : `<button class="btn danger" data-hact="disconnect" data-h="${esc(h.id)}">${T.disconnect}</button>`}<button class="more" data-hmenu="${esc(h.id)}" aria-label="${esc(T.actions(h.name))}">⋯</button></span></div>
        <div class="host-meta">${i.version && serverVersion && olderThan(i.version, serverVersion) ? `<span class="plugin-missing">${T.hostOld(esc(i.version), esc(serverVersion))}</span>` : ''}${i.plugin ? (i.plugin.installed && i.plugin.enabled ? `<span>${T.pluginOk(esc(i.plugin.version ?? ''))}</span>` : `<span class="plugin-missing">${T.pluginMissing(!i.plugin.installed)}</span>`) : ''}<span class="folders">${T.folders}: ${folderChips(h)}</span>${i.max_sessions ? `<span>${T.maxSessions(i.max_sessions)}</span>` : ''}<span>${i.allow_input === false ? T.typingOff : T.typingOn}</span></div>
        <div class="host-terms">${rows || `<div class="host-empty">${T.noTerminals}</div>`}</div>
      </div>`
  }).join('')}</div>`)
}

$('hosts').addEventListener('click', e => {
  const m = e.target.closest('[data-hmenu]')
  if (m) return openHostMenu(m, m.dataset.hmenu)
  const go = e.target.closest('[data-go]')
  if (go) location.hash = go.dataset.go
  const act = e.target.closest('[data-hact]')
  if (act) hostAction(act.dataset.hact, act.dataset.h, act.dataset.t ?? act.dataset.f)
})

function openHostMenu(anchor, id) {
  closeMenu()
  const h = hosts.get(id)
  if (!h) return
  state.menuEl = document.createElement('div')
  state.menuEl.className = 'menu'
  state.menuEl.innerHTML = `<button data-a="rename">${T.rename}</button><button data-a="disconnect" class="danger">${T.disconnect}</button>`
  document.body.appendChild(state.menuEl)
  const r = anchor.getBoundingClientRect()
  const w = state.menuEl.offsetWidth
  state.menuEl.style.top = `${Math.min(r.bottom + 4, innerHeight - state.menuEl.offsetHeight - 8)}px`
  state.menuEl.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  state.menuEl.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b) return
    closeMenu()
    hostAction(b.dataset.a, id)
  })
}

export function hostAction(action, id, term, extra = term) {
  const h = hosts.get(id)
  if (action === 'add') return addMachineDialog()
  if (action === 'new') return newSessionDialog(id)
  if (action === 'templates') return templatesDialog()
  if (action === 'rename' && h) {
    const d = dialog(`<h3>${T.renameTitle}</h3><label class="field"><span>${T.name}</span><input type="text" maxlength="40" value="${esc(h.name)}"></label><div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
        <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.save}</button></div>`)
    const input = d.el.querySelector('input')
    input.focus(); input.select()
    const save = async () => {
      try { await postJson('/api/hosts/rename', { host: id, name: input.value }); d.close() } catch (err) { d.el.querySelector('.err').textContent = err.message }
    }
    d.el.querySelector('[data-ok]').addEventListener('click', save)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save() })
    return
  }
  if (action === 'addfolder' && h) return addFolderDialog(id)
  if (action === 'rmfolder' && h) {
    return confirmDialog({ title: T.removeFolderTitle, text: T.removeFolderText(esc(extra)), confirm: T.stopAllowing, danger: true, run: () => postJson('/api/hosts/folders', { host: id, action: 'remove', path: extra }) })
  }
  if (action === 'disconnect' && h) {
    return confirmDialog({ title: T.disconnectTitle(h.name), text: T.disconnectText(esc(h.name)), confirm: T.disconnect, danger: true, run: () => postJson('/api/hosts/remove', { host: id }) })
  }
  if (action === 'kill') {
    return confirmDialog({
      title: T.closeSessionTitle(term), text: T.closeSessionText(esc(term), esc(h?.name ?? id)), confirm: T.closeSession, danger: true,
      run: async () => {
        await postJson('/api/terminals/kill', { host: id, term })
        if (currentRoute().view === 'terminal') location.hash = '#/hosts'
      },
    })
  }
}

// Allow one more folder on a machine: it checks the path against its own
// rules and says why when it can't be allowed. done(folder) after it is.
export function addFolderDialog(hostId, done) {
  const h = hosts.get(hostId)
  if (!h) return
  const d = dialog(`<h3>${esc(T.addFolderTitle(h.name))}</h3><p>${T.addFolderText} ${T.addFolderHome}</p>
      <label class="field"><span>${T.folderPath}</span><input type="text" maxlength="4096" placeholder="~/projects" autocomplete="off" spellcheck="false"></label>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.allow}</button></div>`)
  const input = d.el.querySelector('input')
  input.focus()
  const ok = d.el.querySelector('[data-ok]')
  const save = async () => {
    const path = input.value.trim()
    if (!path) return input.focus()
    ok.disabled = true
    try {
      const r = await postJson('/api/hosts/folders', { host: hostId, action: 'add', path })
      d.close()
      // (The machine's list as it answered: shown now, before its next update arrives.)
      const list = Array.isArray(r.folders) ? r.folders : null
      const host = hosts.get(hostId)
      if (host && list) host.info = { ...(host.info ?? {}), folders: list }
      done?.(list?.[list.length - 1] ?? null)
    } catch (err) { d.el.querySelector('.err').textContent = err.message.replace(/^Bad Request: /, ''); ok.disabled = false }
  }
  ok.addEventListener('click', save)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save() })
}

export function addMachineDialog() {
  const d = dialog(`<h3>${T.addTitle}</h3><p>${T.addIntro}</p>
      <div data-step="1">
        <label class="field"><span>${T.machineName}</span><input type="text" maxlength="40" placeholder="${esc(T.machineNameHint)}"></label>
        <label class="check"><input type="checkbox"> <span>${T.configurePlugin}</span></label>
        <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
        <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-gen>${T.generate}</button></div>
      </div>
      <div data-step="2" hidden>
        <div class="os-pick"><span>${T.osPick}</span><span class="seg">${['linux', 'macos', 'windows'].map(o => `<button type="button" data-os="${o}">${{ linux: 'Linux', macos: 'macOS', windows: 'Windows' }[o]}</button>`).join('')}</span></div>
        <div class="steps"></div>
        <div class="wait"><span class="dot info pulse"></span><span class="w">${T.waitingMachine}</span></div>
        <div class="actions"><button class="btn" data-cancel>${T.done}</button><button class="btn primary" data-newsession hidden>${T.newSession}</button></div>
      </div>`, { wide: true })
  const input = d.el.querySelector('input[type=text]')
  input.focus()
  let joined = null
  let ticket = null // this dialog's code: only the machine that used it counts
  const listener = h => {
    if (h.removed || !h.online || !ticket || h.enrollment !== ticket) return
    joined = h
    d.el.querySelector('.wait').innerHTML = `<span class="dot ok"></span><span>${T.machineJoined(esc(h.name))}</span>`
    d.el.querySelector('[data-newsession]').hidden = false
  }
  d.el.onclose = () => hostListeners.delete(listener)
  d.el.querySelector('[data-gen]').addEventListener('click', async e => {
    e.target.disabled = true
    try {
      const r = await postJson('/api/hosts/enroll', { name: input.value.trim(), configure_plugin: d.el.querySelector('input[type=checkbox]').checked })
      ticket = r.enrollment ?? null
      d.el.querySelector('[data-step="1"]').hidden = true
      d.el.querySelector('[data-step="2"]').hidden = false
      // One command for the machine's system, with its copy button.
      const guess = /Mac/i.test(navigator.platform) ? 'macos' : /Win/i.test(navigator.platform) ? 'windows' : 'linux'
      let os = guess, home = false, root = false
      const cmd = text => `<div class="cmdrow"><pre class="cmd">${esc(text)}</pre><button class="btn" data-copy>${T.copy}</button></div>`
      const insecure = /^http:\/\//.test(r.server_url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(r.server_url)
      const draw = () => {
        for (const b of d.el.querySelectorAll('[data-os]')) b.classList.toggle('on', b.dataset.os === os)
        const extra = (home ? ' --allow-home' : '') + (root && os !== 'macos' ? ' --allow-root' : '') + (insecure ? ' --insecure' : '')
        d.el.querySelector('.steps').innerHTML = `<p>${T.runOn(os)}</p>${cmd(String(r.install?.[os] ?? '') + extra)}
            <label class="check"><input type="checkbox" data-home ${home ? 'checked' : ''}> <span>${T.allowHome}</span></label>
            ${os === 'macos' ? '' : `<label class="check"><input type="checkbox" data-root ${root ? 'checked' : ''}> <span>${T.allowRoot}</span></label>`}
            <p class="note">${T.runWhat}${os === 'windows' ? ` ${T.windowsNote}` : ''}</p>
            ${insecure ? `<p class="note" style="color:var(--err);font-size:13px">${esc(T.httpWarn)}</p>` : ''}
            <p class="note valid">${esc(T.codeValid(hhmm(r.expires_at)))}</p>
            <p class="note">${T.afterJoin}</p>
            ${os === 'windows' ? '' : `<details class="manual"><summary>${T.manualCmd}</summary>${cmd(String(r.command ?? '') + extra)}</details>`}`
      }
      draw()
      d.el.querySelector('.os-pick').addEventListener('click', ev => { const b = ev.target.closest('[data-os]'); if (b) { os = b.dataset.os; draw() } })
      d.el.querySelector('.steps').addEventListener('change', ev => {
        if (ev.target.matches('[data-home]')) { home = ev.target.checked; draw() }
        if (ev.target.matches('[data-root]')) { root = ev.target.checked; draw() }
      })
      hostListeners.add(listener)
      d.el.querySelector('.steps').addEventListener('click', async ev => {
        const b = ev.target.closest('[data-copy]')
        if (!b) return
        const pre = b.parentElement.querySelector('.cmd')
        try { await navigator.clipboard.writeText(pre.textContent); b.textContent = T.copied } catch {
          const range = document.createRange(); range.selectNodeContents(pre)
          getSelection().removeAllRanges(); getSelection().addRange(range)
        }
      })
      d.el.querySelector('[data-newsession]').addEventListener('click', () => { d.close(); location.hash = '#/hosts'; newSessionDialog(joined?.id) })
    } catch (err) {
      d.el.querySelector('.err').textContent = err.message
      e.target.disabled = false
    }
  })
}
