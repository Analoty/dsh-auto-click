/**
 * Host half of `dsh-auto-click`.
 *
 * The browser half is only an interaction layer: it notices a modified click or
 * a right click on a file row and asks THIS half to act on the path. Every
 * operation that touches the machine therefore lives here, once:
 *
 * - `open` hands the path to the desktop's own handler registry through DSH's
 *   `sessionController` Remote service (`openWorkspacePath`), so this plugin
 *   spawns nothing itself and inherits the Host's own path verification, which
 *   runs the requested path through the composed filesystem before any native
 *   opener sees it.
 * - `reveal` is the same call with `action: 'reveal'` — the file manager of the
 *   machine that owns the workspace.
 * - `openwith` shows the OPERATING SYSTEM's own "Open with" chooser for the file.
 *   The plugin keeps no application list of its own: the shell already knows
 *   every handler registered for a type, on any machine, and the plugin cannot
 *   be more correct than the OS about which applications open which format.
 * - `raw` serves one file's bytes to the page so the browser half can copy the
 *   contents or save a copy elsewhere. The read is bounded and refuses anything
 *   that is not a regular file.
 *
 * The routes live under `/auto-click/` and share DSH's own trust fence: every
 * request first asks `connection.requestRejection`, so an unauthenticated or
 * cross-origin caller is answered before it reaches this file. That is the same
 * order the shipped `open-in-app` routes use.
 */
import { extname, join } from 'node:path'

/** Cordis function-plugin name. */
export const name = 'auto-click'

/** The route carrier, the trust fence, and the composed filesystem. */
export const inject = ['webServer', 'connection', 'fs']

/** Route root. The browser half addresses these document-relatively. */
const ROUTE_PREFIX = '/auto-click'

/** Largest file the browser half may read for "copy contents" / "save a copy". */
const MAX_RAW_BYTES = 8 * 1024 * 1024

/** Host request bodies here are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * In-memory record of the last row gesture this page observed.
 *
 * The browser half reports what it saw BEFORE it asks anything, so a gesture
 * that dies on the way to the menu leaves its cause here instead of in a console
 * nobody is reading. Read it back with `GET /auto-click/diag`. Bounded and
 * overwritten in place, never appended to disk.
 */
const lastGesture = {
  at: 0,
  kind: null,
  path: null,
  target: null,
  decided: null,
  stage: null,
}

