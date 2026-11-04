#!/usr/bin/env node
// Prepares a release: the new version everywhere it is written, squadra-host
// signed, the tests run. Commits, tags and pushes nothing: that is left to you,
// and the key stays on this computer. See RELEASE.md.
//
//   node scripts/release.mjs <version> [<private-key-file> [<previous-private-key-file>]]
//   node scripts/release.mjs check [<version or tag>]     # what CI runs for a release

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_KEY = join(homedir(), '.config', 'squadra-release', 'release-key.pem')
const die = text => { process.stderr.write(`${text}\n`); process.exit(1) }

const packageVersion = v => `"version": "${v}"`
const SPOTS = [
  ['package.json', packageVersion],
  ['server/package.json', packageVersion],
  ['plugins/squadra/package.json', packageVersion],
  ['plugins/squadra/.claude-plugin/plugin.json', packageVersion],
  ['.claude-plugin/marketplace.json', packageVersion],
  ['host/squadra-host.mjs', v => `const VERSION = '${v}'`],
  ['.github/ISSUE_TEMPLATE/bug_report.yml', v => `placeholder: v${v} `],
  ['README.md', v => `· v${v}</p>`],
  ['README-es.md', v => `· v${v}</p>`],
  ['docs/reference.md', v => `· v${v}</p>`],
  ['docs/referencia.md', v => `· v${v}</p>`],
]
// What someone updating has to do is written by hand, in both languages.
const UPGRADE_NOTES = [
  ['docs/reference.md', v => `**From ${v}:**`],
  ['docs/referencia.md', v => `**Desde ${v}:**`],
]

const read = file => readFileSync(join(ROOT, file), 'utf8')
const times = (text, what) => text.split(what).length - 1
const currentVersion = () => JSON.parse(read('package.json')).version
const parts = v => v.split('.').map(Number)
const compareVersions = (a, b) => { const [x, y] = [parts(a), parts(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }
const signTool = (...args) => execFileSync(process.execPath, [join(ROOT, 'scripts/release-sign.mjs'), ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
const spotsOff = version => SPOTS.filter(([file, text]) => times(read(file), text(version)) !== 1).map(([file]) => file)

function tagExists(tag) {
  try {
    if (execFileSync('git', ['tag', '-l', tag], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) return true
    return execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim() !== ''
  } catch {
    process.stderr.write(`⚠️  could not ask origin whether ${tag} exists\n`)
    return false
  }
}

function check(wanted) {
  const version = currentVersion()
  const expected = wanted?.replace(/^v/, '')
  if (expected && expected !== version) die(`this is version ${version}, not ${expected}`)
  const off = spotsOff(version)
  if (off.length) die(`these don't say ${version}: ${off.join(', ')}`)
  try { signTool('check') } catch { process.exit(1) }
  process.stdout.write(`Version ${version} is the same everywhere.\n`)
}

function prepare(version, keyFile = DEFAULT_KEY, previousKeyFile) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) die(`"${version}" is not a version like 1.2.3`)
  const current = currentVersion()
  const order = compareVersions(version, current)
  if (order < 0) die(`${version} is older than this version (${current})`)
  if (tagExists(`v${version}`)) die(`v${version} already exists`)
  const off = spotsOff(current)
  if (off.length) die(`these don't say ${current}, so nothing was changed: ${off.join(', ')}`)
  if (order > 0) {
    const missing = UPGRADE_NOTES.filter(([file, text]) => !read(file).includes(text(current)))
    if (missing.length) die(`write what someone updating from ${current} has to do ("${missing[0][1](current)}" in ${missing.map(([file]) => file).join(', ')}), even if it is nothing. Nothing was changed`)
  }
  // First of all, so that a wrong key leaves everything as it was.
  const signArgs = ['sign', keyFile, ...(previousKeyFile ? [previousKeyFile] : [])]
  try { signTool(...signArgs) } catch { process.exit(1) }
  if (order > 0) {
    for (const [file, text] of SPOTS) writeFileSync(join(ROOT, file), read(file).replace(text(current), text(version)))
    signTool(...signArgs)
  }
  check()
  try {
    execFileSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' })
  } catch {
    die(`the tests failed. The files say ${version} already: fix them and run this again with the same version`)
  }
  process.stdout.write(`\nReady, nothing committed. Review it and go on with RELEASE.md:\n  git add host/squadra-host.mjs.sig && git commit -am "Squadra ${version}"\n  git push -u origin HEAD      # and open the pull request to main\nOnce it is merged, on main:\n  node scripts/release.mjs check ${version}\n  git tag -s v${version} -m "Squadra ${version}" && git push origin v${version}\n`)
}

const [first, ...rest] = process.argv.slice(2)
if (first === 'check' && rest.length <= 1) check(rest[0])
else if (first && first !== 'check' && rest.length <= 2) prepare(first, ...rest)
else die('usage: release.mjs <version> [<private-key-file> [<previous-private-key-file>]] | check [<version or tag>]')
