import { now } from './basics.js'

export function createStream() {
  const sseClients = new Set()

  function broadcast(type, data) {
    if (sseClients.size === 0) return
    const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
      if (res.writableEnded) { sseClients.delete(res); continue }
      // A dashboard that stopped reading: drop it (it reconnects and reloads).
      if (res.writableLength > 8 * 1024 * 1024) { sseClients.delete(res); res.destroy(); continue }
      res.write(chunk)
    }
  }
  setInterval(() => broadcast('ping', { t: now() }), 20_000).unref()

  return { sseClients, broadcast }
}
