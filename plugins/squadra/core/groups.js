// Approvals from the terminal, and the groups this session is in.

import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { agent } from './agent.js'
import { log, NAME_RE } from './settings.js'
import { active } from './session.js'
import { loadAccess, peerMatchesPin } from './access.js'
import { call } from './client.js'

// The /squadra:access skill drops a file at approved/<senderId> when it pairs
// someone. Poll for it, send confirmation, clean up.
export function checkApprovals(s) {
  if (!active(s)) return
  let files
  // (A link to another folder isn't this one: what it holds is not ours to remove.)
  try {
    if (!lstatSync(s.approvedDir).isDirectory()) return
    files = readdirSync(s.approvedDir)
  } catch { return }
  // (Removed whatever it is — a folder too — so it isn't sent again every
  // poll; and confirmed only to a name really paired.)
  const drop = file => { try { rmSync(file, { recursive: true, force: true }) } catch (err) { log(`cannot remove ${file}: ${err.message}`) } }
  const allowed = loadAccess(s).allowFrom
  for (const senderId of files) {
    const file = join(s.approvedDir, senderId)
    drop(file)
    if (!NAME_RE.test(senderId) || !allowed.includes(senderId)) continue
    void call('sendMessage', { chat_id: senderId, text: `Paired with "${s.name}". You can now message each other.`, squadra_fyi: true }, { s })
      .catch(err => log(`failed to send approval confirm: ${err.message}`))
  }
}

// Groups in access.json are joined on the server, so /squadra:access only edits
// a local file (like the Telegram skill) and membership follows.
// Groups on the server are private: the first member creates the group, and
// others join only once a member has invited them. A session invites the
// names in the group's `invite` and `allowFrom` lists (access.json).
export function syncGroups(s) {
  if (!active(s)) return
  const access = loadAccess(s)
  s.groupInvites ??= new Set()
  s.groupErrors ??= new Map()
  // Failed invites and joins wait longer each time (5 s up to 1 min), so a
  // list naming someone who isn't there doesn't spend the sending budget.
  s.groupRetry ??= new Map()
  const waiting = key => (s.groupRetry.get(key)?.at ?? 0) > Date.now()
  const failed = key => { const d = Math.min((s.groupRetry.get(key)?.delay ?? 2_500) * 2, 60_000); s.groupRetry.set(key, { at: Date.now() + d, delay: d }) }
  // (Invited again now and then: an invitation lasts 7 days on the server.)
  if (Date.now() - (s.groupInvitesAt ?? 0) > 6 * 3600_000) { s.groupInvites.clear(); s.groupInvitesAt = Date.now() }
  const inviteAll = g => {
    const cfg = access.groups[g] ?? {}
    for (const who of new Set([...(cfg.invite ?? []), ...(cfg.allowFrom ?? [])])) {
      const key = `${g}\0${who}`
      if (who === s.name || s.groupInvites.has(key) || waiting(key)) continue
      s.groupInvites.add(key)
      // (Not a name registered again by someone else.)
      void peerMatchesPin(s, who).then(ok => {
        if (!ok) { log(`not inviting "${who}" to ${g}: it is not the session this one paired with`); return }
        return call('inviteToGroup', { chat_id: g, name: who }, { s }).then(() => s.groupRetry.delete(key))
      }).catch(err => { s.groupInvites.delete(key); failed(key); log(`failed to invite ${who} to ${g}: ${err.message}`) })
    }
  }
  for (const g of Object.keys(access.groups)) {
    if (s.joinedGroups.has(g)) { inviteAll(g); continue }
    if (waiting(g)) continue
    void call('joinGroup', { chat_id: g }, { s }).then(
      r => {
        s.joinedGroups.add(g); s.groupErrors.delete(g); s.groupRetry.delete(g); inviteAll(g)
        s.groupInfo ??= new Map()
        s.groupInfo.set(g, r && typeof r === 'object' ? r : null)
        // Joined a group someone else had set up: say who is in it, so a group
        // created in advance by an eavesdropper doesn't go unnoticed.
        if (r && r.created === false && active(s)) {
          const members = Array.isArray(r.members) ? r.members.filter(n => NAME_RE.test(String(n))) : []
          agent.deliver({
            content: `Squadra: this session joined ${g}, created by "${NAME_RE.test(String(r.owner)) ? r.owner : 'unknown'}". Members: ${members.join(', ') || '(none)'}. Tell the user if anyone there is unexpected.`,
            meta: { kind: 'squadra_notice', user: 'squadra' },
          })
        }
      },
      err => {
        // Not invited yet: retried quietly, less and less often.
        if (s.groupErrors.get(g) !== err.message) log(`cannot join group ${g} yet: ${err.message}`)
        s.groupErrors.set(g, err.message)
        failed(g)
      },
    )
  }
  for (const g of [...s.joinedGroups]) {
    if (Object.hasOwn(access.groups, g)) continue
    s.joinedGroups.delete(g)
    void call('leaveChat', { chat_id: g }, { s }).catch(err => log(`failed to leave group ${g}: ${err.message}`))
  }
}
