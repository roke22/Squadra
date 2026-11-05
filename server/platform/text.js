// One line of text written in the dashboard (a title, a goal, a
// description): clean, at most n characters.
export const oneLine = (v, n) => (typeof v === 'string' ? cleanText(v.slice(0, n * 2)).replace(/\s+/g, ' ').trim().slice(0, n) : '')

// Control characters (except newline and tab), bidi overrides and blank
// fillers: invisible
// in the dashboard, but they survive copy and paste into a terminal.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u115f\u1160\u17b4\u17b5\u2065\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}\p{Cf}]/gu

// Some of them are part of real text, and are kept where they are: a joiner
// (ZWJ/ZWNJ) between two non-ASCII letters or emoji (👩‍💻, Persian, Sinhala);
// one variation selector right after the character it varies (葛󠄀, Mongolian);
// the tags of a subdivision flag (🏴 England); the format marks that start
// Arabic, Syriac or Kaithi numbers or join hieroglyphs and shorthand.
const isBase = c => c > 0x7f && /[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3]/u.test(String.fromCodePoint(c))

// (Only the subdivision flags emoji actually has: England, Scotland, Wales.)
const FLAG_TAGS = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu

// Each mark only before a character of its own kind (an invisible one
// can't sit before an ASCII letter).
const KEPT_MARKS = [
  [/^[\u0600-\u0605\u06dd\u0890\u0891\u08e2]$/u, /^\p{Nd}$/u],     // Arabic number signs (they are drawn)
  [/^[\u{110bd}\u{110cd}]$/u, /^(?![0-9])\p{Nd}$/u],                      // Kaithi number signs
  [/^\u070f$/u, /^\p{Script=Syriac}$/u],
  [/^[\u{13430}-\u{1343f}]$/u, /^\p{Script=Egyptian_Hieroglyphs}$/u],
  [/^[\u{1bca0}-\u{1bca3}]$/u, /^\p{Script=Duployan}$/u],
]
function keptInContext(ch, at, text) {
  const c = ch.codePointAt(0)
  const before = at > 0 ? text.codePointAt(at - 1 - (at > 1 && /[\udc00-\udfff]/.test(text[at - 1]) ? 1 : 0)) : null
  const after = text.codePointAt(at + ch.length) ?? null
  if (c === 0x200c || c === 0x200d) return before !== null && after !== null && isBase(before) && isBase(after)
  const vs = x => (x >= 0xfe00 && x <= 0xfe0f) || (x >= 0xe0100 && x <= 0xe01ef) || (x >= 0x180b && x <= 0x180d) || x === 0x180f
  // (A keycap: 1️⃣ is "1", U+FE0F, U+20E3.)
  if (c === 0xfe0f && before !== null && /^[0-9#*]$/.test(String.fromCodePoint(before)) && after === 0x20e3) return true
  if (vs(c)) return before !== null && isBase(before) && !vs(before)
  const mark = KEPT_MARKS.find(([m]) => m.test(ch))
  if (mark) return after !== null && mark[1].test(String.fromCodePoint(after))
  return false
}

// Two passes: first what is never kept goes, then the rest is judged by
// its neighbours as they are now (a filler can't make a joiner look kept).
const MAYBE_KEPT = /^[\u200c\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u180b-\u180d\u180f\u{e0020}-\u{e007f}\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}]$/u

// Then again until nothing changes (what one pass drops can leave another
// character without the neighbour it was kept for); after a few passes,
// whatever is left of them goes, except subdivision flags.
function contextPass(text, keep) {
  // (The tags of the subdivision flags are text. Matches come in order: one
  // pointer over the flags, so it stays linear.)
  const flags = [...text.matchAll(FLAG_TAGS)].map(m => [m.index, m.index + m[0].length])
  let f = 0
  return text.replace(UNSAFE_CHARS, (ch, at, all) => {
    while (f < flags.length && flags[f][1] <= at) f++
    const inFlag = f < flags.length && at >= flags[f][0]
    return inFlag || (keep && keptInContext(ch, at, all)) ? ch : ''
  })
}

// Cut clean text to n characters without leaving anything dangling at the
// cut: half a surrogate pair, or a joiner or selector with nothing after it.
export function cutText(t, n) {
  let s = t.length > n ? t.slice(0, n) : t
  for (let i = 0; i < 4 && /(?:[\u200c\u200d\ufe00-\ufe0f\ud800-\udbff]|\udb40[\udd00-\uddef])$/.test(s); i++) s = s.replace(/(?:[\u200c\u200d\ufe00-\ufe0f\ud800-\udbff]|\udb40[\udd00-\uddef])$/, '')
  return s
}
export const cleanText = t => {
  if (typeof t !== 'string') return t
  let maybe = 0
  let out = t.replace(UNSAFE_CHARS, ch => (MAYBE_KEPT.test(ch) ? (maybe++, ch) : ''))
  // Judging each one by its neighbours costs more than the rest of the text:
  // a text with hundreds of them (no real one has) loses them all, except
  // subdivision flags.
  if (maybe > 256) return contextPass(out, false)
  for (let i = 0; i < 4; i++) {
    const next = contextPass(out, true)
    if (next === out) return out
    out = next
  }
  return contextPass(out, false)
}
