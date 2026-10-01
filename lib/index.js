/**
 * dsh-notify-cues — host half.
 *
 * Windows notifications that distinguish WHY a turn ended, instead of
 * reporting every stop as "task complete".
 *
 * The reason comes from the session's own `turn/end` event, which carries
 * `data.reason.kind`. DSH's `TurnEndReasonMap` is:
 *
 *   completed   -> the turn finished normally
 *   aborted     -> cancelled; `reason.reason.kind` says by whom:
 *                  'user'     = the user pressed stop / Esc  -> interrupted
 *                  'hook'     = a hook vetoed the turn        -> blocked
 *                  'parent'   = a parent agent cancelled us   -> silent
 *                  'disposed' = the session was torn down     -> silent
 *   error       -> a step or turn failed
 *   max-tokens  -> the model hit its output ceiling
 *   interrupted -> reserved variant, treated as interrupted
 *   blocked     -> a guard refused the turn
 *
 * Decision logic is exported as pure functions so it can be unit-tested
 * without a running harness.
 */

import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// `export const name` is deliberately absent: the official host-plugin contract
// is `apply` (+ optional `inject` / `Config`), and cordis derives a debug name
// from the JS function name, discarding "apply". Plugin identity comes from the
// Loader entry's `id` in cordis.patch.yml.
export const inject = ['subprocess', 'webServer']

const SCRIPT_PATH = fileURLToPath(new URL('./notify.ps1', import.meta.url))
const CONFIG_ROUTE = '/dsh-notify-cues/config'
const PRESENCE_ROUTE = '/dsh-notify-cues/presence'
const TEST_ROUTE = '/dsh-notify-cues/test'
const KEYS_ROUTE = '/dsh-notify-cues/keys'

/** The six situations a user can tell apart by ear. */
export const SCENES = ['completed', 'interrupted', 'error', 'max-tokens', 'blocked', 'attention']

/** Built-in tones the settings page offers, plus `none` and a custom path. */
export const SOUND_NAMES = ['completed', 'interrupted', 'error', 'maxTokens', 'blocked', 'attention', 'ding', 'none']

/** Post-burst taskbar behaviours. `holdUntilFocused` is the chat-app pattern. */
export const FLASH_AFTER_MODES = ['stop', 'holdUntilFocused', 'keepFlashing']

export const DEFAULT_CONFIG = {
  /** Master switch. false = total silence (no toast, no sound, no flash). */
  notifications: true,
  /** Taskbar flash, global — the switch this plugin exists to expose. */
  flash: true,
  /**
   * The opening burst: how many times the taskbar button animates. This is the
   * part that catches the eye.
   */
  flashCount: 3,
  /** Milliseconds for one pulse (FlashWindowEx dwTimeout). */
  flashTimeout: 500,
  /**
   * What happens after the burst — the QQ/WeChat pattern:
   *   'stop'            - nothing more; the burst was the whole signal.
   *   'holdUntilFocused'- stop animating but keep the window in the "needs
   *                       attention" state until it is focused, so the taskbar
   *                       button stays lit. This is what chat apps do.
   *   'keepFlashing'    - resume the burst forever until focused. Loud; for
   *                       machines you walk away from.
   */
  flashAfter: 'holdUntilFocused',
  /** Toast popups, global. Sound and flash are switched independently. */
  toast: true,
  /** Chime volume, 0.1 – 1.0 (scales the synthesized tone's amplitude). */
  volume: 1,
  /** Suppress completion-class notices while the DSH page is focused. */
  quietOnForeground: true,
  /** 'attention' notices always interrupt, even in the foreground. */
  alwaysNotifyAttention: true,
  /** Same-session debounce floor, ms. */
  dedupMs: 1500,
  /**
   * Per-scene switch, toast switch, and sound. `sound` is a built-in tone name
   * from SOUND_NAMES, or an absolute path to a .wav file.
   */
  per: {
    completed: { enabled: true, toast: true, sound: 'completed' },
    interrupted: { enabled: true, toast: true, sound: 'interrupted' },
    error: { enabled: true, toast: true, sound: 'error' },
    'max-tokens': { enabled: true, toast: true, sound: 'maxTokens' },
    blocked: { enabled: true, toast: true, sound: 'blocked' },
    attention: { enabled: true, toast: true, sound: 'attention' },
  },
}

