/**
 * Unit tests for the dsh-notify-cues decision logic.
 *
 * Run: node test/run.mjs   (see test/run.mjs for why not `node --test`)
 *
 * The point of these tests is the bug this plugin exists to fix: DSH's own
 * plugins decide "done" from `agent/status: idle`, which is true for a
 * completed turn AND for a turn the user just cancelled. The scene mapping
 * below is what keeps those apart.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Point config I/O at a throwaway home BEFORE importing the module, so tests
// never touch the real ~/.dsh/dsh-notify-cues.json. The paths are computed per
// call, so setting the variable here is enough.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-notify-cues-test-'))
process.env.DSH_HOME = TEST_HOME
// Pin the notification language. Otherwise the copy is derived from the host
// locale: this suite passed on a zh-CN machine and failed on an en-US CI runner,
// because one assertion matched Chinese toast text.
process.env.DSH_NOTIFY_CUES_LANG = 'zh'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
void pathToFileURL
const {
  sceneForTurnEnd, decideNotify, mergeConfig, buildNotifyArgs,
  DEFAULT_CONFIG, SCENES, configPath, loadConfig, saveConfig,
  formatElapsed, systemLang, titleBodyFor, apply, __resetForTests, __setForegroundForTests,
} = mod

process.on('exit', () => { rmSync(TEST_HOME, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// The core mapping: why did the turn end?
// ---------------------------------------------------------------------------

test('completed turn maps to the completed scene', () => {
  assert.equal(sceneForTurnEnd({ turn: 1, reason: { kind: 'completed' } }), 'completed')
})

test('a user cancellation maps to interrupted, NOT completed', () => {
  // This is the exact case the reference plugin gets wrong: it reports
  // "task complete" when the user presses stop.
  const payload = { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } }
  assert.equal(sceneForTurnEnd(payload), 'interrupted')
})

test('a hook cancellation maps to blocked', () => {
  const payload = { turn: 2, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } } }
  assert.equal(sceneForTurnEnd(payload), 'blocked')
})

test('parent and disposed cancellations stay silent', () => {
  // A delegating agent cancelling its child, or session teardown, is lifecycle
  // noise. The user did not act and there is nothing to report.
  assert.equal(sceneForTurnEnd({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } }), undefined)
  assert.equal(sceneForTurnEnd({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }), undefined)
})

test('the whole five-member abort union is handled', () => {
  // TurnEndCancelCause = AgentCancelCause | { kind: 'legacy' }, and
  // AgentCancelCause = user | parent | hook | disposed.
  const mapping = {
    user: 'interrupted',
    hook: 'blocked',
    legacy: 'interrupted',
    parent: undefined,
    disposed: undefined,
  }
  for (const [cause, expected] of Object.entries(mapping)) {
    assert.equal(
      sceneForTurnEnd({ turn: 1, reason: { kind: 'aborted', reason: { kind: cause } } }),
      expected,
      `abort cause "${cause}" must map to ${String(expected)}`,
    )
  }
})

test('a hook cancellation keeps its nested reason without breaking mapping', () => {
  // AgentCancelCause's hook variant carries `reason: string`.
  assert.equal(
    sceneForTurnEnd({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'denied by policy' } } }),
    'blocked',
  )
})

test('a merge-extended unknown kind stays silent rather than guessing', () => {
  // TurnEndReasonMap is documented as extensible by other packages.
  assert.equal(sceneForTurnEnd({ turn: 1, reason: { kind: 'budget-exhausted' } }), undefined)
  assert.equal(sceneForTurnEnd({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'something-new' } } }), undefined)
})

test('error, max-tokens, blocked and interrupted variants all map', () => {
  assert.equal(sceneForTurnEnd({ reason: { kind: 'error', error: { message: 'boom' } } }), 'error')
  assert.equal(sceneForTurnEnd({ reason: { kind: 'max-tokens' } }), 'max-tokens')
  assert.equal(sceneForTurnEnd({ reason: { kind: 'blocked' } }), 'blocked')
  assert.equal(sceneForTurnEnd({ reason: { kind: 'interrupted' } }), 'interrupted')
})

test('forked and unknown reasons stay silent', () => {
  assert.equal(sceneForTurnEnd({ reason: { kind: 'forked' } }), undefined)
  assert.equal(sceneForTurnEnd({ reason: { kind: 'something-new' } }), undefined)
})

test('malformed payloads never throw', () => {
  assert.equal(sceneForTurnEnd(undefined), undefined)
  assert.equal(sceneForTurnEnd({}), undefined)
  assert.equal(sceneForTurnEnd({ reason: null }), undefined)
  assert.equal(sceneForTurnEnd({ reason: 'nope' }), undefined)
  assert.equal(sceneForTurnEnd({ reason: { kind: 'aborted' } }), undefined)
  assert.equal(sceneForTurnEnd({ reason: { kind: 'aborted', reason: null } }), undefined)
})

test('every scene the mapper can return is a configured scene', () => {
  const produced = [
    sceneForTurnEnd({ reason: { kind: 'completed' } }),
    sceneForTurnEnd({ reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    sceneForTurnEnd({ reason: { kind: 'error' } }),
    sceneForTurnEnd({ reason: { kind: 'max-tokens' } }),
    sceneForTurnEnd({ reason: { kind: 'blocked' } }),
  ]
  for (const scene of produced) assert.ok(SCENES.includes(scene), `${scene} must be configured`)
  assert.equal(produced.length, new Set(produced).size, 'the five turn-end scenes must be distinct')
})

// ---------------------------------------------------------------------------
// The notification gate
// ---------------------------------------------------------------------------

const quiet = () => mergeConfig(DEFAULT_CONFIG, {})

test('master switch off silences everything', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { notifications: false })
  for (const scene of SCENES) {
    assert.equal(decideNotify(cfg, scene).action, 'skip')
  }
})

test('a per-scene switch silences only that scene', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { per: { interrupted: { enabled: false } } })
  assert.equal(decideNotify(cfg, 'interrupted').action, 'skip')
  assert.equal(decideNotify(cfg, 'completed').action, 'notify')
})

test('watching the finishing session quiets completion-class scenes', () => {
  const cfg = quiet()
  for (const scene of ['completed', 'interrupted', 'error', 'max-tokens', 'blocked']) {
    const decision = decideNotify(cfg, scene, { watching: true, viewedSessionId: 'sess-1', sessionId: 'sess-1' })
    assert.deepEqual(decision, { action: 'skip', reason: 'foreground' })
  }
})

test('another conversation finishing while you read this one still notifies', () => {
  // The whole point of the feature: reading session A must not silence a
  // completion in session B.
  const cfg = quiet()
  const decision = decideNotify(cfg, 'completed', { watching: true, viewedSessionId: 'sess-A', sessionId: 'sess-B' })
  assert.equal(decision.action, 'notify')
})

test('no conversation on screen (settings open) still notifies', () => {
  // Three watching states exist:
  //   viewedSessionId === finishing session  -> reading it            -> quiet
  //   viewedSessionId !== finishing session  -> reading another one   -> notify
  //   viewedSessionId === undefined          -> no conversation on
  //     screen (the settings dialog is open) or not reported yet       -> notify
  // The last case must NOT be quiet: adjusting settings while a task runs is
  // precisely when you want to hear that it finished.
  const cfg = quiet()
  assert.equal(
    decideNotify(cfg, 'completed', { watching: true, viewedSessionId: undefined, sessionId: 's' }).action,
    'notify',
  )
})

test('not watching means completion-class scenes always fire', () => {
  const cfg = quiet()
  for (const scene of ['completed', 'interrupted', 'error']) {
    assert.equal(decideNotify(cfg, scene, { watching: false, viewedSessionId: 'sess-1', sessionId: 'sess-1' }).action, 'notify')
  }
})

test('numeric and string session ids compare by value', () => {
  const cfg = quiet()
  assert.equal(
    decideNotify(cfg, 'completed', { watching: true, viewedSessionId: 42, sessionId: '42' }).action,
    'skip',
  )
})

test('attention interrupts even while watching the same session', () => {
  // An approval or a question means the agent is blocked on the user; going
  // quiet there would defeat the whole feature.
  const cfg = quiet()
  assert.equal(
    decideNotify(cfg, 'attention', { watching: true, viewedSessionId: 'sess-1', sessionId: 'sess-1' }).action,
    'notify',
  )
})

test('attention can be made to respect the foreground on request', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { alwaysNotifyAttention: false })
  assert.equal(decideNotify(cfg, 'attention', { watching: true }).action, 'skip')
  assert.equal(decideNotify(cfg, 'attention', { watching: false }).action, 'notify')
})

test('quietOnForeground=false disables the watching rule entirely', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { quietOnForeground: false })
  const decision = decideNotify(cfg, 'completed', { watching: true, viewedSessionId: 'sess-1', sessionId: 'sess-1' })
  assert.equal(decision.action, 'notify')
})

test('silentScenes suppresses exactly the named scene', () => {
  // The answered-question case: the resumed turn ends as `completed`, but the
  // user just acted, so only that one must stay quiet.
  const cfg = quiet()
  assert.equal(decideNotify(cfg, 'completed', { silentScenes: ['completed'] }).action, 'skip')
  assert.equal(decideNotify(cfg, 'error', { silentScenes: ['completed'] }).action, 'notify')
  assert.equal(decideNotify(cfg, 'interrupted', { silentScenes: ['completed'] }).action, 'notify')
})

test('an unknown scene is refused rather than notified', () => {  assert.deepEqual(decideNotify(quiet(), 'bogus'), { action: 'skip', reason: 'unknown-scene' })
})

// ---------------------------------------------------------------------------
// Config handling
// ---------------------------------------------------------------------------

test('mergeConfig keeps untouched scenes and deep-merges per-scene fields', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { per: { error: { sound: 'ding' } } })
  assert.equal(cfg.per.error.sound, 'ding')
  assert.equal(cfg.per.error.enabled, true, 'unspecified fields keep their default')
  assert.equal(cfg.per.completed.sound, 'completed')
  assert.deepEqual(Object.keys(cfg.per).sort(), [...SCENES].sort())
})

test('mergeConfig ignores an unknown scene key instead of leaking it', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { per: { bogus: { enabled: false } } })
  assert.equal(cfg.per.bogus, undefined)
})

test('config round-trips through the file atomically', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { flash: false, volume: 0.5, per: { blocked: { sound: 'none' } } })
  saveConfig(cfg)
  const written = JSON.parse(readFileSync(configPath(), 'utf8'))
  assert.equal(written.flash, false)
  assert.equal(written.volume, 0.5)
  assert.equal(written.per.blocked.sound, 'none')
  const reloaded = loadConfig()
  assert.equal(reloaded.flash, false)
  assert.equal(reloaded.per.blocked.sound, 'none')
  // A corrupt file must fall back to defaults, never throw.
  writeFileSync(configPath(), '{ not json')
  assert.equal(loadConfig().notifications, true)
  saveConfig(DEFAULT_CONFIG)
})

// ---------------------------------------------------------------------------
// Argument construction for notify.ps1
// ---------------------------------------------------------------------------

test('buildNotifyArgs passes scene, sound and volume', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { volume: 0.6 })
  const args = buildNotifyArgs(cfg, 'interrupted', 'T', 'B', '')
  assert.ok(args.includes('-Scene') && args[args.indexOf('-Scene') + 1] === 'interrupted')
  assert.ok(args.includes('-Sound') && args[args.indexOf('-Sound') + 1] === 'interrupted')
  assert.equal(args[args.indexOf('-Volume') + 1], '0.6')
  assert.ok(!args.includes('-NoFlash'), 'flash stays on by default')
  assert.ok(!args.includes('-Launch'), 'no launch URL means an inert toast')
})

test('buildNotifyArgs honours the flash/toast switches', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { flash: false, toast: false })
  const args = buildNotifyArgs(cfg, 'completed', 'T', 'B', 'http://127.0.0.1:19387')
  assert.ok(args.includes('-NoFlash'))
  assert.ok(!args.includes('-FlashCount'), 'no count to pass when flash is off')
  assert.ok(args.includes('-NoToast'))
  assert.equal(args[args.indexOf('-Launch') + 1], 'http://127.0.0.1:19387')
})

test('buildNotifyArgs defaults to a finite burst followed by hold', () => {
  // The chat-app pattern: pulse a few times, then stay lit without animating.
  // An unbounded animated flash is what the earlier version got wrong.
  const args = buildNotifyArgs(mergeConfig(DEFAULT_CONFIG, {}), 'completed', 'T', 'B', '')
  assert.equal(args[args.indexOf('-FlashCount') + 1], '3')
  assert.equal(args[args.indexOf('-FlashTimeout') + 1], '500')
  assert.equal(args[args.indexOf('-FlashAfter') + 1], 'holdUntilFocused')
})

test('buildNotifyArgs forwards a custom flash count, pace and after-mode', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { flashCount: 10, flashTimeout: 200, flashAfter: 'stop' })
  const args = buildNotifyArgs(cfg, 'completed', 'T', 'B', '')
  assert.equal(args[args.indexOf('-FlashCount') + 1], '10')
  assert.equal(args[args.indexOf('-FlashTimeout') + 1], '200')
  assert.equal(args[args.indexOf('-FlashAfter') + 1], 'stop')
})

test('every flash-after mode is forwarded verbatim', () => {
  for (const mode of ['stop', 'holdUntilFocused', 'keepFlashing']) {
    const args = buildNotifyArgs(mergeConfig(DEFAULT_CONFIG, { flashAfter: mode }), 'completed', 'T', 'B', '')
    assert.equal(args[args.indexOf('-FlashAfter') + 1], mode)
  }
})

test('an unknown flash-after mode falls back to the default', () => {
  const args = buildNotifyArgs(mergeConfig(DEFAULT_CONFIG, { flashAfter: 'nonsense' }), 'completed', 'T', 'B', '')
  assert.equal(args[args.indexOf('-FlashAfter') + 1], 'holdUntilFocused')
})

test('turning flash off suppresses the mode instead of leaving it animating', () => {
  const args = buildNotifyArgs(mergeConfig(DEFAULT_CONFIG, { flash: false }), 'completed', 'T', 'B', '')
  assert.ok(args.includes('-NoFlash'))
  assert.ok(!args.includes('-FlashCount'))
  // -FlashAfter stop is still passed so the script cannot fall back to holding.
  assert.equal(args[args.indexOf('-FlashAfter') + 1], 'stop')
})

test('flashCount 0 is forwarded, not treated as falsy', () => {
  // 0 is the script's "until focused" convention; it must survive the trip.
  const args = buildNotifyArgs(mergeConfig(DEFAULT_CONFIG, { flashCount: 0 }), 'completed', 'T', 'B', '')
  assert.equal(args[args.indexOf('-FlashCount') + 1], '0')
})

test('a garbage flash count falls back to the default', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { flashCount: Number.NaN, flashTimeout: undefined })
  const args = buildNotifyArgs(cfg, 'completed', 'T', 'B', '')
  assert.equal(args[args.indexOf('-FlashCount') + 1], '3')
  assert.equal(args[args.indexOf('-FlashTimeout') + 1], '500')
})

test('a negative flash count is clamped rather than passed through', () => {
  const args = buildNotifyArgs(mergeConfig(DEFAULT_CONFIG, { flashCount: -4 }), 'completed', 'T', 'B', '')
  assert.equal(args[args.indexOf('-FlashCount') + 1], '0')
})

test('buildNotifyArgs lets a scene pick its own sound and mute its toast', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { per: { error: { sound: 'C:\\sounds\\boom.wav', toast: false } } })
  const args = buildNotifyArgs(cfg, 'error', 'T', 'B', '')
  assert.equal(args[args.indexOf('-Sound') + 1], 'C:\\sounds\\boom.wav')
  assert.ok(args.includes('-NoToast'))
})

test('buildNotifyArgs clamps a nonsensical volume', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { volume: 0 })
  assert.equal(buildNotifyArgs(cfg, 'completed', 'T', 'B', '')[buildNotifyArgs(cfg, 'completed', 'T', 'B', '').indexOf('-Volume') + 1], '1')
})

test('formatElapsed reads naturally in both languages', () => {
  assert.equal(formatElapsed(4500, 'en'), '5s')
  assert.equal(formatElapsed(134000, 'en'), '2m 14s')
  assert.equal(formatElapsed(120000, 'en'), '2m')
  assert.equal(formatElapsed(4500, 'zh'), '5 秒')
  assert.equal(formatElapsed(134000, 'zh'), '2 分 14 秒')
})

test('every scene has distinct, non-empty copy in BOTH languages', () => {
  // Guards against a half-translated dictionary and against two scenes sharing
  // a title (which would make them indistinguishable in the notification).
  for (const lang of ['zh', 'en']) {
    const titles = SCENES.map((scene) => {
      const copy = titleBodyFor(scene, lang)
      assert.equal(typeof copy.title, 'string', `${scene} title missing in ${lang}`)
      assert.ok(copy.title.length > 0, `${scene} title empty in ${lang}`)
      assert.ok(copy.body.length > 0, `${scene} body empty in ${lang}`)
      return copy.title
    })
    assert.equal(new Set(titles).size, SCENES.length, `${lang} titles must all differ: ${titles.join(' / ')}`)
  }
})

test('the language follows the environment override', () => {
  // The suite pins DSH_NOTIFY_CUES_LANG=zh so it does not depend on the host
  // locale; this asserts the override is what actually drives the copy.
  assert.equal(systemLang(), 'zh')
  assert.equal(titleBodyFor('completed').title, titleBodyFor('completed', 'zh').title)
  assert.notEqual(titleBodyFor('completed', 'zh').title, titleBodyFor('completed', 'en').title)
})

// ---------------------------------------------------------------------------
// End-to-end dispatch through a fake ctx
// ---------------------------------------------------------------------------

function makeContext() {
  const handlers = new Map()
  const spawned = []
  const ctx = {
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get(name) {
      if (name !== 'subprocess') return undefined
      return {
        spawn(options) {
          spawned.push(options)
          return { done: Promise.resolve({ exitCode: 0 }) }
        },
      }
    },
  }
  return {
    ctx,
    spawned,
    fire(name, ...args) {
      const fn = handlers.get(name)
      assert.ok(fn, `no handler registered for ${name}`)
      return fn(...args)
    },
    has(name) { return handlers.has(name) },
  }
}

function harness(config) {
  __resetForTests()
  const h = makeContext()
  apply(h.ctx, config)
  return h
}

const rootSession = (id = 'sess-1') => ({ id, header: { id, delegationDepth: 0 } })

test('a completed turn spawns exactly one notification', () => {
  const h = harness({ quietOnForeground: false })
  h.fire('session/event', rootSession(), { type: 'turn/start', data: { turn: 1 } })
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(h.spawned.length, 1)
  const argv = h.spawned[0].argv
  assert.equal(argv[argv.indexOf('-Scene') + 1], 'completed')
})

test('a user cancellation notifies as interrupted, never as completed', () => {
  const h = harness({ quietOnForeground: false })
  h.fire('session/event', rootSession(), { type: 'turn/start', data: { turn: 1 } })
  h.fire('session/event', rootSession(), {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  assert.equal(h.spawned.length, 1)
  const argv = h.spawned[0].argv
  assert.equal(argv[argv.indexOf('-Scene') + 1], 'interrupted')
  // Compare against the copy the plugin is configured to emit rather than a
  // hardcoded string: the old assertion matched '中断', which made the suite
  // depend on the host locale (green on zh-CN, red on an en-US CI runner).
  const expected = titleBodyFor('interrupted', systemLang())
  assert.equal(argv[argv.indexOf('-Title') + 1], expected.title)
  assert.notEqual(expected.title, titleBodyFor('completed', systemLang()).title,
    'an interruption must not reuse the completed copy')
})

test('the same turn never notifies twice', () => {
  // `agent/status: idle` can fire alongside turn/end for one turn.
  const h = harness({ quietOnForeground: false })
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  assert.equal(h.spawned.length, 1)
})

test('a parent cancellation produces no notification at all', () => {
  const h = harness({ quietOnForeground: false })
  h.fire('session/event', rootSession(), {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } },
  })
  assert.equal(h.spawned.length, 0)
})

test('a subagent session is ignored', () => {
  const h = harness({ quietOnForeground: false })
  const child = { id: 'child', header: { id: 'child', delegationDepth: 1 } }
  h.fire('session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(h.spawned.length, 0)
})

test('an event carrying a subagent-origin SESSION is ignored', () => {
  // `origin` lives on the session header, not on the event; a subagent session
  // is identified by its header (and by delegationDepth above 0).
  const h = harness({ quietOnForeground: false })
  const child = { id: 'child2', header: { id: 'child2', origin: 'subagent', delegationDepth: 1 } }
  h.fire('session/event', child, {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.equal(h.spawned.length, 0)
})

test('answering a question keeps the follow-up completion quiet', () => {
  const h = harness({ quietOnForeground: false })
  // The ask fires an attention notice and marks the session.
  h.fire('tools/execute', {
    name: 'ask_user_question',
    arguments: { questions: [{ header: 'Pick one', question: 'Which?' }] },
    agent: { session: rootSession() },
  }, () => Promise.resolve({ kind: 'allow' }))
  assert.equal(h.spawned.length, 1, 'the question itself must notify')
  assert.equal(h.spawned[0].argv[h.spawned[0].argv.indexOf('-Scene') + 1], 'attention')
  // The user answers; the turn resumes and ends as completed.
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(h.spawned.length, 1, 'the completion right after answering must stay silent')
})

test('the question listener hands the call on instead of swallowing it', async () => {
  // tools/execute is a waterfall: a listener that forgets next() claims the
  // decision and the tool never runs.
  const h = harness({ quietOnForeground: false })
  let reached = false
  await h.fire('tools/execute', {
    name: 'ask_user_question',
    arguments: { questions: [{ question: 'Which?' }] },
    agent: { session: rootSession() },
  }, () => { reached = true; return Promise.resolve({ kind: 'allow' }) })
  assert.equal(reached, true, 'next() must be called')
})

test('non-question tools pass through without notifying', () => {
  const h = harness({ quietOnForeground: false })
  h.fire('tools/execute', {
    name: 'pwsh',
    arguments: { command: 'ls' },
    agent: { session: rootSession() },
  }, () => Promise.resolve({ kind: 'allow' }))
  assert.equal(h.spawned.length, 0)
})

test('a subagent asking a question does not notify', () => {
  const h = harness({ quietOnForeground: false })
  const child = { id: 'child', header: { id: 'child', delegationDepth: 2 } }
  h.fire('tools/execute', {
    name: 'ask_user_question',
    arguments: { questions: [{ question: 'Which?' }] },
    agent: { session: child },
  }, () => Promise.resolve({ kind: 'allow' }))
  assert.equal(h.spawned.length, 0)
})

test('an error after a question is still reported', () => {
  const h = harness({ quietOnForeground: false })
  h.fire('tools/execute', {
    name: 'ask_user_question',
    arguments: { questions: [{ question: 'Which?' }] },
    agent: { session: rootSession() },
  }, () => Promise.resolve({ kind: 'allow' }))
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 3, reason: { kind: 'error' } } })
  assert.equal(h.spawned.length, 2, 'a real failure must not be swallowed by the suppression rule')
  assert.equal(h.spawned[1].argv[h.spawned[1].argv.indexOf('-Scene') + 1], 'error')
})

test('an interrupted turn after a question is still reported', () => {
  const h = harness({ quietOnForeground: false })
  h.fire('tools/execute', {
    name: 'ask_user_question',
    arguments: { questions: [{ question: 'Which?' }] },
    agent: { session: rootSession() },
  }, () => Promise.resolve({ kind: 'allow' }))
  h.fire('session/event', rootSession(), {
    type: 'turn/end', data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  assert.equal(h.spawned.length, 2)
  assert.equal(h.spawned[1].argv[h.spawned[1].argv.indexOf('-Scene') + 1], 'interrupted')
})

test('an approval request notifies as attention with the tool name', () => {
  const h = harness({ quietOnForeground: false })
  h.fire('session/event', rootSession(), { type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh' } })
  assert.equal(h.spawned.length, 1)
  const argv = h.spawned[0].argv
  assert.equal(argv[argv.indexOf('-Scene') + 1], 'attention')
  assert.ok(argv[argv.indexOf('-Body') + 1].includes('pwsh'))
})

test('the debounce is scoped per scene, so an approval cannot swallow a failure', () => {
  // Regression: a session-wide debounce would drop the error notice that
  // arrives moments after an approval prompt — i.e. silence a real failure.
  const h = harness({ quietOnForeground: false })
  h.fire('session/event', rootSession(), { type: 'approval/asked', data: { toolName: 'pwsh' } })
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  h.fire('session/event', rootSession(), {
    type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  const scenes = h.spawned.map((s) => s.argv[s.argv.indexOf('-Scene') + 1])
  assert.deepEqual(scenes, ['attention', 'error', 'interrupted'])
})

test('a repeated notice of the same scene inside the window is dropped', () => {
  const h = harness({ quietOnForeground: false, dedupMs: 60000 })
  h.fire('session/event', rootSession(), { type: 'approval/asked', data: { toolName: 'pwsh' } })
  h.fire('session/event', rootSession(), { type: 'approval/asked', data: { toolName: 'pwsh' } })
  assert.equal(h.spawned.length, 1, 'the same scene twice in a row is one notice')
})

test('watching the finishing session quiets completion but not attention', () => {
  const h = harness({ quietOnForeground: true })
  __setForegroundForTests({ visible: true, focused: true, viewedSessionId: 'sess-1' })
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(h.spawned.length, 0, 'reading this session means no completion chime')
  h.fire('session/event', rootSession(), { type: 'approval/asked', data: { toolName: 'pwsh' } })
  assert.equal(h.spawned.length, 1, 'an approval must break through')
  __setForegroundForTests(false)
})

test('a completion in ANOTHER session notifies while you read this one', () => {
  const h = harness({ quietOnForeground: true })
  __setForegroundForTests({ visible: true, focused: true, viewedSessionId: 'sess-1' })
  h.fire('session/event', rootSession('sess-2'), {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.equal(h.spawned.length, 1, 'the other conversation must still reach the user')
  __setForegroundForTests(false)
})

test('a backgrounded page notifies even for the session on screen', () => {
  const h = harness({ quietOnForeground: true })
  __setForegroundForTests({ visible: false, focused: false, viewedSessionId: 'sess-1' })
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(h.spawned.length, 1, 'switched away means remind me')
  __setForegroundForTests(false)
})

test('the master switch silences dispatch entirely', () => {
  const h = harness({ notifications: false })
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(h.spawned.length, 0)
})

test('a per-scene switch silences only that scene end to end', () => {
  const h = harness({ quietOnForeground: false, per: { interrupted: { enabled: false } } })
  h.fire('session/event', rootSession(), {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  assert.equal(h.spawned.length, 0)
  h.fire('session/event', rootSession(), { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(h.spawned.length, 1)
})

test('a legacy-aborted turn notifies as interrupted end to end', () => {
  const h = harness({ quietOnForeground: false })
  h.fire('session/event', rootSession(), {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } } },
  })
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].argv[h.spawned[0].argv.indexOf('-Scene') + 1], 'interrupted')
})

test('the required events are subscribed', () => {
  const h = harness({})
  assert.ok(h.has('session/event'), 'session/event must be subscribed')
  assert.ok(h.has('tools/execute'), 'tools/execute must be subscribed for ask_user_question')
})

test('the settings routes are registered inside a disposable effect', () => {
  // `apply` registers config / presence / test / keys through one ctx.effect
  // whose return value is the disposer. A missing disposer would leak routes
  // across a hot reload.
  __resetForTests()
  const registered = []
  const ctx = {
    on() { return () => {} },
    effect(fn) { registered.push(fn()); return () => {} },
    get(name) {
      if (name !== 'webServer') return undefined
      return { register(route) { registered.push(route); return () => {} } }
    },
  }
  apply(ctx, {})
  const disposers = registered.filter((r) => typeof r === 'function')
  assert.ok(disposers.length > 0, 'ctx.effect must return a disposer')
  const routes = registered.filter((r) => r !== null && typeof r === 'object' && typeof r.path === 'string')
  for (const path of ['/dsh-notify-cues/config', '/dsh-notify-cues/presence', '/dsh-notify-cues/test', '/dsh-notify-cues/keys']) {
    assert.ok(routes.some((r) => r.path === path), `${path} must be registered`)
  }
  assert.ok(routes.every((r) => r.kind === 'exact'), 'all routes must be exact matches')
  assert.ok(routes.every((r) => typeof r.handler === 'function'), 'every route needs a handler')
})
