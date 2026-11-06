// A QR code as an SVG (ISO 18004: bytes, error correction level M), so that an
// authenticator app can read a key with its camera. Written here because the
// dashboard loads nothing from outside, and a key must not go to any service.

// Per version: [error codewords per block, [blocks, data codewords in each]...].
const BLOCKS = [
  null,
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]],
  [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
  [30, [1, 50], [4, 51]], [22, [6, 36], [2, 37]],
]
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58]]

// Arithmetic in GF(256).
const EXP = new Uint8Array(512), LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x = x << 1 ^ (x & 0x80 ? 0x11d : 0)
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

function errorCodewords(data, count) {
  let gen = [1]
  for (let i = 0; i < count; i++) {
    const next = new Array(gen.length + 1).fill(0)
    gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]) })
    gen = next
  }
  const rest = [...data, ...new Array(count).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const f = rest[i]
    if (f) for (let j = 0; j < gen.length; j++) rest[i + j] ^= mul(gen[j], f)
  }
  return rest.slice(data.length)
}

// The bytes, with padding, split in blocks with their error codes, interleaved.
function codewords(bytes, version) {
  const [ec, ...groups] = BLOCKS[version]
  const capacity = groups.reduce((n, [blocks, size]) => n + blocks * size, 0)
  let bits = '0100' + bytes.length.toString(2).padStart(version < 10 ? 8 : 16, '0')
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  bits += '0'.repeat(Math.min(4, capacity * 8 - bits.length))
  bits += '0'.repeat((8 - bits.length % 8) % 8)
  const data = bits.match(/.{8}/g).map(x => parseInt(x, 2))
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad)
  const blocks = []
  let at = 0
  for (const [count, size] of groups) for (let i = 0; i < count; i++) { blocks.push(data.slice(at, at + size)); at += size }
  const errors = blocks.map(b => errorCodewords(b, ec))
  const out = []
  for (let i = 0; i < Math.max(...blocks.map(b => b.length)); i++) for (const b of blocks) if (i < b.length) out.push(b[i])
  for (let i = 0; i < ec; i++) for (const e of errors) out.push(e[i])
  return out
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => r * c % 2 + r * c % 3 === 0,
  (r, c) => (r * c % 2 + r * c % 3) % 2 === 0, (r, c) => ((r + c) % 2 + r * c % 3) % 2 === 0,
]

function bch(value, generator, bits) {
  const top = g => 31 - Math.clz32(g)
  let rest = value << bits
  while (rest && top(rest) >= top(generator)) rest ^= generator << (top(rest) - top(generator))
  return value << bits | rest
}

function draw(version, words, mask) {
  const n = version * 4 + 17
  const grid = Array.from({ length: n }, () => new Array(n).fill(null))
  const set = (r, c, on) => { if (r >= 0 && c >= 0 && r < n && c < n) grid[r][c] = on }
  const finder = (r, c) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const ring = i >= 0 && i <= 6 && (j === 0 || j === 6) || j >= 0 && j <= 6 && (i === 0 || i === 6)
        set(r + i, c + j, ring || i >= 2 && i <= 4 && j >= 2 && j <= 4)
      }
    }
  }
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0)
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  // (Everywhere but where the finders are: also over the timing lines.)
  const last = ALIGNMENT[version].at(-1)
  for (const r of ALIGNMENT[version]) {
    for (const c of ALIGNMENT[version]) {
      if (r === 6 && c === 6 || r === 6 && c === last || r === last && c === 6) continue
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1)
    }
  }
  // Level M, and this mask.
  const format = bch(mask, 0x537, 10) ^ 0x5412
  const bit = (v, i) => (v >> i & 1) === 1
  for (let i = 0; i < 15; i++) {
    set(i < 6 ? i : i < 8 ? i + 1 : n - 15 + i, 8, bit(format, i))
    set(8, i < 8 ? n - 1 - i : i === 8 ? 7 : 14 - i, bit(format, i))
  }
  set(n - 8, 8, true)
  if (version >= 7) {
    const info = bch(version, 0x1f25, 12)
    for (let i = 0; i < 18; i++) {
      set(Math.floor(i / 3), n - 11 + i % 3, bit(info, i))
      set(n - 11 + i % 3, Math.floor(i / 3), bit(info, i))
    }
  }
  const stream = words.flatMap(w => Array.from({ length: 8 }, (_, i) => bit(w, 7 - i)))
  let at = 0
  for (let right = n - 1, up = true; right > 0; right -= 2, up = !up) {
    if (right === 6) right--
    for (let k = 0; k < n; k++) {
      const r = up ? n - 1 - k : k
      for (const c of [right, right - 1]) {
        if (grid[r][c] !== null) continue
        grid[r][c] = (stream[at++] ?? false) !== MASKS[mask](r, c)
      }
    }
  }
  return grid
}

// How hard it is to read, by the four rules of the standard: the lowest wins.
function penalty(grid) {
  const n = grid.length
  let score = 0
  const line = get => {
    let run = 1
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) { if (++run === 5) score += 3; else if (run > 5) score++ } else run = 1
    }
    const text = Array.from({ length: n }, (_, i) => (get(i) ? '1' : '0')).join('')
    score += 40 * ((text.match(/(?=10111010000)/g)?.length ?? 0) + (text.match(/(?=00001011101)/g)?.length ?? 0))
  }
  let dark = 0
  for (let i = 0; i < n; i++) { line(j => grid[i][j]); line(j => grid[j][i]) }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c]) dark++
      if (r < n - 1 && c < n - 1 && grid[r][c] === grid[r + 1][c] && grid[r][c] === grid[r][c + 1] && grid[r][c] === grid[r + 1][c + 1]) score += 3
    }
  }
  return score + 10 * Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5)
}

// The code as an SVG, or null if the text doesn't fit (then the key is typed).
export function qrSvg(text, label = 'QR') {
  const bytes = [...new TextEncoder().encode(text)]
  const version = BLOCKS.findIndex((b, v) => v && bytes.length + (v < 10 ? 2 : 3) <= b.slice(1).reduce((s, [count, size]) => s + count * size, 0))
  if (version < 1) return null
  const words = codewords(bytes, version)
  const grid = MASKS.map((_, m) => draw(version, words, m)).reduce((best, g) => (penalty(g) < penalty(best) ? g : best))
  const n = grid.length
  let path = ''
  grid.forEach((row, r) => row.forEach((on, c) => { if (on) path += `M${c + 4} ${r + 4}h1v1h-1z` }))
  return `<svg class="qr" viewBox="0 0 ${n + 8} ${n + 8}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