/**
 * Map a `turn/end` payload to a scene, or `undefined` when the turn ended for
 * a reason the user does not need to hear about.
 *
 * `reason.reason` is `TurnEndCancelCause = AgentCancelCause | { kind: 'legacy' }`,
 * so five abort causes exist, not four. `TurnEndReasonMap` is documented as
 * merge-extensible, hence the defensive default.
 *
 * @param payload - the `turn/end` event data: `{ turn, reason }`.
 * @returns the scene name, or undefined to stay silent.
 */
export function sceneForTurnEnd(payload) {
  const reason = payload?.reason
  if (reason === null || typeof reason !== 'object') return undefined
  switch (reason.kind) {
    case 'completed': return 'completed'
    case 'interrupted': return 'interrupted'
    case 'error': return 'error'
    case 'max-tokens': return 'max-tokens'
    case 'blocked': return 'blocked'
    case 'aborted': {
      const cause = reason.reason
      const by = cause === null || typeof cause !== 'object' ? undefined : cause.kind
      if (by === 'user') return 'interrupted'
      if (by === 'hook') return 'blocked'
      // 'legacy' is a turn closed by the session repair path during a log
      // upgrade: it did not finish, so it is the interrupted story.
      if (by === 'legacy') return 'interrupted'
      // 'parent' (a delegating agent cancelled this child) and 'disposed'
      // (session teardown) are not the user's business.
      return undefined
    }
    default: return undefined
  }
}

/** Human-facing copy per scene, in the UI language. */
const TEXT = {
  zh: {
    completed: { title: '任务完成', body: '这一轮已经结束，可以查看结果了。' },
    interrupted: { title: '已中断', body: '这一轮被你中断了，任务没有跑完。' },
    error: { title: '出错了', body: '这一轮因为报错而结束。' },
    'max-tokens': { title: '达到输出上限', body: '模型用完了这一轮的最大输出长度。' },
    blocked: { title: '已被阻止', body: '这一轮被拦截或依赖被取消，没有继续执行。' },
    attention: { title: '需要你操作', body: '有提问或审批在等你处理。' },
  },
  en: {
    completed: { title: 'Task complete', body: 'The turn finished — results are ready.' },
    interrupted: { title: 'Interrupted', body: 'You stopped this turn; it did not finish.' },
    error: { title: 'Failed', body: 'The turn ended because of an error.' },
    'max-tokens': { title: 'Output limit reached', body: 'The model hit its maximum output length.' },
    blocked: { title: 'Blocked', body: 'The turn was blocked or its dependency was cancelled.' },
    attention: { title: 'Your input is needed', body: 'A question or approval is waiting for you.' },
  },
}

