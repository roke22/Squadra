// How the programs are divided into modules, checked on their imports (see
// CONTRIBUTING.md): a module enters another only through its index.js, along
// the arrows below, and no program reaches into another.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// What each module of the server may use. Whatever is not listed is refused,
// so a new module has to say where it fits.
const SERVER_MODULES = {
  platform: [],
  sessions: ['platform'],
  messaging: ['platform', 'sessions'],
  observation: ['platform', 'sessions'],
  machines: ['platform', 'sessions', 'messaging', 'observation'],
  organization: ['platform', 'sessions', 'machines'],
  dashboard: ['platform', 'sessions', 'messaging', 'observation', 'machines', 'organization'],
  ui: [],
}
const SERVER_OTHER_FOLDERS = ['vendor']
const PLUGIN_MODULES = { core: [], claude: ['core'] }

// The folder a program's files live in, and the modules in it. The plugin's
// are one way only: what is Claude's stays out of what any agent could reuse.
const PROGRAMS = [
  { dir: 'server', modules: SERVER_MODULES, otherFolders: SERVER_OTHER_FOLDERS },
  { dir: 'plugins/squadra', modules: PLUGIN_MODULES, otherFolders: ['hooks', 'skills', '.claude-plugin'] },
]

// Static imports and re-exports, and import() of a literal. A dynamic import
// of anything else can't be checked, so it is refused.
function importsOf(source) {
  const found = []
  for (const m of source.matchAll(/^\s*(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*(['"]([^'"]+)['"]|[^)]*)\s*\)/gm)) {
    if (m[3] !== undefined && m[4] === undefined) found.push({ dynamic: m[3].trim() })
    else found.push({ path: m[1] ?? m[2] ?? m[4] })
  }
  return found
}

// files: { 'server/x/y.js': source }. Every rule broken, as text.
function violations(files, programs = PROGRAMS) {
  const out = []
  const programOf = p => programs.find(g => p === g.dir || p.startsWith(`${g.dir}/`))
  const moduleOf = (g, p) => {
    const rest = p.slice(g.dir.length + 1).split('/')
    return rest.length > 1 ? rest[0] : null
  }
  for (const [file, source] of Object.entries(files)) {
    const program = programOf(file)
    if (!program) continue
    const from = moduleOf(program, file)
    if (from && !Object.hasOwn(program.modules, from) && !program.otherFolders.includes(from)) {
      out.push(`${file}: "${program.dir}/${from}" is not a known module: add it, with what it may use, to test/modules.test.mjs`)
    }
    for (const imp of importsOf(source)) {
      if (imp.dynamic !== undefined) { out.push(`${file}: import(${imp.dynamic}) can't be checked: import a literal path`); continue }
      if (!imp.path.startsWith('.')) continue // node: built-ins
      const target = normalize(join(dirname(file), imp.path)).split(sep).join('/')
      const other = programOf(target)
      if (other !== program) { out.push(`${file}: imports ${imp.path}, outside ${program.dir}`); continue }
      const to = moduleOf(program, target)
      if (to === from || !to) {
        // Inside its module, or a file at the top of the program. Those are
        // the entry points and what is older than the modules: a module
        // doesn't reach back to them.
        if (from && !to) out.push(`${file}: a module doesn't import the top of its program (${imp.path})`)
        continue
      }
      if (from && !(program.modules[from] ?? []).includes(to)) out.push(`${file}: module "${from}" may not use "${to}"`)
      if (target !== `${program.dir}/${to}/index.js`) out.push(`${file}: enters "${to}" through ${imp.path}, not its index.js`)
    }
  }
  return out
}

function sourcesIn(dir) {
  const files = {}
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !/\.m?js$/.test(e.name)) continue
    const rel = relative(ROOT, join(e.parentPath, e.name)).split(sep).join('/')
    if (rel.startsWith('server/vendor/') || rel.includes('/node_modules/')) continue
    files[rel] = readFileSync(join(ROOT, rel), 'utf8')
  }
  return files
}

test('modules: the programs follow the rules', () => {
  assert.deepEqual(violations({ ...sourcesIn('server'), ...sourcesIn('plugins/squadra') }), [])
})

test('modules: a module uses another through its index.js', () => {
  const ok = { 'server/messaging/send.js': `import { x } from '../sessions/index.js'` }
  assert.deepEqual(violations(ok), [])
  const inside = { 'server/messaging/send.js': `import { x } from '../sessions/leases.js'` }
  assert.match(violations(inside).join(), /through \.\.\/sessions\/leases\.js, not its index\.js/)
})

test('modules: only along the arrows, and never in a circle', () => {
  const back = { 'server/sessions/x.js': `export { y } from '../messaging/index.js'` }
  assert.match(violations(back).join(), /"sessions" may not use "messaging"/)
  for (const [name, uses] of Object.entries(SERVER_MODULES)) {
    for (const u of uses) assert.ok(!SERVER_MODULES[u].includes(name), `${name} and ${u} use each other`)
  }
  const claude = { 'plugins/squadra/core/x.js': `import('../claude/index.js')` }
  assert.match(violations(claude).join(), /"core" may not use "claude"/)
})

test('modules: nothing unknown, nothing that can not be checked, no reaching out', () => {
  assert.match(violations({ 'server/stuff/x.js': '' }).join(), /not a known module/)
  assert.match(violations({ 'server/messaging/x.js': 'const m = await import(name)' }).join(), /can't be checked/)
  assert.match(violations({ 'server/messaging/x.js': `import '../../plugins/squadra/signing.js'` }).join(), /outside server/)
  assert.match(violations({ 'server/messaging/x.js': `import '../server.js'` }).join(), /doesn't import the top/)
  // The entry point joins the modules; inside one, anything goes.
  assert.deepEqual(violations({
    'server/server.js': `import { a } from './machines/index.js'\nimport { b } from './acme.js'`,
    'server/machines/link.js': `import { c } from './tickets.js'\nimport { createHash } from 'node:crypto'`,
  }), [])
})
