import { now, cleanText } from './platform/index.js'

export function upgradeStoredData(platform, { observation, messaging, machines }) {
  const { db, inTx } = platform
  const { cleanEvent } = observation
  const { uploadMime } = messaging
  const { ownTerminals, sanitizeHostInfo } = machines

  // Data stored by a version before 0.0.2 was cleaned with older rules (or
  // none): cleaned again once, here, in batches, resuming where it stopped if
  // the server is stopped meanwhile, and saying how far it got.
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
  const metaGet = k => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v
  const metaSet = (k, v) => db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, String(v))
  function recleanOnce(key, table, select, fix) {
    if (metaGet(`${key}_done`)) return
    // (The row id under its own name: in a table whose primary key is an
    // INTEGER, "rowid" would come back named after that key instead.)
    const page = db.prepare(`SELECT rowid AS rid_, ${select} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 1000`)
    const saved = Number(metaGet(`${key}_last`))
    let last = Number.isSafeInteger(saved) && saved > 0 ? saved : 0, done = 0
    for (;;) {
      const rows = page.all(last)
      if (!rows.length) break
      inTx(() => { for (const r of rows) fix(r); last = rows[rows.length - 1].rid_; metaSet(`${key}_last`, last) })
      done += rows.length
      if (done % 50_000 < 1000) process.stderr.write(`squadra-server: cleaning ${table} stored by an older version: ${done} done…\n`)
    }
    metaSet(`${key}_done`, now())
  }
  {
    const upd = db.prepare('UPDATE events SET data = ?, ts = ? WHERE id = ?')
    recleanOnce('events_cleaned_v2', 'events', 'id, kind, ts, data', r => {
      let data
      try { data = JSON.stringify(cleanEvent(r.kind, JSON.parse(r.data))) } catch { data = '{}' }
      // (Whole milliseconds: the history cursor relies on it.)
      const ts = Math.round(Number(r.ts) || 0)
      if (data !== r.data || ts !== r.ts) upd.run(data, ts, r.id)
    })
  }
  {
    const upd = db.prepare('UPDATE messages SET text = ? WHERE id = ?')
    recleanOnce('messages_cleaned_v2', 'messages', 'id, text', r => {
      if (typeof r.text === 'string') { const t = cleanText(r.text); if (t !== r.text) upd.run(t, r.id) }
    })
    const updFile = db.prepare('UPDATE files SET name = ?, mime = ? WHERE file_id = ?')
    recleanOnce('files_cleaned_v2', 'files', 'file_id, name, mime', r => {
      const name = typeof r.name === 'string' ? cleanText(r.name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file' : r.name
      const mime = uploadMime(r.mime)
      if (name !== r.name || mime !== r.mime) updFile.run(name, mime, r.file_id)
    })
    const updReaction = db.prepare('UPDATE reactions SET emoji = ? WHERE rowid = ?')
    recleanOnce('reactions_cleaned_v2', 'reactions', 'emoji', r => {
      if (typeof r.emoji === 'string') { const e = cleanText(r.emoji.slice(0, 64)).slice(0, 16); if (e !== r.emoji) updReaction.run(e, r.rid_) }
    })
    const updHost = db.prepare('UPDATE hosts SET info = ? WHERE id = ?')
    recleanOnce('hosts_cleaned_v2', 'hosts', 'id, info', r => {
      let info = null
      try { info = JSON.stringify(ownTerminals(sanitizeHostInfo(JSON.parse(r.info ?? 'null')), r.id)) } catch {}
      if (info !== r.info) updHost.run(info, r.id)
    })
    // Updates queued before senders were recorded: whose they are, from the
    // message they carry (so a delete or a kick removes them too).
    if (!metaGet('updates_sender_v2')) {
      db.exec(`UPDATE updates SET sender = COALESCE(json_extract(payload, '$.message.from.id'), json_extract(payload, '$.edited_message.from.id'), json_extract(payload, '$.message_reaction.user.id')) WHERE sender IS NULL`)
      metaSet('updates_sender_v2', now())
    }
  }
}
