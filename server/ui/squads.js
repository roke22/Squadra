import { T } from './i18n.js'
import { hosts, sessions, state, templateListeners, hostListeners } from './state.js'
import { esc } from './format.js'
import { sortedSessions } from './content.js'
import { setHtml, soon } from './nav.js'
import { currentRoute } from './router.js'
import { roleTag } from './topbar.js'
import { alertBox } from './mosaic.js'
import { dialog } from './dialogs.js'
import { terminalOf, postJson, addFolderDialog, renderHosts } from './machines.js'
import { renderOrg } from './org.js'

// A worker for this coordinator's squad, by default on the coordinator's machine.
// A session opened from here that ended (/quit, closed): open it again on
// its machine, as it was.
export function reopenable(s) {
  const role = s?.opened_role ?? s?.role
  return !!(s && !s.online && !s.archived_at && s.host_id && hosts.get(s.host_id)?.online && !terminalOf(s.name) && ['coordinator', 'worker', 'solo'].includes(role))
}
export function reopen(name) {
  const s = sessions.get(name)
  if (!reopenable(s)) return
  const role = s.opened_role ?? s.role
  newSessionDialog(s.host_id, { reopen: true, name, role, coordinator: role === 'worker' ? s.coordinator ?? undefined : undefined, folder: s.activity?.cwd ?? null, persona: s.opened_persona ?? '' })
}

export function addWorkerTo(coord) {
  newSessionDialog(terminalOf(coord)?.host.id, { coordinator: coord })
}

// squad templates: a coordinator and its workers (folder, persona and compact
// window each), saved to open the whole squad again in one go. Each session
// is opened like any other: its machine checks it against its own rules.
function squadMembers(coord) {
  const member = (s, role) => {
    const t = terminalOf(s.name)?.term
    return { name: s.name, role, folder: t?.folder ?? s.activity?.cwd ?? null, persona: t?.persona?.id ?? s.opened_persona ?? null, compact_window: t?.compact_window ?? null }
  }
  const c = sessions.get(coord)
  const ws = sortedSessions().filter(s => s.role === 'worker' && s.coordinator === coord)
  return { coordinator: c ? member(c, 'coordinator') : null, workers: ws.map(w => member(w, 'worker')) }
}
export const personaName = id => String(id ?? '').split(':')[2] ?? ''
const memberLine = m => `<b>${esc(m.name)}</b> ${roleTag(m.role)} ${m.folder ? `<code>${esc(m.folder)}</code>` : esc(T.tplNoFolder)}${m.persona ? ` · 🎭 ${esc(personaName(m.persona))}` : ''}`

export function saveTemplateDialog(coord) {
  const { coordinator, workers } = squadMembers(coord)
  if (!coordinator) return
  const d = dialog(`<h3>${esc(T.saveTemplateTitle(coord))}</h3><p class="hint" style="font-size:12.5px;margin:-2px 0 12px">${T.saveTemplateHint}</p>
      <label class="field"><span>${T.templateName}</span><input type="text" name="tname" maxlength="40" value="${esc(coord)}" autocomplete="off"></label>
      <ul class="tpl-members">${[coordinator, ...workers].map(m => `<li class="${m.folder ? '' : 'bad'}">${memberLine(m)}</li>`).join('')}</ul>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.save}</button></div>`, { wide: true })
  const input = d.el.querySelector('[name=tname]')
  input.focus(); input.select()
  d.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const err = d.el.querySelector('.err')
    if (!coordinator.folder) { err.textContent = T.tplCoordNoFolder; return }
    // (Workers whose folder isn't known are left out: said in the list above.)
    try {
      await postJson('/api/templates/save', { name: input.value.trim(), host: sessions.get(coord)?.host_id ?? null, coordinator, workers: workers.filter(w => w.folder) })
      d.close()
      alertBox(T.templateSaved(input.value.trim()))
    } catch (e) { err.textContent = e.message }
  })
}

