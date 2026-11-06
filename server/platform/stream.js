import { now } from './basics.js'

export function createStream(every) {
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
  every(20_000, () => broadcast('ping', { t: now() }))

  return { sseClients, broadcast }
}
