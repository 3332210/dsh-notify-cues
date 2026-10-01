/**
 * Minimal in-process test runner.
 *
 * `node --test` is unusable here: the DSH file sandbox forbids named pipes, so
 * the test runner's piped spawn of the child process fails with EPERM. Running
 * everything in this one process avoids spawning anything.
 *
 * Usage: node test/run.mjs
 */
import { readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))

const suites = new Map()
let current = null

globalThis.test = (name, fn) => {
  if (current === null) throw new Error('test() called outside a suite')
  current.push({ name, fn })
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.test.mjs')).sort()

let passed = 0
let failed = 0
const failures = []

for (const file of files) {
  const tests = []
  current = tests
  suites.set(file, tests)
  await import(pathToFileURL(join(dir, file)).href)
  current = null
  for (const t of tests) {
    try {
      await t.fn()
      passed++
      process.stdout.write(`  \u2713 ${file} \u203a ${t.name}\n`)
    } catch (error) {
      failed++
      failures.push({ file, name: t.name, error })
      process.stdout.write(`  \u2717 ${file} \u203a ${t.name}\n`)
    }
  }
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
for (const f of failures) {
  process.stdout.write(`\n--- ${f.file} \u203a ${f.name}\n${f.error?.stack ?? f.error}\n`)
}
process.exit(failed === 0 ? 0 : 1)