export function templatesDialog() {
  const list = () => state.templates.length
    ? `<div class="tpl-list">${state.templates.map(t => `<div class="tpl-row"><span class="n">${esc(t.name)}</span><span class="m">${esc(T.tplSummary(t.coordinator?.name ?? '?', t.workers.length))}</span><button class="btn primary" data-launch="${esc(t.name)}">${T.tplLaunch}</button><button class="btn danger" data-del="${esc(t.name)}">${T.delete}</button></div>`).join('')}</div>`
    : `<p class="hint">${T.noTemplates}</p>`
  const d = dialog(`<h3>${T.templates}</h3><div data-list>${list()}</div><div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div><div class="actions"><button class="btn" data-cancel>${T.done}</button></div>`, { wide: true })
  const refresh = () => setHtml(d.el.querySelector('[data-list]'), list())
  templateListeners.add(refresh)
  const closed = d.el.onclose
  d.el.onclose = () => { templateListeners.delete(refresh); closed?.() }
  d.el.addEventListener('click', e => {
    const l = e.target.closest('[data-launch]')
    if (l) { d.close(); return launchTemplateDialog(l.dataset.launch) }
    const x = e.target.closest('[data-del]')
    if (x) postJson('/api/templates/delete', { name: x.dataset.del }).catch(err => { d.el.querySelector('.err').textContent = err.message })
  })
}

// Open a template's squad: the coordinator first, then its workers, one at
// a time (each machine opens one session at a time anyway).
function launchTemplateDialog(name) {
  const t = state.templates.find(x => x.name === name)
  if (!t?.coordinator) return
  const online = [...hosts.values()].filter(h => h.online)
  if (!online.length) return alertBox(T.noOnlineMachines)
  const members = [t.coordinator, ...t.workers.map(w => ({ ...w, role: 'worker' }))]
  const d = dialog(`<h3>${esc(T.tplLaunchTitle(name))}</h3><p class="hint" style="font-size:12.5px;margin:-2px 0 12px">${T.tplLaunchHint}</p>
      <label class="field"><span>${T.machine}</span><select name="host">${online.map(h => `<option value="${esc(h.id)}" ${h.id === t.host ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select></label>
      <ul class="tpl-members">${members.map((m, i) => `<li data-i="${i}">${memberLine({ ...m, role: i ? 'worker' : 'coordinator' })} <span class="st"></span></li>`).join('')}</ul>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.tplLaunch}</button></div>`, { wide: true })
  const ok = d.el.querySelector('[data-ok]')
  ok.addEventListener('click', async () => {
    ok.disabled = true
    ok.textContent = T.opening
    const host = d.el.querySelector('[name=host]').value
    let failed = false
    for (const [i, m] of members.entries()) {
      const li = d.el.querySelector(`[data-i="${i}"]`)
      const st = li.querySelector('.st')
      li.className = ''
      // Already running (this machine or another): left as it is.
      if (terminalOf(m.name) || sessions.get(m.name)?.online) { st.textContent = `· ${T.tplAlready}`; li.className = 'ok'; continue }
      st.textContent = '…'
      const spec = { name: m.name, role: i ? 'worker' : 'coordinator', folder: m.folder }
      if (i) spec.coordinator = t.coordinator.name
      if (m.compact_window) spec.compact_window = m.compact_window
      if (m.persona) spec.persona = m.persona
      try {
        await postJson('/api/terminals/open', { host, spec })
        st.textContent = '✓'
        li.className = 'ok'
      } catch (e) {
        st.textContent = `✗ ${e.message}`
        li.className = 'bad'
        failed = true
        if (!i) break // without its coordinator, the workers would have no one to report to
      }
    }
    if (!failed) { d.close(); location.hash = `#/q/${encodeURIComponent(t.coordinator.name)}`; return }
    ok.disabled = false
    ok.textContent = T.tplRetry
  })
}

// A persona list's options, by kind and where they come from. (An agent
// whose tools leave out Squadra's can't message its squad: only solo.)
export function personaOptions(list, want, solo) {
  const groups = [['skill', 'project', T.personaSkillsProject], ['skill', 'user', T.personaSkillsUser], ['agent', 'project', T.personaAgentsProject], ['agent', 'user', T.personaAgentsUser]]
  return groups.map(([kind, scope, label]) => {
    const xs = list.filter(p => p.kind === kind && p.scope === scope)
    return xs.length ? `<optgroup label="${esc(label)}">${xs.map(p => { const off = p.no_squadra_tools && !solo; return `<option value="${esc(p.id)}" ${p.id === want && !off ? 'selected' : ''} ${off ? 'disabled' : ''}>${esc(p.name)}${off ? ` — ${esc(T.personaNoTools)}` : ''}</option>` }).join('')}</optgroup>` : ''
  }).join('')
}

