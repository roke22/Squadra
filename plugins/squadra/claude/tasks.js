// A worker's tasks, seen through the hooks.
//
// Each message from a worker's coordinator is a task (unless it says fyi), and
// every task ends with a final report to it: reply with report done, blocked,
// failed or question. That it started needs no message: when the task starts
// a turn, the plugin puts 👀 on it (a reaction wakes nobody). That it ends is
// not left to Claude: the Stop hook keeps the turn from ending without the
// report, once; if it still ends without one, the coordinator is told.
// Only tasks Claude has seen count: one that arrives after the turn's last
// step waits for the next turn, and asking for its report now would only get
// the previous report again.

import { log, S, call } from '../core/index.js'

export const pendingTasks = s => [...s.tasks].filter(([, t]) => t.started).map(([id]) => id)

export const channelIds = prompt => [...String(prompt).matchAll(/<channel\b([^>]*)>/g)].map(m => Number(/\bmessage_id="(\d+)"/.exec(m[1])?.[1]))

// A prompt about to be sent (UserPromptSubmit), or the transcript showing a
// message reached Claude in a turn already going: the tasks it brings start now.
export function tasksStarting(s, ids) {
  if (s.role !== 'worker' || !s.tasks.size) return
  for (const id of ids) {
    const t = s.tasks.get(id)
    // (Only a task this plugin delivered: a tag typed in a prompt counts for nothing.)
    if (!t || t.started) continue
    t.started = true
    void call('setMessageReaction', { chat_id: s.coordinator, message_id: id, reaction: [{ type: 'emoji', emoji: '👀' }] }, { s }).catch(() => {})
  }
}

// A final report (replyTo: the message it answers, if any) closes the tasks it
// covers: all those Claude has seen or, when it answers a message, those up to
// that one. A later task stays open: Claude may have left it undone
// (Claude Code tells it to treat a message that arrives during a turn as
// information only), and its coordinator is waiting for it. Returns what is
// left, for the answer to tell Claude.
export function closeTasks(s, replyTo) {
  for (const id of pendingTasks(s)) if (replyTo == null || id <= replyTo) s.tasks.delete(id)
  s.stopAsked = false
  return pendingTasks(s)
}

// The turn is about to end (Stop hook): a reason to go on, or '' to let it.
// (It can't go on forever: it asks again only after a report or a new task.)
// background: something this turn started still runs, and the turn that follows
// it comes when it ends. The work isn't over: nothing to ask for yet.
export async function stopCheck(s, { background = false } = {}) {
  if (S !== s || s.role !== 'worker' || background) return ''
  const ids = pendingTasks(s)
  if (!ids.length) return ''
  const list = ids.map(i => `#${i}`).join(', ')
  if (!s.stopAsked) {
    s.stopAsked = true
    return `[Squadra] Before you finish: your coordinator "${s.coordinator}" is waiting for your final report on its task ${list}. Send it now with reply (chat_id "${s.coordinator}", report: done, blocked, failed or question): what you did or what stopped you, and only the decisions that matter, in up to 3 lines. It is required: nobody can waive it, not even your coordinator.`
  }
  // Asked once already: the turn ends, and the coordinator is told.
  for (const id of ids) s.tasks.delete(id)
  s.stopAsked = false
  await call('sendMessage', {
    chat_id: s.coordinator,
    text: `⚠️ (automatic) ${s.name} ended its turn without a final report on your task ${list}. Ask it how it went, or look at its terminal.`,
    squadra_auto: true,
  }, { s }).catch(err => log(`missing-report notice failed: ${err.message}`))
  return ''
}
