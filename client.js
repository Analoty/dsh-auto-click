window.__ModuleLoader__.load({
  id: 'dsh-auto-click',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The route root the Host half serves. */
    const ROUTE = 'auto-click'

    /**
     * Whether a tree row stands for a DIRECTORY.
     *
     * DSH's own files pane says so outright (`data-files-entry="directory"`).
     * The Better Sidebar marks directory rows with its `explorerDir` class,
     * which is a CSS-module token like `nArs4W_explorerDir` — matched on the
     * whole token so the similarly named `…_explorerDirChanged` (a change tint
     * on a row's LABEL, file rows included) is not mistaken for it.
     * @param row - the row element.
     * @returns whether the row is a directory.
     */
    function isDirectoryRow(row) {
      if (row.getAttribute('data-files-entry') === 'directory') return true
      const tokens = String(row.getAttribute('class') ?? '').split(/\s+/)
      return tokens.some((token) => token === 'explorerDir' || token.endsWith('_explorerDir'))
    }

    /** A file resource link, wherever the page renders one. */
    const LINK_SELECTOR = 'a[href^="dsh-resource://file/"]'

    /** Clickable controls that may NAME a path: chat file mentions, file chips. */
    const CONTROL_SELECTOR = 'button, a, [role="button"]'

    /**
     * The elements that represent ONE entry in a file tree, whichever tree drew
     * them: DSH's own files pane marks every row with `data-files-entry`, and the
     * Better Sidebar tree marks its rows with the `explorerRow` class (a CSS
     * module, so it is matched by substring — a renamed class degrades to "no
     * rows claimed", never to a wrong action).
     */
    const ROW_SELECTOR = '[data-files-entry], [class*="explorerRow"]'

    /**
     * Strip a chat file mention's grammar down to the path it names.
     *
     * DSH renders a file mention as a chip whose `title` is the reference as it
     * was TYPED, and that grammar quotes a path containing whitespace:
     * `@"AI Infra 计划可行性评估与修正补丁（2026-10-30）.md"`. The `@` prefix and the
     * quotes are punctuation of the mention, not part of the file name, so they
     * are removed here — otherwise resolution fails on a name that is perfectly
     * valid on disk.
     * @param value - the raw title.
     * @returns the path the mention names.
     */
    function stripMention(value) {
      let path = String(value).trim()
      if (path.startsWith('@')) path = path.slice(1)
      // A quoted mention may keep its opening quote only (an open directory).
      if (path.startsWith('"')) path = path.slice(1)
      if (path.endsWith('"')) path = path.slice(0, -1)
      return path.trim()
    }

    /**
     * Whether a tooltip reads as a filesystem path rather than a label.
     *
     * Chat file links carry the path in `title` and nothing else, and that path
     * is NOT always tidy: `AI Infra 计划可行性评估与修正补丁（2026-10-30）.md` is a
     * real file name with spaces and full-width brackets, and a mention of it is
     * quoted as `@"…"`. A rule that rejects whitespace therefore misses exactly
     * the documents people ask about, so the test is "ends like a file" rather
     * than "contains no spaces". Anything accepted here is still CONFIRMED by the
     * Host before it becomes an action, so a wrong guess costs a round trip,
     * never a wrong open.
     * @param text - the attribute value.
     * @returns whether it plausibly names a file.
     */
    function looksLikePath(text) {
      if (typeof text !== 'string') return false
      const value = stripMention(text)
      if (value === '' || value.length > 512) return false
      // A URL is not a local path.
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false
      // A sentence does not end in an extension: "Open right sidebar" is a label.
      // The name may carry spaces, CJK, and full-width punctuation.
      return /\.[A-Za-z0-9]{1,12}$/.test(value)
    }

    /** The plugin's own copy, in both shipped languages. */
    const COPY = {
      zh: {
        'menu.open': '打开文件',
        'menu.openWith': '打开方式',
        'menu.saveAs': '另存为…',
        'menu.copyPath': '复制路径',
        'menu.copyContents': '复制文件内容',
        'menu.reveal': '在资源管理器中打开',
        'error.openWith': '无法打开“打开方式”：{path}',
        'error.open': '无法打开：{path}',
        'error.reveal': '无法在资源管理器中显示：{path}',
        'error.copy': '复制失败',
        'error.read': '无法读取文件内容',
        'error.save': '无法保存副本',
      },
      en: {
        'menu.open': 'Open File',
        'menu.openWith': 'Open With',
        'menu.saveAs': 'Save As…',
        'menu.copyPath': 'Copy Path',
        'menu.copyContents': 'Copy File Contents',
        'menu.reveal': 'Reveal in File Explorer',
        'error.openWith': 'Could not show "Open with": {path}',
        'error.open': 'Could not open: {path}',
        'error.reveal': 'Could not reveal: {path}',
        'error.copy': 'Copy failed',
        'error.read': 'Could not read the file',
        'error.save': 'Could not save a copy',
      },
    }

    /** `{name}` interpolation. */
    function format(text, values) {
      if (values === undefined) return text
      return text.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
    }

    /** The basename of either separator spelling. */
    function baseName(path) {
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return cut === -1 ? path : path.slice(cut + 1)
    }

    /**
     * The path an event target stands for.
     *
     * It reads only STANDARD, semantic attributes — `data-files-path` and
     * `data-files-entry` (DSH's own files pane), a `dsh-resource://file/` link,
     * or a row `title` the tree sets to the entry's full path. Whatever it finds
     * is CONFIRMED by the Host before anything happens, so a tooltip or a
     * non-file row can cost a request but never a wrong action.
     * @param target - the event target.
     * @returns the row it belongs to, its named path when one is readable, and its kind.
     */
    function candidateOf(target) {
      if (target === null || typeof target !== 'object') return undefined
      const element = typeof target.closest === 'function'
        ? target
        : (target instanceof Element ? target : null)
      if (element === null) return undefined

      const link = element.closest(LINK_SELECTOR)
      if (link !== null) {
        return { path: link.getAttribute('href'), kind: 'file', element: link }
      }

      const row = element.closest(ROW_SELECTOR)
      if (row !== null) {
        if (isDirectoryRow(row)) return { path: undefined, kind: 'directory', element: row }
        const declared = row.getAttribute('data-files-path')
        if (typeof declared === 'string' && declared !== '') {
          return { path: declared, kind: 'file', element: row }
        }
        // The Better Sidebar tree has no data attribute; it puts the entry's full
        // path on the row's tooltip and nothing else. A row that is not a
        // directory is a FILE here: the tree only renders those two kinds, and a
        // third state would leave Ctrl+click doing nothing at all.
        const title = row.getAttribute('title')
        if (looksLikePath(title)) {
          return { path: stripMention(title), kind: 'file', element: row }
        }
        return { path: undefined, kind: 'file', element: row }
      }

      // A chat file mention names its path in `title` and carries no other
      // marker. Only a plain control is considered: a container's tooltip is a
      // label, not an address.
      const control = element.closest(CONTROL_SELECTOR)
      if (control !== null) {
        const title = control.getAttribute('title')
        if (looksLikePath(title)) {
          return { path: stripMention(title), kind: 'file', element: control }
        }
      }
      return undefined
    }

    /** Ask the Host half for one endpoint; a refusal carries its reason. */
    async function callHost(route, init) {
      const response = await fetch(`${ROUTE}/${route}`, init)
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload.ok !== true) {
        const reason = payload !== undefined && payload.error !== undefined ? payload.error.message : undefined
        throw new Error(typeof reason === 'string' ? reason : `HTTP ${response.status}`)
      }
      return payload
    }

    /** POST one path to a Host action. */
    function postPath(route, path, sessionId) {
      return callHost(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, session: sessionId ?? null }),
      })
    }

    /** Copy one string, through the clipboard API with a selection fallback. */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // Not the focused document: fall through to the selection path.
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        area.remove()
        return copied
      } catch {
        return false
      }
    }

    /** The stylesheet: one place, host theme tokens, no literal theme colours. */
    const CSS = `
.ac-layer {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  /* A backdrop, not coverage: clicks outside the menu reach the page below. */
  pointer-events: none;
}
.ac-menu {
  position: fixed;
  pointer-events: auto;
  min-width: 220px;
  max-width: 360px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-overlay, #ffffff);
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  color: var(--dsw-alias-label-primary, #1b1b1f);
  font-size: 13px;
  line-height: 20px;
  user-select: none;
  overflow-y: auto;
}
.ac-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 5px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
  white-space: nowrap;
}
.ac-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.ac-row:disabled { color: var(--dsw-alias-label-dimmed, rgba(27,27,31,.4)); }
.ac-icon { display: inline-flex; width: 16px; height: 16px; flex: none; align-items: center; justify-content: center; }
.ac-icon img { width: 16px; height: 16px; object-fit: contain; }
.ac-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
.ac-chevron { opacity: .55; }
.ac-separator { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l1, rgba(0,0,0,.1)); }
.ac-toast {
  position: fixed;
  left: 50%;
  bottom: 40px;
  transform: translateX(-50%);
  z-index: 2147483001;
  max-width: 60vw;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-overlay, #ffffff);
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  color: var(--dsw-alias-label-primary, #1b1b1f);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`

    /** One stroked glyph, sized for a menu row. */
    function glyph(children) {
      return h('span', { className: 'ac-icon' }, h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, children))
    }

    const ICON = {
      open: () => glyph([h('path', { key: 'a', d: 'M3.5 2.5h5l4 4v7h-9z' }), h('path', { key: 'b', d: 'M8.5 2.5v4h4' })]),
      openWith: () => glyph([h('path', { key: 'a', d: 'M2.5 8a5.5 5.5 0 1 1 2.1 4.3' }), h('path', { key: 'b', d: 'M2 5.6v3.2h3.2' })]),
      saveAs: () => glyph([h('path', { key: 'a', d: 'M8 2.5v7' }), h('path', { key: 'b', d: 'M5 6.8 8 9.8l3-3' }), h('path', { key: 'c', d: 'M2.5 12.5v1.2h11v-1.2' })]),
      copy: () => glyph([h('rect', { key: 'a', x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }), h('path', { key: 'b', d: 'M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2' })]),
      reveal: () => glyph([h('path', { key: 'a', d: 'M2.5 4.5h4l1.4 1.6h5.6v6.9h-11z' })]),
      chevron: () => h('span', { className: 'ac-icon ac-chevron' }, h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: 'm6 3.5 5 4.5-5 4.5' }))),
    }

    return {
      inject: ['slots', 'locale'],

      apply(ctx) {
        /** The active language, read fresh so a language switch follows. */
        const language = () => {
          let id = 'zh'
          try {
            const active = ctx.locale.getSnapshot().active
            if (typeof active === 'string' && active !== '') id = active
          } catch {
            id = 'zh'
          }
          return id.toLowerCase().startsWith('en') ? 'en' : 'zh'
        }

        const t = (key, values) => format(COPY[language()][key] ?? key, values)

        // The stylesheet lives as long as this activation.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', JSON.stringify('dsh-auto-click'))
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'dsh-auto-click: styles')

        /** The overlay's observable state. */
        const store = {
          state: { menu: null, toast: null },
          listeners: new Set(),
          set(next) {
            store.state = { ...store.state, ...next }
            for (const listener of store.listeners) listener()
          },
          subscribe(listener) {
            store.listeners.add(listener)
            return () => { store.listeners.delete(listener) }
          },
          snapshot() {
            return store.state
          },
        }

        /**
         * Report a FAILURE only.
         *
         * Successful operations are deliberately silent: copying a path is its own
         * confirmation, and a toast over the reader's work is noise. Only a
         * refused or failed action says anything.
         */
        let toastTimer
        const notify = (text) => {
          store.set({ toast: { text, at: Date.now() } })
          if (toastTimer !== undefined) clearTimeout(toastTimer)
          toastTimer = setTimeout(() => { store.set({ toast: null }) }, 3200)
        }
        ctx.effect(() => () => { if (toastTimer !== undefined) clearTimeout(toastTimer) }, 'dsh-auto-click: toast timer')

        /**
         * The Session on screen. A chat link's path is relative to THAT Session's
         * workspace, so the Host is told which one it is rather than guessing from
         * its own working directory.
         * @returns the Session id, or undefined when the column names none.
         */
        const onScreenSession = () => {
          try {
            const mounted = ctx.get('sidebarRight')?.mounted?.getSnapshot?.()
            if (typeof mounted === 'string' && mounted !== '') return mounted
          } catch {
            // No column on screen: fall back to the list below.
          }
          try {
            const byId = ctx.get('sessions')?.list?.getSnapshot?.()?.byId ?? {}
            const ids = Object.keys(byId)
            return ids.length === 1 ? ids[0] : undefined
          } catch {
            return undefined
          }
        }

        /** The query suffix naming the Session, or '' when none is known. */
        const sessionQuery = () => {
          const sessionId = onScreenSession()
          return typeof sessionId === 'string' && sessionId !== ''
            ? `&session=${encodeURIComponent(sessionId)}`
            : ''
        }

        /** What the Host says about one path; the answer is cached, so a hover warms the click. */
        const infoCache = new Map()
        const inFlight = new Map()
        const infoOf = (path, fresh) => {
          if (fresh !== true && infoCache.has(path)) return Promise.resolve(infoCache.get(path))
          if (fresh !== true && inFlight.has(path)) return inFlight.get(path)
          const request = callHost(`info?path=${encodeURIComponent(path)}${sessionQuery()}`).then(
            (payload) => {
              infoCache.set(path, payload)
              inFlight.delete(path)
              if (infoCache.size > 80) {
                const oldest = infoCache.keys().next()
                if (oldest.done !== true) infoCache.delete(oldest.value)
              }
              return payload
            },
            (error) => {
              inFlight.delete(path)
              throw error
            },
          )
          inFlight.set(path, request)
          return request
        }

        /** The answer already known for one path, when there is one. */
        const cachedInfo = (path) => (infoCache.has(path) ? infoCache.get(path) : undefined)

        /**
         * Show the operating system's own "Open with" chooser for one path.
         *
         * The plugin has no application list of its own: the shell dialog lists
         * every handler registered for the file, on any machine, which is what
         * the user expects and what no plugin can reproduce reliably.
         * @param path - the path to choose an application for.
         */
        const openWithChooser = async (path) => {
          try {
            await postPath('openwith', path, onScreenSession())
          } catch (error) {
            notify(`${t('error.openWith', { path })}${error !== undefined && error.message ? ` — ${error.message}` : ''}`)
          }
        }

        /**
         * Open a path with the desktop's default handler, or with one named
         * handler.
         *
         * With no handler named, a refusal from the desktop is not the end of the
         * gesture: a file type with no registered default (an uncommon extension,
         * or a handler that was uninstalled) still has handlers that CAN open it.
         * The "open with" menu is shown in that case, so Ctrl+click always ends in
         * either the file opening or a choice — never in silence.
         * @param path - the path to open.
         * @param application - an explicit handler id, when the user picked one.
         * @param x - fallback menu anchor X, when the desktop refuses.
         * @param y - fallback menu anchor Y.
         */
        const openExternally = async (path, application, x, y) => {
          const sessionId = onScreenSession()
          try {
            if (application === undefined) await postPath('open', path, sessionId)
            else {
              await callHost('open', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path, session: sessionId ?? null, application }),
              })
            }
          } catch (error) {
            // An explicit pick that fails is a real failure; the default handler
            // having none is a choice the user can still make.
            if (application !== undefined) {
              notify(`${t('error.open', { path })}${error !== undefined && error.message ? ` — ${error.message}` : ''}`)
              return
            }
            showMenu(path, cachedInfo(path), x, y)
          }
        }

        /** Reveal a path in the machine's file manager. */
        const revealPath = async (path) => {
          try {
            await postPath('reveal', path, onScreenSession())
          } catch (error) {
            notify(`${t('error.reveal', { path })}${error !== undefined && error.message ? ` — ${error.message}` : ''}`)
          }
        }

        /**
         * Copy the file's FULL path.
         *
         * A row or a chat link names a workspace-relative path
         * (`boss_ai_jobs/deliverables/x.html`); the copyable path is the absolute
         * one, which the Host resolved while answering this menu — `info.path`.
         * The named path is only the fallback for an answer that never arrived.
         * @param menu - the open menu whose path should be copied.
         */
        const copyPath = async (menu) => {
          const absolute = menu.info !== undefined && typeof menu.info.path === 'string'
            ? menu.info.path
            : menu.path
          // Copying silently is the point: no toast on success, only on failure.
          if (!await copyText(absolute)) notify(t('error.copy'))
        }

        /** Read one file through the Host half. */
        const readFile = async (path) => {
          const response = await fetch(`${ROUTE}/raw?path=${encodeURIComponent(path)}${sessionQuery()}`)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.blob()
        }

        /** Copy the file's text contents. */
        const copyContents = async (path) => {
          try {
            const text = await (await readFile(path)).text()
            if (!await copyText(text)) notify(t('error.copy'))
          } catch {
            notify(t('error.read'))
          }
        }

        /** Save a copy through the browser's own download, named after the file. */
        const saveAs = async (path) => {
          try {
            const blob = await readFile(path)
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = baseName(path)
            anchor.style.display = 'none'
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            setTimeout(() => { URL.revokeObjectURL(url) }, 20000)
          } catch {
            notify(t('error.save'))
          }
        }

        const hideMenu = () => { store.set({ menu: null }) }

        /**
         * Describe an element's own attributes for diagnosis, without leaking a
         * whole DOM subtree: tag, the data attributes a file tree would use, and
         * a bounded class list.
         * @param element - the element to describe.
         * @returns a short one-line description.
         */
        const describe = (element) => {
          if (element === null || element === undefined) return 'none'
          try {
            const tag = String(element.tagName || '?').toLowerCase()
            const entry = element.getAttribute?.('data-files-entry')
            const dataPath = element.getAttribute?.('data-files-path')
            const title = element.getAttribute?.('title')
            const href = element.getAttribute?.('href')
            const classes = String(element.className || '').slice(0, 120)
            return [
              tag,
              entry === null || entry === undefined ? '' : `entry=${entry}`,
              dataPath === null || dataPath === undefined ? '' : `dataPath=${dataPath.slice(0, 80)}`,
              title === null || title === undefined ? '' : `title=${String(title).slice(0, 80)}`,
              href === null || href === undefined ? '' : `href=${String(href).slice(0, 60)}`,
              classes === '' ? '' : `class=${classes}`,
            ].filter((part) => part !== '').join(' ')
          } catch {
            return 'unreadable'
          }
        }

        /** Report one gesture to the Host half; never awaited, never throws. */
        const report = (kind, candidate, decided, stage) => {
          try {
            const target = candidate === undefined ? undefined : candidate.element
            void fetch(`${ROUTE}/diag`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                kind,
                path: candidate === undefined ? null : candidate.path ?? null,
                target: describe(target ?? null),
                decided,
                stage,
              }),
            }).catch(() => undefined)
          } catch {
            // Diagnostics never break the gesture.
          }
        }

        /**
         * Open the menu immediately for one path.
         *
         * The panels render NOW — from whatever the cache already holds — and
         * the authoritative answer refreshes them when it arrives. Waiting for
         * the Host before showing anything would make a right click look like a
         * no-op for as long as one round trip takes, which is exactly the bug
         * this shape removes.
         * @param path - the path the row named.
         * @param info - the cached answer, when there is one.
         * @param x - click X.
         * @param y - click Y.
         */
        const showMenu = (path, info, x, y) => {
          store.set({ menu: { path, info, x, y } })
          void infoOf(path, true).then(
            (fresh) => {
              const current = store.snapshot().menu
              if (current === null || current.path !== path) return
              store.set({ menu: { ...current, info: fresh } })
            },
            () => undefined,
          )
        }

        /**
         * Ctrl/Cmd + left click hands a FILE to the desktop. A plain left click is
         * left to the page: both file trees already open a file in the sidebar,
         * and so does every file link, so the plugin only adds what is missing.
         *
         * The event is swallowed only for a target the Host has already confirmed
         * as a file, so a directory row keeps the tree's own Ctrl-click behavior.
         */
        /**
         * Ctrl/Cmd + left click opens the file with the desktop's DEFAULT
         * application — for every kind of file, a `.md` included.
         *
         * The default is prevented SYNCHRONOUSLY, before anything is awaited:
         * the trees read a modified click as "extend the selection" and would
         * otherwise go on to open the preview. Deferring that decision until the
         * Host answered is what let a `.md` row fall through to the sidebar, so
         * the gesture is claimed first and only the OPEN is asynchronous.
         *
         * A directory row is left entirely to the page, so the tree keeps its own
         * Ctrl-click selection behavior.
         */
        const onClick = (event) => {
          if (event.button !== 0) return
          if (event.ctrlKey !== true && event.metaKey !== true) return
          const candidate = candidateOf(event.target)
          if (candidate === undefined || candidate.kind === 'directory') return

          // Claim the click now, while it is still cancellable.
          event.preventDefault()
          event.stopPropagation()
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()

          if (candidate.path === undefined) return
          // The click point is the anchor when the desktop has no default handler
          // and the "open with" menu takes over.
          void openExternally(candidate.path, undefined, event.clientX, event.clientY)
        }

        /**
         * Right click opens the plugin's file menu — synchronously, from the
         * cache when one exists.
         *
         * DSH's own files pane already opens a context menu on every row, and it
         * listens in the same capture phase. Because the plugin cannot count on
         * running first, the menu is shown from the moment the event happens and
         * the row's kind is corrected afterwards: a directory the Host reports
         * is a directory closes the menu again. Swallowing a right click and
         * then deciding asynchronously is what turned this gesture into a no-op.
         */
        const onContextMenu = (event) => {
          const candidate = candidateOf(event.target)
          if (candidate === undefined) return
          if (candidate.kind === 'directory') return

          const known = cachedInfo(candidate.path)
          // A settled non-file answer is final: leave the event to the page.
          if (known !== undefined && known.isFile !== true) return
          if (candidate.path === undefined) return

          // The rows' own context menu must not open behind ours.
          event.preventDefault()
          event.stopPropagation()
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()

          const x = event.clientX
          const y = event.clientY
          showMenu(candidate.path, known, x, y)

          if (known === undefined) {
            // The panels are up already; this only corrects a wrong claim. A
            // failed round trip is SAID, never swallowed: a right click that
            // opens nothing and explains nothing is the bug this replaced.
            void infoOf(candidate.path, true).then(
              (info) => {
                if (info.isFile === true) return undefined
                const current = store.snapshot().menu
                if (current !== null && current.path === candidate.path) hideMenu()
                return undefined
              },
              (error) => {
                report('contextmenu', candidate, 'info-failed', String(error?.message ?? error))
                notify(`${t('error.read')} — ${String(error?.message ?? error)}`)
              },
            )
          }
        }

        /**
         * Warm the answer cache on hover, so the click that follows takes the
         * synchronous branch and a directory row is already known to be one.
         */
        const onPointerOver = (event) => {
          const candidate = candidateOf(event.target)
          if (candidate === undefined || candidate.path === undefined) return
          if (candidate.kind === 'directory') return
          if (infoCache.has(candidate.path) || inFlight.has(candidate.path)) return
          void infoOf(candidate.path).catch(() => undefined)
        }

        ctx.effect(() => {
          document.addEventListener('click', onClick, true)
          document.addEventListener('contextmenu', onContextMenu, true)
          document.addEventListener('pointerover', onPointerOver, true)
          return () => {
            document.removeEventListener('click', onClick, true)
            document.removeEventListener('contextmenu', onContextMenu, true)
            document.removeEventListener('pointerover', onPointerOver, true)
          }
        }, 'dsh-auto-click: row gestures')

        /** One menu row. */
        const menuRow = (props) => h('button', {
          key: props.id,
          type: 'button',
          className: 'ac-row',
          role: 'menuitem',
          disabled: props.disabled === true,
          onMouseEnter: props.onHover,
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            if (props.onSelect !== undefined) props.onSelect()
          },
        }, props.icon ?? null, h('span', { className: 'ac-label' }, props.label), props.trailing ?? null)

        /** Keep a floating panel inside the viewport. */
        const placeAt = (x, y, width, height) => {
          const margin = 8
          const left = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin))
          const top = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin))
          return { left, top, maxHeight: Math.max(180, window.innerHeight - top - margin) }
        }

        /** The overlay: the flat file menu, plus the failure line. */
        function AutoClickOverlay() {
          const state = React.useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
          const menu = state.menu
          const toast = state.toast
          const menuRef = React.useRef(null)

          React.useEffect(() => {
            if (menu === null) return undefined
            const onKeyDown = (event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              hideMenu()
            }
            const onPointerDown = (event) => {
              if (menuRef.current !== null && menuRef.current.contains(event.target)) return
              hideMenu()
            }
            document.addEventListener('keydown', onKeyDown, true)
            document.addEventListener('mousedown', onPointerDown, true)
            window.addEventListener('blur', hideMenu)
            window.addEventListener('resize', hideMenu)
            return () => {
              document.removeEventListener('keydown', onKeyDown, true)
              document.removeEventListener('mousedown', onPointerDown, true)
              window.removeEventListener('blur', hideMenu)
              window.removeEventListener('resize', hideMenu)
            }
          }, [menu])

          if (menu === null && toast === null) return null

          /** Run one action and close the menu in the same gesture. */
          const choose = (action) => () => {
            hideMenu()
            void action()
          }

          const rows = []
          if (menu !== null) {
            rows.push(menuRow({
              id: 'open',
              label: t('menu.open'),
              icon: ICON.open(),
              onSelect: choose(() => openExternally(menu.path)),
            }))
            rows.push(menuRow({
              id: 'openWith',
              label: t('menu.openWith'),
              icon: ICON.openWith(),
              onSelect: choose(() => openWithChooser(menu.path)),
            }))
            rows.push(h('div', { key: 'sep-a', className: 'ac-separator' }))
            rows.push(menuRow({ id: 'saveAs', label: t('menu.saveAs'), icon: ICON.saveAs(), onSelect: choose(() => saveAs(menu.path)) }))
            rows.push(menuRow({ id: 'copyPath', label: t('menu.copyPath'), icon: ICON.copy(), onSelect: choose(() => copyPath(menu)) }))
            rows.push(menuRow({ id: 'copyContents', label: t('menu.copyContents'), icon: ICON.copy(), onSelect: choose(() => copyContents(menu.path)) }))
            rows.push(h('div', { key: 'sep-b', className: 'ac-separator' }))
            rows.push(menuRow({ id: 'reveal', label: t('menu.reveal'), icon: ICON.reveal(), onSelect: choose(() => revealPath(menu.path)) }))
          }

          const menuBox = menu === null ? null : (() => {
            const spot = placeAt(menu.x, menu.y, 236, 260)
            return h('div', {
              ref: menuRef,
              className: 'ac-menu',
              role: 'menu',
              style: { left: spot.left, top: spot.top, maxHeight: spot.maxHeight },
            }, rows)
          })()

          return h(React.Fragment, null,
            menu === null ? null : h('div', {
              className: 'ac-layer',
              // The layer is a backdrop, not coverage: a click outside the menu
              // must reach the page, so pointer events pass straight through it
              // and only the panel itself opts back in.
              onContextMenu: (event) => { event.preventDefault() },
            }, menuBox),
            toast === null ? null : h('div', { className: 'ac-toast', role: 'status' }, toast.text),
          )
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'auto-click-file-menu',
          order: 40,
          label: () => t('menu.open'),
        }, AutoClickOverlay))
      },
    }
  },
})