// A message between two linked coordinators: the line's count goes up.
export function noteLinkMessage(m) {
  if (m.system || !m.from || !m.target) return
  const l = state.links.find(x => (x.a === m.from && x.b === m.target) || (x.b === m.from && x.a === m.target))
  if (!l) return
  l.recent = [m.created_at, ...(l.recent ?? [])].slice(0, 100)
  if (currentRoute().view === 'org') soon(renderOrg)
}

export function newSessionDialog(hostId, preset = {}) {
  const online = [...hosts.values()].filter(h => h.online)
  if (!online.length) return alertBox(T.noOnlineMachines)
  // Coordinators to suggest. A session declares its role itself, so only
  // one opened from the dashboard (host_id) is pre-filled; any other one
  // must be typed or picked on purpose.
  const coords = [...sessions.values()].filter(s => s.role === 'coordinator' && !s.deleted).map(s => s.name)
  const ownCoords = [...sessions.values()].filter(s => s.opened_role === 'coordinator' && s.role === 'coordinator' && s.host_id && !s.deleted).map(s => s.name)
  const hasCoord = !!preset.coordinator || ownCoords.length > 0
  // The worker's coordinator is picked from the ones that exist: those
  // opened from this dashboard first; the rest only declared it themselves.
  // Pre-selected only when it can't be anyone else (adding a worker to a
  // squad, or the dashboard's only coordinator).
  const coordOptions = () => {
    const list = [...new Set([...(preset.coordinator ? [preset.coordinator] : []), ...ownCoords, ...coords])]
    if (!list.length) return `<option value="">—</option>`
    const pick = preset.coordinator ?? (ownCoords.length === 1 ? ownCoords[0] : '')
    const label = c => {
      const st = sessions.get(c)
      return [c, ownCoords.includes(c) ? T.coordOwn : T.coordSelf, st && !st.online ? T.coordOffline : ''].filter(Boolean).join(' · ')
    }
    return `${pick ? '' : `<option value="" selected>${T.coordPick}</option>`}${list.map(c => `<option value="${esc(c)}" ${c === pick ? 'selected' : ''}>${esc(label(c))}</option>`).join('')}`
  }
  const d = dialog(`<h3>${preset.reopen ? esc(T.reopenTitle(preset.name)) : preset.coordinator ? esc(T.addWorkerTo(preset.coordinator)) : T.newSessionTitle}</h3>${preset.reopen ? `<p class="hint" style="font-size:12.5px;margin:-2px 0 12px">${T.reopenHint}</p>` : ''}
      <label class="field"><span>${T.machine}</span><select name="host">${online.map(h => `<option value="${esc(h.id)}" ${h.id === hostId ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select></label>
      <div class="row2">
        <label class="field"><span>${T.role}</span><select name="role"><option value="worker" ${hasCoord ? 'selected' : ''}>${T.roleWorker}</option><option value="coordinator" ${hasCoord ? '' : 'selected'}>${T.roleCoordinator}</option><option value="solo">${T.roleSoloOption}</option></select></label>
        <label class="field"><span>${T.sessionName}</span><input type="text" name="name" maxlength="32" pattern="[A-Za-z0-9_-]{1,32}" autocomplete="off"></label>
      </div>
      <label class="field" data-only="worker"><span>${T.coordinatorName}</span><select name="coordinator">${coordOptions()}</select></label>
      <div class="row2" data-only="coordinator">
        <label class="field"><span>${T.orgSquadTitleOpt}</span><input type="text" name="sqtitle" maxlength="40" autocomplete="off"></label>
        <label class="field"><span>${T.orgGoalOpt}</span><input type="text" name="sqgoal" maxlength="300" autocomplete="off"></label>
      </div>
      <div class="row2">
        <label class="field"><span>${T.folder}</span><select name="folder"></select></label>
        <label class="field"><span>${T.subfolder}</span><input type="text" name="sub" placeholder="${esc(T.subfolderHint)}" autocomplete="off"></label>
      </div>
      <label class="field"><span>${T.persona}</span><select name="persona"><option value="">${T.personaNone}</option></select></label>
      <div class="persona-hint"></div>
      <label class="field"><span>${T.compact}</span><select name="compact">
        <option value="600000" selected>${T.compactRec}</option>
        <option value="">${T.compactDefault}</option>
        ${[300, 400, 500, 700, 800].map(k => `<option value="${k * 1000}">${T.compactK(k)}</option>`).join('')}
      </select><span class="hint">${T.compactHint}</span></label>
      <p class="hint" style="font-size:12px;color:var(--muted);margin:0 0 8px">${T.resumeHint}</p>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.open}</button></div>`, { wide: true })
  const f = name => d.el.querySelector(`[name=${name}]`)
  const suggestName = () => {
    if (f('role').value === 'coordinator') return sessions.has('coord') && sessions.get('coord').online ? '' : 'coord'
    if (f('role').value === 'solo') { for (let i = 1; ; i++) if (!sessions.has(`claude${i}`) && !terminalOf(`claude${i}`)) return `claude${i}` }
    for (let i = 1; ; i++) if (!sessions.get(`worker${i}`)?.online && !terminalOf(`worker${i}`)) return `worker${i}`
  }
  // A coordinator that wasn't opened from this dashboard is only a name a
  // session gave itself: said right next to the field.
  const coordHint = document.createElement('div')
  coordHint.style.cssText = 'color:var(--err);font-size:12px;min-height:1em'
  f('coordinator').after(coordHint)
  const checkCoord = () => {
    const v = f('coordinator').value
    coordHint.textContent = !coords.length && !preset.coordinator ? T.coordNoneYet : v && !ownCoords.includes(v) ? `⚠ ${T.coordSelf}` : ''
  }
  f('coordinator').addEventListener('change', checkCoord)
  checkCoord()
  // The machine's allowed folders, kept current while the dialog is open
  // (one added there shows up here by itself).
  const folderHint = document.createElement('div')
  folderHint.className = 'hint'
  folderHint.style.cssText = 'font-size:12px;color:var(--muted)'
  d.el.querySelector('[name=folder]').closest('.row2').after(folderHint)
  let shownFolders = null
  const syncFolders = () => {
    const h = hosts.get(f('host').value)
    const folders = h?.info?.folders ?? []
    const key = JSON.stringify(folders)
    if (key === shownFolders) return
    shownFolders = key
    const was = f('folder').value
    f('folder').innerHTML = folders.length ? folders.map(x => `<option value="${esc(x)}" ${x === was ? 'selected' : ''}>${x === h?.info?.home ? '🏠 ' : ''}${esc(x)}</option>`).join('') : `<option value="">—</option>`
    noteFolder()
  }
  // What to do without folders (+ Folder right here), or what a session in
  // the home folder means.
  const noteFolder = () => {
    const h = hosts.get(f('host').value)
    const editable = h?.info?.folders_from_dashboard === true
    if (!(h?.info?.folders ?? []).length) folderHint.innerHTML = `${T.noFoldersHere}${editable ? ` <button type="button" class="btn" data-addf>${T.addFolder}</button>` : ''}`
    else folderHint.innerHTML = h?.info?.home && f('folder').value === h.info.home && !f('sub').value.trim() ? `⚠ ${T.homeSession}` : ''
    loadPersonas()
  }
  // The persona: a skill or agent the machine finds for that folder (the
  // project's and the user's ~/.claude). Picked from a list, never typed (a
  // misspelled name would load nothing); the machine looks it up again.
  const personaHint = d.el.querySelector('.persona-hint')
  let personaKey = null, personaList = [], personaTimer = null, personaSeq = 0
  let wantPersona = preset.persona ?? ''
  const folderNow = () => {
    const base = f('folder').value
    const sub = f('sub').value.trim().replace(/^\/+|\/+$/g, '')
    return base ? (sub ? `${base.replace(/\/+$/, '')}/${sub}` : base) : ''
  }
  const notePersona = () => {
    const p = personaList.find(x => x.id === f('persona').value)
    personaHint.textContent = p ? (p.description || T.personaNoDescription) : personaList.length ? T.personaHint : ''
  }
  const renderPersonas = () => {
    const want = f('persona').value || wantPersona
    const solo = f('role').value === 'solo'
    f('persona').innerHTML = `<option value="">${T.personaNone}</option>${personaOptions(personaList, want, solo)}`
    notePersona()
  }
  function loadPersonas() {
    clearTimeout(personaTimer)
    personaTimer = setTimeout(async () => {
      const host = f('host').value, folder = folderNow()
      const key = `${host}\0${folder}`
      if (key === personaKey) return
      personaKey = key
      const seq = ++personaSeq
      if (f('persona').value) wantPersona = f('persona').value
      personaList = []
      renderPersonas()
      if (!host || !folder) return
      personaHint.textContent = T.personaLoading
      try {
        const r = await postJson('/api/hosts/personas', { host, folder })
        if (seq !== personaSeq) return
        personaList = r.personas ?? []
        renderPersonas()
        if (!personaList.length) personaHint.textContent = T.personaNoneFound
      } catch (e) {
        if (seq === personaSeq) personaHint.textContent = `${T.personaLoadFailed}: ${e.message}`
      }
    }, 300)
  }
  folderHint.addEventListener('click', e => { if (e.target.closest('[data-addf]')) addFolderDialog(f('host').value, folder => { shownFolders = null; syncFolders(); if (folder) f('folder').value = folder; noteFolder(); renderHosts(currentRoute().host) }) })
  const soloHint = document.createElement('p')
  soloHint.className = 'hint'
  soloHint.style.cssText = 'font-size:12px;color:var(--muted);margin:-4px 0 10px'
  soloHint.textContent = T.soloHint
  d.el.querySelector('.row2').after(soloHint)
  const sync = () => {
    d.el.querySelector('[data-only=worker]').hidden = f('role').value !== 'worker'
    d.el.querySelector('[data-only=coordinator]').hidden = f('role').value !== 'coordinator' || !!preset.reopen
    soloHint.hidden = f('role').value !== 'solo'
    syncFolders()
  }
  const onHost = h => { if (h.id === f('host').value) syncFolders() }
  hostListeners.add(onHost)
  const closed = d.el.onclose
  d.el.onclose = () => { hostListeners.delete(onHost); closed?.() }
  f('role').addEventListener('change', () => { f('name').value = suggestName(); sync(); renderPersonas() })
  f('persona').addEventListener('change', notePersona)
  f('host').addEventListener('change', sync)
  f('folder').addEventListener('change', noteFolder)
  f('sub').addEventListener('input', noteFolder)
  f('name').value = suggestName()
  // A new squad (from the org chart): a coordinator.
  if (preset.role && !preset.reopen) { f('role').value = preset.role; f('name').value = suggestName() }
  // Reopening a session: what it was opened with, and the last folder it worked in.
  if (preset.reopen) {
    f('role').value = preset.role
    f('name').value = preset.name
    sync()
    const folders = hosts.get(f('host').value)?.info?.folders ?? []
    const base = preset.folder ? folders.filter(x => preset.folder === x || preset.folder.startsWith(x.replace(/\/+$/, '') + '/')).sort((a, b) => b.length - a.length)[0] : null
    if (base) { f('folder').value = base; f('sub').value = preset.folder.slice(base.replace(/\/+$/, '').length).replace(/^\/+/, ''); noteFolder() }
  }
  sync()
  f('name').focus()
  const ok = d.el.querySelector('[data-ok]')
  ok.addEventListener('click', async () => {
    const err = d.el.querySelector('.err')
    err.textContent = ''
    const host = f('host').value
    const base = f('folder').value
    const sub = f('sub').value.trim().replace(/^\/+|\/+$/g, '')
    const spec = {
      name: f('name').value.trim(),
      role: f('role').value,
      folder: sub ? `${base.replace(/\/+$/, '')}/${sub}` : base,
    }
    if (spec.role === 'worker') {
      // A worker's coordinator is always chosen, never assumed: a session
      // can call itself "coord" without being yours.
      spec.coordinator = f('coordinator').value
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(spec.coordinator)) { err.textContent = T.coordRequired; f('coordinator').focus(); return }
    }
    if (!base) { err.textContent = T.folderRequired; f('folder').focus(); return }
    if (f('compact').value) spec.compact_window = Number(f('compact').value)
    if (f('persona').value) spec.persona = f('persona').value
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(spec.name)) { err.textContent = T.sessionName + ': A-Z a-z 0-9 _ -'; f('name').focus(); return }
    ok.disabled = true
    ok.textContent = T.opening
    try {
      await postJson('/api/terminals/open', { host, spec })
      // (Its squad's title and goal, if given: the session is open either way.)
      const title = f('sqtitle').value.trim(), goal = f('sqgoal').value.trim()
      if (spec.role === 'coordinator' && !preset.reopen && (title || goal)) await postJson('/api/org/squad', { coordinator: spec.name, title, goal }).catch(e => alertBox(e.message))
      d.close()
      location.hash = `#/t/${encodeURIComponent(host)}/${encodeURIComponent(spec.name)}`
    } catch (e) {
      err.textContent = e.message
      ok.disabled = false
      ok.textContent = T.open
    }
  })
}