/** JSON answer: live facts, never cached. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** One failure in the shape the browser half reports to the user. */
function sendFailure(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** Answer a request that must use one method. */
function methodNotAllowed(res, allowed) {
  res.statusCode = 405
  res.setHeader('allow', allowed)
  res.end()
}

/**
 * Read one JSON body up to {@link MAX_BODY_BYTES}.
 * @param req - the incoming request.
 * @returns the parsed object, or `undefined` when it is absent, oversized, or not an object.
 */
async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (bytes === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The `path` search parameter of one request, when it is a non-empty string. */
function queryPath(req) {
  try {
    const value = new URL(String(req.url), 'http://localhost').searchParams.get('path')
    return value !== null && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** The `session` search parameter: the Session whose workspace resolves a relative path. */
function querySession(req) {
  try {
    const value = new URL(String(req.url), 'http://localhost').searchParams.get('session')
    return value !== null && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve one requested path through the composed filesystem.
 *
 * A request names a path; the filesystem decides what it means on this machine
 * (`ctx.fs.processPath` is the verified Host mapping every native consumer of
 * this file already uses).
 *
 * A RELATIVE path is the normal case, not an error: chat file links and tree
 * rows name files relative to the Session's workspace (`boss_ai_jobs/x.html`),
 * which is a different base from this process's own working directory.
 *
 * Such a path is resolved ONLY against that workspace. Falling back to
 * `process.cwd()` was actively harmful: when the workspace was unknown, a link
 * silently resolved to a same-named file elsewhere (or to nothing), and "copy
 * path" then put a path the user never pointed at on the clipboard. A relative
 * path with no known workspace is now REFUSED instead of guessed.
 * @param ctx - Host context carrying `fs`.
 * @param requested - the path the browser half named.
 * @param workspaceRoot - the workspace root of the Session the page named, when it named one.
 * @returns the resolved target and its OS path, or `undefined` when it does not resolve.
 */
async function resolveTarget(ctx, requested, workspaceRoot) {
  if (typeof requested !== 'string' || requested === '') return undefined
  const absoluteLike = /^[A-Za-z]:[\\/]/.test(requested) || requested.startsWith('/') || requested.startsWith('\\\\')
  if (absoluteLike) {
    try {
      const target = await ctx.fs.resolve(requested)
      const absolute = ctx.fs.processPath(target)
      if (typeof absolute !== 'string' || absolute === '') return undefined
      const info = await ctx.fs.stat(target).catch(() => undefined)
      return info === undefined ? undefined : { target, absolute, info }
    } catch {
      return undefined
    }
  }

  // A relative path means "inside this Session's workspace" — nothing else.
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return undefined
  try {
    const target = await ctx.fs.resolve(join(workspaceRoot, requested))
    const absolute = ctx.fs.processPath(target)
    if (typeof absolute !== 'string' || absolute === '') return undefined
    const info = await ctx.fs.stat(target).catch(() => undefined)
    return info === undefined ? undefined : { target, absolute, info }
  } catch {
    return undefined
  }
}

/**
 * The workspace root of one Session, read from the Host's own Session list.
 *
 * The page names the Session it is showing; the root that resolves its relative
 * paths is that Session's header `cwd`, exactly the base DSH's own file links
 * use.
 * @param ctx - Host context.
 * @param sessionId - the Session the page named, when it named one.
 * @returns the root, or `undefined` when it is unknown.
 */
async function workspaceRootOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const controller = ctx.get('sessionController')
    if (controller === undefined || typeof controller.inspect !== 'function') return undefined
    const inspection = await controller.inspect(sessionId)
    const root = inspection?.meta?.cwd
    return typeof root === 'string' && root !== '' ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask the operating system to show its own "Open with" chooser for one path.
 *
 * This replaces the plugin's own application list. The shell dialog is the
 * authoritative and portable answer: it knows every handler registered for the
 * type, on any machine and any Windows build, and it is the same list the user
 * sees from Explorer. The plugin never has to decide which applications "really"
 * support a format, which is a question it kept getting wrong.
 *
 * On Windows the chooser is raised through the Shell COM object
 * (`Shell.Application` → `InvokeVerb('openas')`), NOT through
 * `rundll32.exe shell32.dll,OpenAs_RunDLL`. The rundll32 form is widely
 * recommended online but was verified on this machine to exit immediately with
 * code 0 and NO dialog for every file type — the plugin would report success and
 * nothing would appear. `InvokeVerb('openas')` was verified to open the real
 * `OpenWith` window for .pdf, .md, .html, .png and .txt alike.
 * @param path - the absolute path to show the chooser for.
 * @returns whether the chooser was launched; a failure carries its reason.
 */
async function openWithChooser(path) {
  if (process.platform === 'win32') {
    return openWithChooserWindows(path)
  }
  const { spawn } = await import('node:child_process')
  const launch = (command, args) => new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', (error) => {
        resolve({ ok: false, error: { code: 'desktop/open-with-failed', message: error.message } })
      })
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (error) {
      resolve({
        ok: false,
        error: { code: 'desktop/open-with-failed', message: error instanceof Error ? error.message : String(error) },
      })
    }
  })
  if (process.platform === 'darwin') {
    return launch('open', ['-a', path])
  }
  return { ok: false, error: { code: 'desktop/open-with-unsupported', message: 'This platform has no file-association chooser.' } }
}

/**
 * The Windows implementation of the chooser.
 *
 * A PowerShell process hosts the Shell COM object (there is no Node binding for
 * it). The path arrives through the ENVIRONMENT, never through the command line,
 * so a name containing quotes, `&`, or PowerShell metacharacters cannot change
 * what is executed.
 *
 * `detached` and `windowsHide` MUST stay off. Measured on Windows 11, a child
 * started with `detached: true` or `windowsHide: true` cannot raise the chooser:
 * it exits 0 while no dialog appears, because the process is no longer attached
 * to the interactive desktop that owns the Shell window. Only a non-detached,
 * window-visible child actually shows it. That silent failure is why the first
 * version of this route reported success and did nothing.
 * @param path - the absolute path to show the chooser for.
 * @returns whether the chooser was launched.
 */
async function openWithChooserWindows(path) {
  const { spawn } = await import('node:child_process')
  // The verb is a fixed literal, so only the path varies. `InvokeVerb` accepts
  // 'openas' even though the verb is not listed by `Verbs()` for every type.
  const script = [
    "$shell = New-Object -ComObject Shell.Application",
    "$file = $env:DSH_AUTO_CLICK_OPENWITH",
    "$dir = Split-Path $file -Parent",
    "$leaf = Split-Path $file -Leaf",
    "$item = $shell.Namespace($dir).ParseName($leaf)",
    "if ($null -eq $item) { exit 2 }",
    "$item.InvokeVerb('openas')",
  ].join('; ')
  return new Promise((resolve) => {
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          // Detached and hidden children cannot show the chooser; see above.
          detached: false,
          stdio: 'ignore',
          env: { ...process.env, DSH_AUTO_CLICK_OPENWITH: path },
        },
      )
      // The child ends on its own once the verb is invoked; the dialog belongs to
      // the shell, so the Host does not wait for it to be dismissed.
      child.once('error', (error) => {
        resolve({ ok: false, error: { code: 'desktop/open-with-failed', message: error.message } })
      })
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (error) {
      resolve({
        ok: false,
        error: { code: 'desktop/open-with-failed', message: error instanceof Error ? error.message : String(error) },
      })
    }
  })
}

