/**
 * Minimal WebSocket server side (RFC 6455) for squadra-server: text frames,
 * ping/pong and close, with fragmented messages reassembled. Only Node
 * built-ins — no dependencies.
 *
 *   server.on('upgrade', (req, socket, head) => {
 *     const ws = acceptWebSocket(req, socket, head)
 *     if (!ws) return
 *     ws.onmessage = text => …
 *     ws.onclose = () => …
 *     ws.send('hello')
 *   })
 */

import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 2 * 1024 * 1024 // per message, after reassembly

export function acceptWebSocket(req, socket, head, { maxMessage = MAX_MESSAGE, protocol = null, log = m => process.stderr.write(`${m}\n`) } = {}) {
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    setTimeout(() => socket.destroy(), 1000).unref() // (never left half open)
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` + (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') + '\r\n')
  socket.setNoDelay(true)
  socket.setTimeout(0)

  // Incoming bytes as a list of chunks: joined only once a whole frame is
  // there, so a frame trickled in tiny pieces costs no repeated copying.
  const chunks = head?.length ? [Buffer.from(head)] : []
  let buffered = chunks.reduce((n, c) => n + c.length, 0)
  let fragments = []
  let fragmentsSize = 0
  let fragmentOpcode = 0
  let closed = false

  const ws = {
    onmessage: () => {},
    onclose: () => {},
    // Largest message accepted; the server raises it once a client has authenticated.
    maxMessage,
    get open() { return !closed },
    send(text) {
      if (closed) return false
      // A peer that doesn't read can't make the server hold its output:
      // past 16 MB waiting, the connection goes.
      if (socket.writableLength > 16 * 1024 * 1024) { ws.close(4008, 'not reading'); return false }
      socket.write(frame(0x1, Buffer.from(String(text), 'utf8')))
      return true
    },
    close(code = 1000, reason = '') {
      if (closed) return
      const r = Buffer.from(String(reason).slice(0, 120), 'utf8')
      const body = Buffer.alloc(2 + r.length)
      body.writeUInt16BE(code, 0)
      r.copy(body, 2)
      try { socket.write(frame(0x8, body)) } catch {}
      finish()
      setTimeout(() => socket.destroy(), 1000).unref()
      socket.end()
    },
    // Bytes waiting to be written: used to drop output for slow viewers.
    get buffered() { return socket.writableLength },
  }

  function finish() {
    if (closed) return
    closed = true
    chunks.length = 0; buffered = 0; fragments = []
    try { ws.onclose() } catch {}
  }

  function fail(code, reason) { ws.close(code, reason) }

  socket.on('data', chunk => {
    if (closed) return
    try { ws.onactivity?.() } catch {} // (any bytes: a big message still arriving is a sign of life)
    chunks.push(chunk)
    buffered += chunk.length
    parse()
  })
  socket.on('close', finish)
  socket.on('error', finish)
  // The peer closed its side without a close frame (it crashed): closed here
  // too, at once (the socket would otherwise stay half open).
  socket.on('end', () => ws.close(1001, 'connection ended'))
  if (buffered) setImmediate(parse)

  // The first n buffered bytes (joining chunks only as far as needed).
  function peek(n) {
    if (chunks[0].length < n) {
      const joined = Buffer.concat(chunks)
      chunks.length = 0
      chunks.push(joined)
    }
    return chunks[0]
  }
  function take(n) {
    const first = peek(n)
    const out = first.subarray(0, n)
    if (first.length === n) chunks.shift(); else chunks[0] = first.subarray(n)
    buffered -= n
    return out
  }

  function parse() {
    while (!closed && buffered >= 2) {
      const h = peek(Math.min(buffered, 14))
      const b0 = h[0], b1 = h[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (buffered < 4) return
        len = h.readUInt16BE(2); off = 4
      } else if (len === 127) {
        if (buffered < 10) return
        const big = h.readBigUInt64BE(2)
        if (big > BigInt(ws.maxMessage)) return fail(1009, 'message too big')
        len = Number(big); off = 10
      }
      if (!masked) return fail(1002, 'client frames must be masked')
      // Control frames: at most 125 bytes and never fragmented (RFC 6455 5.5).
      if (opcode >= 0x8 && (len > 125 || !fin)) return fail(1002, 'invalid control frame')
      if (len > ws.maxMessage) return fail(1009, 'message too big')
      if (buffered < off + 4 + len) return
      const raw = take(off + 4 + len)
      const mask = raw.subarray(off, off + 4)
      const payload = Buffer.from(raw.subarray(off + 4))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]

      if (opcode === 0x8) { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        ws.close(code === 1005 || code === 1006 ? 1000 : code)
        return
      }
      if (opcode === 0x9) { // ping → pong, unless the client isn't reading what we send
        if (socket.writableLength > 64 * 1024) return fail(1008, 'not reading')
        socket.write(frame(0xA, payload))
        continue
      }
      if (opcode === 0xA) continue                                       // pong
      if (opcode === 0x1 || opcode === 0x2) {
        if (fragments.length) return fail(1002, 'expected a continuation frame')
        fragmentOpcode = opcode
      } else if (opcode !== 0x0) {
        return fail(1002, 'unknown opcode')
      } else if (!fragments.length) {
        return fail(1002, 'unexpected continuation frame')
      }
      fragments.push(payload)
      fragmentsSize += payload.length
      // Empty fragments cost memory too: a message has at most 1024 pieces.
      if (fragmentsSize > ws.maxMessage || fragments.length > 1024) return fail(1009, 'message too big')
      if (!fin) continue
      const data = Buffer.concat(fragments)
      fragments = []; fragmentsSize = 0
      if (fragmentOpcode === 0x1) {
        // (A handler error goes to the caller's log, which limits how often it writes.)
        try { ws.onmessage(data.toString('utf8')) } catch (err) { log(`websocket handler: ${err?.stack ?? err}`) }
      }
    }
  }

  return ws
}

function frame(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}
