import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Builds the release archive: build/<id>-<version>.zip, holding <id>/ with the plugin's files and
// the packages it runs with. Tests, tooling, and dev dependencies stay out.

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const id = pkg.name
const build = path.join(root, 'build')
const out = path.join(build, id)
const LEFT_OUT = new Set(['node_modules', 'build', 'scripts', 'tsconfig.json', 'CLAUDE.md'])

fs.rmSync(build, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
// Entry by entry: build/ is inside the folder being copied.
for (const name of fs.readdirSync(root)) {
  if (LEFT_OUT.has(name) || name.startsWith('.') || name.endsWith('.test.ts')) continue
  fs.cpSync(path.join(root, name), path.join(out, name), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts'),
  })
}
if (Object.keys(pkg.dependencies ?? {}).length > 0) {
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit' })
}
const zip = `${id}-${pkg.version}.zip`
execFileSync('zip', ['-qr', zip, id], { cwd: build, stdio: 'inherit' })
console.log(path.join('build', zip))