/**
 * The Host's native-open capability, probed at call time.
 *
 * `sessionController` is an optional service: a composition without the Session
 * domain still loads this plugin, and its routes then answer "the desktop
 * cannot be reached" instead of taking the whole page down.
 * @param ctx - Host context.
 * @returns the service, or `undefined` when this deployment has none.
 */
function nativeController(ctx) {
  try {
    const service = ctx.get('sessionController')
    return service !== undefined && typeof service.openWorkspacePath === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * Hand one path to the desktop.
 * @param ctx - Host context.
 * @param request - the path, an explicit handler id, and whether to reveal instead of opening.
 * @returns the success flag; a failure carries the reason the Host reported.
 */
async function openOnDesktop(ctx, request) {
  const controller = nativeController(ctx)
  if (controller === undefined) {
    return { ok: false, error: { code: 'desktop/unavailable', message: 'This deployment has no desktop opener.' } }
  }
  const resolved = await resolveTarget(ctx, request.path, request.workspaceRoot)
  if (resolved === undefined) {
    return { ok: false, error: { code: 'path/unresolved', message: `Cannot resolve: ${request.path}` } }
  }
  try {
    await controller.openWorkspacePath(
      {
        path: resolved.absolute,
        ...(request.action === 'reveal' ? { action: 'reveal' } : {}),
        ...(typeof request.application === 'string' && request.application !== ''
          ? { application: request.application }
          : {}),
      },
      new AbortController().signal,
    )
    return { ok: true, path: resolved.absolute }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'desktop/open-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Mount the four routes.
 * @param ctx - Host context carrying `webServer`, `connection`, and `fs`.
 */
export function apply(ctx) {
  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const status = ctx.connection.requestRejection(req)
    if (status === undefined) return false
    res.statusCode = status
    res.end()
    return true
  }

  // What this deployment can do at all, and which file manager owns "reveal".
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/capabilities`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
          const controller = nativeController(ctx)
          let desktop = false
          let fileManager = null
          if (controller !== undefined) {
            try {
              desktop = controller.canOpenWorkspacePath() === true
            } catch {
              desktop = false
            }
            try {
              fileManager = controller.workspaceDesktop().fileManager ?? null
            } catch {
              fileManager = null
            }
          }
          sendJson(res, 200, {
            ok: true,
            name: name,
            desktop,
            platform: process.platform,
            fileManager,
          })
        },
      }),
    `auto-click: GET ${ROUTE_PREFIX}/capabilities`,
  )

  // The last row gesture this page saw, for diagnosing "nothing happened".
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/diag`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, gesture: lastGesture })
            return
          }
          if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')
          const body = await readJsonBody(req)
          if (body === undefined) {
            sendFailure(res, 400, 'request/invalid', 'Expected a JSON body.')
            return
          }
          lastGesture.at = Date.now()
          lastGesture.kind = typeof body.kind === 'string' ? body.kind : null
          lastGesture.path = typeof body.path === 'string' ? body.path : null
          lastGesture.target = typeof body.target === 'string' ? body.target : null
          lastGesture.decided = body.decided === undefined ? null : body.decided
          lastGesture.stage = typeof body.stage === 'string' ? body.stage : null
          sendJson(res, 200, { ok: true })
        },
      }),
    `auto-click: ${ROUTE_PREFIX}/diag`,
  )

  // What one path is, and the handlers the OS registered for it. The browser
  // half asks this before drawing a menu, so it never has to guess a row's kind
  // from another plugin's markup: file-only rows are decided HERE.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/info`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
          const requested = queryPath(req)
          const workspaceRoot = await workspaceRootOf(ctx, querySession(req))
          const resolved = await resolveTarget(ctx, requested, workspaceRoot)
          if (resolved === undefined) {
            sendFailure(res, 400, 'path/unresolved', `Cannot resolve: ${String(requested)}`)
            return
          }
          const info = resolved.info
          const isFile = info !== undefined && info.type === 'file'
          const answer = {
            ok: true,
            path: resolved.absolute,
            name: resolved.absolute,
            extension: extname(resolved.absolute).toLowerCase(),
            isFile,
            isDirectory: info !== undefined && info.type === 'directory',
            size: info !== undefined && typeof info.size === 'number' ? info.size : null,
            desktop: false,
          }
          const controller = nativeController(ctx)
          if (controller === undefined) {
            sendJson(res, 200, answer)
            return
          }
          try {
            answer.desktop = controller.canOpenWorkspacePath() === true
          } catch {
            answer.desktop = false
          }
          sendJson(res, 200, answer)
        },
      }),
    `auto-click: GET ${ROUTE_PREFIX}/info`,
  )

  // Open a file with its own handler, or with one named handler.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/open`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
          const body = await readJsonBody(req)
          if (body === undefined || typeof body.path !== 'string') {
            sendFailure(res, 400, 'request/invalid', 'Expected a JSON body with a string `path`.')
            return
          }
          const workspaceRoot = await workspaceRootOf(ctx, body.session)
          sendJson(res, 200, await openOnDesktop(ctx, {
            path: body.path,
            application: body.application,
            workspaceRoot,
          }))
        },
      }),
    `auto-click: POST ${ROUTE_PREFIX}/open`,
  )

  // Show the operating system's own "Open with" chooser for one path.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/openwith`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
          const body = await readJsonBody(req)
          if (body === undefined || typeof body.path !== 'string') {
            sendFailure(res, 400, 'request/invalid', 'Expected a JSON body with a string `path`.')
            return
          }
          const workspaceRoot = await workspaceRootOf(ctx, body.session)
          const resolved = await resolveTarget(ctx, body.path, workspaceRoot)
          if (resolved === undefined) {
            sendFailure(res, 200, 'path/unresolved', `Cannot resolve: ${body.path}`)
            return
          }
          sendJson(res, 200, await openWithChooser(resolved.absolute))
        },
      }),
    `auto-click: POST ${ROUTE_PREFIX}/openwith`,
  )

  // Reveal a path in the file manager of the machine that owns the workspace.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/reveal`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
          const body = await readJsonBody(req)
          if (body === undefined || typeof body.path !== 'string') {
            sendFailure(res, 400, 'request/invalid', 'Expected a JSON body with a string `path`.')
            return
          }
          const workspaceRoot = await workspaceRootOf(ctx, body.session)
          sendJson(res, 200, await openOnDesktop(ctx, {
            path: body.path,
            action: 'reveal',
            workspaceRoot,
          }))
        },
      }),
    `auto-click: POST ${ROUTE_PREFIX}/reveal`,
  )

  // One file's bytes, for "copy contents" and "save a copy elsewhere".
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/raw`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
          const workspaceRoot = await workspaceRootOf(ctx, querySession(req))
          const resolved = await resolveTarget(ctx, queryPath(req), workspaceRoot)
          if (resolved === undefined) {
            sendFailure(res, 404, 'path/unresolved', 'The requested path does not resolve on this machine.')
            return
          }
          try {
            const info = resolved.info
            if (info === undefined || info.type !== 'file') {
              sendFailure(res, 400, 'file/not-a-file', 'Only a regular file can be read.')
              return
            }
            if (typeof info.size === 'number' && info.size > MAX_RAW_BYTES) {
              sendFailure(res, 413, 'file/too-large', `The file is larger than ${MAX_RAW_BYTES} bytes.`)
              return
            }
            const bytes = await ctx.fs.readBytes(resolved.target, undefined, MAX_RAW_BYTES)
            res.statusCode = 200
            res.setHeader('content-type', 'application/octet-stream')
            res.setHeader('content-length', String(bytes.byteLength))
            res.setHeader('cache-control', 'no-store')
            res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
          } catch (error) {
            sendFailure(res, 200, 'file/read-failed', error instanceof Error ? error.message : String(error))
          }
        },
      }),
    `auto-click: GET ${ROUTE_PREFIX}/raw`,
  )
}