/** The toast follows the OS language unless explicitly overridden. */
export function systemLang() {
  const forced = process.env.DSH_NOTIFY_CUES_LANG
  if (forced === 'zh' || forced === 'en') return forced
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale ?? ''
    return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

export function titleBodyFor(scene, lang = systemLang()) {
  const table = TEXT[lang] ?? TEXT.zh
  return table[scene] ?? { title: 'DeepSeek Harness', body: '' }
}

/** Format an elapsed duration the way a human reads it. */
export function formatElapsed(ms, lang = systemLang()) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (lang === 'en') {
    if (totalSeconds < 60) return `${totalSeconds}s`
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

/**
 * Pure gate: decide whether a scene should actually notify.
 *
 * @param cfg - effective configuration.
 * @param scene - one of SCENES.
 * @param opts - `{ foreground, silentScenes }`. `silentScenes` carries scenes
 *   that must stay quiet for a contextual reason (an answered question resumes
 *   the turn, whose `completed` end would otherwise chime right after the user
 *   already acted).
 * @param opts.watching - the browser reports the page is visible AND the DSH
 *   window is focused.
 * @param opts.viewedSessionId - the session currently in the main view, or
 *   undefined when the main view is showing something else (a panel is open, or
 *   the page is on another screen).
 * @param opts.sessionId - the session this notification is about.
 * @returns `{ action: 'notify' }` or `{ action: 'skip', reason }`.
 */
export function decideNotify(cfg, scene, opts = {}) {
  if (!cfg || cfg.notifications === false) return { action: 'skip', reason: 'disabled' }
  if (!SCENES.includes(scene)) return { action: 'skip', reason: 'unknown-scene' }
  const entry = cfg.per?.[scene]
  if (entry && entry.enabled === false) return { action: 'skip', reason: 'scene-disabled' }
  const attention = scene === 'attention'
  if (attention) {
    if (cfg.alwaysNotifyAttention === false && opts.watching === true) {
      return { action: 'skip', reason: 'foreground' }
    }
    return { action: 'notify' }
  }
  if (Array.isArray(opts.silentScenes) && opts.silentScenes.includes(scene)) {
    return { action: 'skip', reason: 'suppressed' }
  }
  // "Quiet while watching" means the user is looking at THIS session. A
  // different session finishing while they read another one — or while they are
  // in the settings dialog, where no conversation is on screen — is exactly the
  // case the notification exists for, so it still fires.
  if (cfg.quietOnForeground !== false && opts.watching === true) {
    const viewed = opts.viewedSessionId
    if (viewed !== undefined && viewed !== null && String(viewed) === String(opts.sessionId)) {
      return { action: 'skip', reason: 'foreground' }
    }
  }
  return { action: 'notify' }
}

/** Merge a partial patch over the defaults, one level deep on `per`. */
export function mergeConfig(base, patch) {
  const out = { ...base, ...(patch ?? {}) }
  out.per = {}
  for (const scene of SCENES) {
    out.per[scene] = { ...base.per[scene], ...(patch?.per?.[scene] ?? {}) }
  }
  return out
}

export function resolveHome() {
  const envHome = process.env.DSH_HOME
  return typeof envHome === 'string' && envHome.trim() !== '' ? envHome : join(homedir(), '.dsh')
}

export function configPath() {
  return join(resolveHome(), 'dsh-notify-cues.json')
}

export function loadConfig() {
  try {
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(configPath(), 'utf8')))
  } catch {
    return mergeConfig(DEFAULT_CONFIG, {})
  }
}

/** Atomic write: tmp + rename, so a crash can never leave a half file. */
export function saveConfig(cfg) {
  const target = configPath()
  const tmp = `${target}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, target)
}

/**
 * Build the notify.ps1 argument vector. Pure so tests can assert on it.
 *
 * @param cfg - effective configuration.
 * @param scene - the scene being announced.
 * @param title - toast title.
 * @param body - toast body.
 * @param launchUrl - URL a toast click should open ('' = inert toast).
 */
export function buildNotifyArgs(cfg, scene, title, body, launchUrl = '') {
  const entry = cfg.per?.[scene] ?? {}
  const volume = typeof cfg.volume === 'number' && cfg.volume > 0 && cfg.volume <= 1 ? cfg.volume : 1
  const args = [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT_PATH,
    '-Scene', scene,
    '-Title', title,
    '-Body', body,
    '-Sound', typeof entry.sound === 'string' && entry.sound !== '' ? entry.sound : scene,
    '-Volume', String(volume),
  ]
  if (launchUrl !== '') args.push('-Launch', launchUrl)
  if (cfg.flash === false) {
    args.push('-NoFlash')
    args.push('-FlashAfter', 'stop')
  } else {
    const count = Number.isFinite(cfg.flashCount) ? Math.max(0, Math.trunc(cfg.flashCount)) : DEFAULT_CONFIG.flashCount
    const timeout = Number.isFinite(cfg.flashTimeout) ? Math.max(0, Math.trunc(cfg.flashTimeout)) : DEFAULT_CONFIG.flashTimeout
    // 'keepFlashing' is expressed to the script as a burst of 0, its
    // "until focused" convention.
    const after = FLASH_AFTER_MODES.includes(cfg.flashAfter) ? cfg.flashAfter : DEFAULT_CONFIG.flashAfter
    args.push('-FlashCount', String(count), '-FlashTimeout', String(timeout), '-FlashAfter', after)
  }
  if (cfg.toast === false || entry.toast === false) args.push('-NoToast')
  return args
}

// ---------------------------------------------------------------------------
// Runtime state (module level: a hot reload must not double-fire a turn)
// ---------------------------------------------------------------------------

const lastNotifyAt = new Map()      // `${sessionId}#${scene}` -> ts
const notifiedTurn = new Set()      // `${sessionId}#${turn}` — turn/end vs idle race
const pendingQuestion = new Set()   // sessionIds inside an ask_user_question turn
const turnStartedAt = new Map()     // sessionId -> ts (for "took 2m 14s")

/**
 * Browser presence, reported by the client half. Both channels matter:
 * `visible` covers tab switches and minimisation, `focused` covers the DSH
 * window losing focus to another application. `viewedSessionId` is the session
 * in the main view, so "another conversation finished" still notifies.
 *
 * Initial state is "not watching", so a broken reporting link can never swallow
 * a notification.
 */
const presence = { visible: false, focused: false, viewedSessionId: undefined }

/** @internal test hook — clear cross-test state. */
export function __resetForTests() {
  lastNotifyAt.clear()
  notifiedTurn.clear()
  pendingQuestion.clear()
  turnStartedAt.clear()
  presence.visible = false
  presence.focused = false
  presence.viewedSessionId = undefined
}

/**
 * @internal test hook — force browser presence.
 * @param value - `true` to appear watched, or an object
 *   `{ visible, focused, viewedSessionId }` for the detailed channel.
 */
export function __setForegroundForTests(value) {
  if (value !== null && typeof value === 'object') {
    presence.visible = value.visible === true
    presence.focused = value.focused === true
    presence.viewedSessionId = value.viewedSessionId
    return
  }
  presence.visible = value === true
  presence.focused = value === true
  presence.viewedSessionId = undefined
}

/** The user is looking at DSH right now. */
function isWatching() {
  return presence.visible && presence.focused
}

function resolvePowershell() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  for (const candidate of [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/** Root sessions only: a subagent finishing is an inner step, not news. */
function isRootSession(session) {
  try {
    const depth = session?.header?.delegationDepth
    return depth === undefined || depth === 0
  } catch {
    return true
  }
}

function sessionIdOf(session) {
  return session?.id ?? session?.header?.id ?? undefined
}

export function apply(ctx, config = {}) {
  // Re-read the file on every dispatch so the settings page (or a hand edit)
  // takes effect on the very next notification, with no reload.
  const effective = () => mergeConfig(loadConfig(), config)

  const dispatch = (scene, session, extra = {}) => {
    const current = effective()
    const sessionId = sessionIdOf(session) ?? 'global'
    const decision = decideNotify(current, scene, {
      watching: isWatching(),
      viewedSessionId: presence.viewedSessionId,
      sessionId,
      silentScenes: extra.silentScenes ?? [],
    })
    if (decision.action !== 'notify') return decision

    const now = Date.now()
    const floor = typeof current.dedupMs === 'number' ? current.dedupMs : DEFAULT_CONFIG.dedupMs
    // Scoped per (session, scene): an approval prompt followed straight away by
    // a failure must still report the failure. Only a repeated notice of the
    // SAME scene is a duplicate worth dropping.
    const dedupeKey = `${sessionId}#${scene}`
    if (now - (lastNotifyAt.get(dedupeKey) ?? 0) < floor) return { action: 'skip', reason: 'dedupe' }
    lastNotifyAt.set(dedupeKey, now)

    const lang = systemLang()
    const copy = titleBodyFor(scene, lang)
    const title = extra.title ?? copy.title
    let body = extra.body ?? copy.body
    if (extra.elapsedMs !== undefined && scene !== 'attention') {
      body += lang === 'en'
        ? ` (took ${formatElapsed(extra.elapsedMs, lang)})`
        : `（用时 ${formatElapsed(extra.elapsedMs, lang)}）`
    }
    runNotify(ctx, current, scene, title, body, process.env.DSH_WEB_URL ?? '')
    return { action: 'notify' }
  }

  // --- the core signal: why did the turn end? ------------------------------
  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object') return
    // NOTE: the event carries no `origin` field — `origin` lives on the session
    // HEADER (`'subagent'`), which is why isRootSession() reads it from there.
    if (!isRootSession(session)) return
    const id = sessionIdOf(session)

    if (event.type === 'turn/start') {
      if (id !== undefined) turnStartedAt.set(id, Date.now())
      return
    }

    if (event.type === 'turn/end') {
      const scene = sceneForTurnEnd(event.data)
      const turn = event.data?.turn
      if (id !== undefined && turn !== undefined) {
        const key = `${id}#${turn}`
        // `agent/status: idle` can fire for the same turn; keep exactly one chime.
        if (notifiedTurn.has(key)) return
        notifiedTurn.add(key)
        if (notifiedTurn.size > 400) {
          for (const stale of notifiedTurn) { notifiedTurn.delete(stale); if (notifiedTurn.size <= 200) break }
        }
      }
      if (scene === undefined) return

      const wasAnswering = id !== undefined && pendingQuestion.has(id)
      // Read the start marker BEFORE dropping it, or the duration is always lost.
      const startedAt = id === undefined ? undefined : turnStartedAt.get(id)
      if (id !== undefined) {
        pendingQuestion.delete(id)
        turnStartedAt.delete(id)
      }

      // An answered question resumes the turn, which then ends as `completed`
      // — but the user just acted, so a "complete" chime is pure noise. Errors
      // and interruptions remain real news and are never suppressed here.
      const silentScenes = scene === 'completed' && wasAnswering ? ['completed'] : []

      dispatch(scene, session, {
        silentScenes,
        elapsedMs: startedAt === undefined ? undefined : Date.now() - startedAt,
      })
      return
    }

    // An approval is waiting: the agent is blocked on the user, so this must
    // interrupt even when the page is focused.
    if (event.type === 'approval/asked') {
      const toolName = event.data?.toolName
      const body = typeof toolName === 'string' && toolName !== ''
        ? (systemLang() === 'en' ? `Tool: ${toolName}` : `工具：${toolName}`)
        : undefined
      dispatch('attention', session, body === undefined ? {} : { body })
    }
  })

  // A direct question to the user: same "come back and act" class. This is the
  // host-level waterfall that wraps every tool call; the session-event stream's
  // `tool/call` is not guaranteed to reach host plugins. The listener observes
  // only — it must hand the call on by returning next().
  // The session is marked so the completion that follows the answer stays quiet.
  ctx.on('tools/execute', (exec, next) => {
    if (exec?.name !== 'ask_user_question') return next()
    const session = exec?.agent?.session
    if (!isRootSession(session)) return next()
    const id = sessionIdOf(session)
    if (id !== undefined) pendingQuestion.add(id)
    const questions = exec?.arguments?.questions
    const first = Array.isArray(questions) && questions.length > 0 ? questions[0] : undefined
    const title = typeof first?.header === 'string' && first.header !== '' ? first.header : undefined
    const body = typeof first?.question === 'string' && first.question !== '' ? first.question : undefined
    dispatch('attention', session, {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
    })
    return next()
  })

  // --- the settings + preview API -----------------------------------------
  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return () => {}

    const configRoute = {
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: async (req, res) => {
        if (!isSameOrigin(req)) { sendText(res, 403, 'forbidden'); return }
        if (req.method === 'GET') { sendJson(res, { config: effective(), scenes: SCENES, sounds: SOUND_NAMES }); return }
        if (req.method === 'POST') {
          readJsonBody(req,
            (patch) => {
              const next = mergeConfig(effective(), patch)
              try { saveConfig(next) } catch (error) {
                sendText(res, 500, `save failed: ${error?.message ?? error}`)
                return
              }
              sendJson(res, { config: next, scenes: SCENES, sounds: SOUND_NAMES })
            },
            () => sendText(res, 400, 'bad json'))
          return
        }
        sendText(res, 405, 'method not allowed')
      },
    }

    const presenceRoute = {
      kind: 'exact',
      path: PRESENCE_ROUTE,
      handler: (req, res) => {
        if (!isSameOrigin(req)) { sendText(res, 403, 'forbidden'); return }
        if (req.method === 'GET') {
          sendJson(res, { ...presence, watching: isWatching() })
          return
        }
        if (req.method === 'POST') {
          readJsonBody(req,
            (patch) => {
              if (typeof patch.visible === 'boolean') presence.visible = patch.visible
              if (typeof patch.focused === 'boolean') presence.focused = patch.focused
              if ('viewedSessionId' in patch) {
                const value = patch.viewedSessionId
                presence.viewedSessionId = typeof value === 'string' && value !== '' ? value : undefined
              }
              sendJson(res, { ...presence, watching: isWatching() })
            },
            () => sendText(res, 400, 'bad json'))
          return
        }
        sendText(res, 405, 'method not allowed')
      },
    }

    const testRoute = {
      kind: 'exact',
      path: TEST_ROUTE,
      handler: (req, res) => {
        if (!isSameOrigin(req)) { sendText(res, 403, 'forbidden'); return }
        const scene = new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('scene') ?? 'completed'
        if (!SCENES.includes(scene)) { sendText(res, 400, 'unknown scene'); return }
        // A preview must be audible right now, so bypass the foreground rule
        // and the per-scene enable switch without touching the saved config.
        const forced = mergeConfig(effective(), { notifications: true, quietOnForeground: false })
        const lang = systemLang()
        const copy = titleBodyFor(scene, lang)
        const title = lang === 'en' ? `Preview — ${copy.title}` : `试听 — ${copy.title}`
        try {
          runNotify(ctx, forced, scene, title, copy.body, '')
        } catch (error) {
          sendText(res, 500, `spawn failed: ${error?.message ?? error}`)
          return
        }
        sendJson(res, { ok: true, scene })
      },
    }

    const keysRoute = {
      kind: 'exact',
      path: KEYS_ROUTE,
      handler: (req, res) => {
        if (!isSameOrigin(req)) { sendText(res, 403, 'forbidden'); return }
        if (req.method === 'GET') { sendJson(res, { scenes: SCENES, sounds: SOUND_NAMES }); return }
        sendText(res, 405, 'method not allowed')
      },
    }

    const disposers = [configRoute, presenceRoute, testRoute, keysRoute].map((route) => webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-notify-cues: settings + preview routes')
}

function runNotify(ctx, cfg, scene, title, body, launchUrl) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return
  const handle = subprocess.spawn({
    argv: [resolvePowershell(), ...buildNotifyArgs(cfg, scene, title, body, launchUrl)],
    cwd: tmpdir(),
    // notify.ps1 is fire-and-forget; its stdout is only for manual CLI testing.
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    graceMs: 15000,
  })
  handle.done.catch(() => {})
}

// `webServer` handlers are reachable from any page that can hit the port;
// refuse cross-site callers (the browser sends Sec-Fetch-Site on fetch()).
export function isSameOrigin(req) {
  const site = req?.headers?.['sec-fetch-site']
  if (site === undefined) return true
  return site === 'same-origin' || site === 'none'
}

function sendJson(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function readJsonBody(req, onOk, onBad) {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad json')
      onOk(parsed)
    } catch { onBad() }
  })
}
