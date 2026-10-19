/**
 * dsh-image-gen — Client half.
 *
 * Two seats, one store:
 *
 * - `conversation.input.dock`: a single status pill — connection, model, and a
 *   click to re-check. No form lives above the composer any more.
 * - `settings.section`: the whole settings page, opened from the settings panel
 *   at the bottom-left avatar. Endpoint, model, launcher + start, output folder,
 *   always-on positive/negative prompt, LoRA / embedding / hypernetwork, and the
 *   generation defaults — all saved into the plugin's `save` file.
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-gen',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/image-gen'

    const DICT = {
      zh: {
        sectionTitle: '小鲸鱼画板',
        pillLabel: '绘图',
        pillTitle: '点击重新检查绘图接口；设置请到 左下角头像 → 设置 → 小鲸鱼画板',
        secConnection: '连接',
        secModel: '模型',
        secLaunch: '启动',
        secOutput: '输出',
        secPrompt: '提示词与风格模型',
        secDefaults: '生成默认值',
        endpoint: '绘图接口地址',
        endpointNote: 'Stable Diffusion WebUI / Forge 的地址，需要带 --api 启动。',
        model: '模型',
        launcher: '应用启动路径',
        launcherPlaceholder: 'F:\\sd-webui-forge-aki-v1.0\\webui-user.bat',
        launch: '▶ 启动',
        starting: '启动中…',
        launched: '已启动',
        already: '已在运行',
        launchFailed: '启动失败',
        launchNote: '支持 .bat / .cmd / .ps1 / .py / .exe；会在独立窗口里拉起，并等到接口可用。',
        saveDir: '保存到',
        saveDirPlaceholder: '选一个文件夹（留空则只存插件相册）',
        browse: '浏览…',
        pickUnavailable: '目录选择不可用，直接填路径吧',
        saveDirNote: '每张出图会在这里再存一份同字节副本；留空 = 只存插件相册。',
        alwaysPrompt: '必加词',
        alwaysPromptPlaceholder: '每张图都会带上（留空 = 不加），如 masterpiece, best quality',
        alwaysNegative: '必加反向词',
        alwaysNegativePlaceholder: '每张图都会带上（留空 = 不加），如 bad hands, extra fingers',
        lora: 'LoRA',
        weight: '权重',
        embedding: '嵌入',
        hypernetwork: '超网络',
        none: '（无）',
        extrasScanning: '扫描中…',
        rescanExtras: '重新扫描 LoRA / 嵌入 / 超网络',
        defaults: '尺寸',
        steps: '步数',
        cfg: 'CFG',
        defaultsNote: '调用没显式指定时用这组默认值。',
        save: '保存设置',
        saved: '已保存',
        unsaved: '有未保存的修改',
        checking: '检查中…',
        online: '已连接',
        offline: '未连接',
        check: '重新检查',
        loading: '读取中…',
        scanning: '扫描模型…',
        switching: '切换模型中…',
        rescan: '重新扫描模型',
        count: '共 {n} 个模型',
        empty: '没有扫描到模型',
        invalid: '地址无效',
        files: '设置文件',
        gallery: '插件相册',
      },
      en: {
        sectionTitle: 'Whale Canvas',
        pillLabel: 'Image',
        pillTitle: 'Click to re-check the image endpoint; settings live in Settings → Whale Canvas',
        secConnection: 'Connection',
        secModel: 'Model',
        secLaunch: 'Startup',
        secOutput: 'Output',
        secPrompt: 'Prompt & style models',
        secDefaults: 'Generation defaults',
        endpoint: 'Endpoint',
        endpointNote: 'Address of your Stable Diffusion WebUI / Forge (started with --api).',
        model: 'Model',
        launcher: 'Launcher path',
        launcherPlaceholder: 'C:\\path\\to\\webui-user.bat',
        launch: '▶ Start',
        starting: 'Starting…',
        launched: 'Started',
        already: 'Already running',
        launchFailed: 'Launch failed',
        launchNote: 'Supports .bat / .cmd / .ps1 / .py / .exe; runs in its own window and waits for the API.',
        saveDir: 'Save to',
        saveDirPlaceholder: 'Pick a folder (empty = plugin gallery only)',
        browse: 'Browse…',
        pickUnavailable: 'Folder picker unavailable; type the path instead',
        saveDirNote: 'Every picture gets a byte-identical copy here; empty = plugin gallery only.',
        alwaysPrompt: 'Always add',
        alwaysPromptPlaceholder: 'Added to every prompt (empty = none), e.g. masterpiece, best quality',
        alwaysNegative: 'Always negative',
        alwaysNegativePlaceholder: 'Added to every negative prompt (empty = none)',
        lora: 'LoRA',
        weight: 'Weight',
        embedding: 'Embedding',
        hypernetwork: 'Hypernet',
        none: '(none)',
        extrasScanning: 'Scanning…',
        rescanExtras: 'Rescan LoRAs, embeddings and hypernetworks',
        defaults: 'Size',
        steps: 'Steps',
        cfg: 'CFG',
        defaultsNote: 'Used when a call does not pass its own values.',
        save: 'Save settings',
        saved: 'Saved',
        unsaved: 'Unsaved changes',
        checking: 'Checking…',
        online: 'Connected',
        offline: 'Offline',
        check: 'Check again',
        loading: 'Loading…',
        scanning: 'Scanning models…',
        switching: 'Switching model…',
        rescan: 'Rescan models',
        count: '{n} models',
        empty: 'No models found',
        invalid: 'Invalid address',
        files: 'Settings file',
        gallery: 'Plugin gallery',
      },
    }

    let translate = (key) => DICT.en[key] ?? key
    let localeService = null
    let hostCtx = null

    /** Listeners that re-read settings after a save, so the pill stays in sync. */
    const listeners = new Set()
    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // A dead listener must not break the save that just succeeded.
        }
      }
    }
    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    const CSS = `
[data-ig-pill-row]{display:flex;justify-content:center;padding:2px 12px 8px;font-family:inherit;}
[data-ig-pill]{display:inline-flex;align-items:center;gap:7px;max-width:100%;box-sizing:border-box;
  padding:2px 10px;border-radius:999px;font-size:11px;line-height:18px;cursor:pointer;font-family:inherit;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));transition:background .15s,border-color .15s;}
[data-ig-pill]:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.16));
  border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.3));}
[data-ig-pill-face]{flex:none;opacity:.9;}
[data-ig-pill-label]{flex:none;font-weight:500;color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-ig-pill-status]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-ig-pill-dot]{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#8a8f98);}
[data-ig-pill-dot][data-state="ok"]{background:var(--dsw-alias-state-success-primary,#22c55e);}
[data-ig-pill-dot][data-state="bad"]{background:var(--dsw-alias-state-error-primary,#ef4444);}
[data-ig-pill-dot][data-state="busy"]{background:var(--dsw-alias-state-warn-primary,#f59e0b);}

[data-ig-page]{display:flex;flex-direction:column;gap:20px;max-width:640px;padding:2px 2px 28px;font-family:inherit;}
[data-ig-sec]{display:flex;flex-direction:column;gap:10px;}
[data-ig-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ig-field]{display:flex;flex-direction:column;gap:4px;}
[data-ig-field-label]{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e5e7eb);}
[data-ig-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ig-line]{display:flex;align-items:center;gap:8px;}
[data-ig-input],[data-ig-select]{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:6px 9px;border-radius:8px;
  font-size:12px;line-height:18px;font-family:inherit;color:inherit;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));outline:none;}
[data-ig-select]{cursor:pointer;}
[data-ig-input]:focus,[data-ig-select]:focus{border-color:var(--dsw-alias-brand-primary,#3b82f6);}
[data-ig-input]::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ig-num]{flex:0 0 84px;width:84px;text-align:center;}
[data-ig-btn]{flex:none;padding:6px 12px;border-radius:8px;font-size:12px;line-height:18px;cursor:pointer;
  font-family:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));}
[data-ig-btn]:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.22));}
[data-ig-btn][disabled]{opacity:.5;cursor:default;}
[data-ig-btn][data-primary]{background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;border-color:transparent;}
[data-ig-status]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-ig-dot]{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#8a8f98);}
[data-ig-dot][data-state="ok"]{background:var(--dsw-alias-state-success-primary,#22c55e);}
[data-ig-dot][data-state="bad"]{background:var(--dsw-alias-state-error-primary,#ef4444);}
[data-ig-dot][data-state="busy"]{background:var(--dsw-alias-state-warn-primary,#f59e0b);}
[data-ig-msg]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-ig-msg][data-warn]{color:var(--dsw-alias-state-warn-primary,#f59e0b);}
[data-ig-msg][data-good]{color:var(--dsw-alias-state-success-primary,#22c55e);}
[data-ig-foot]{display:flex;align-items:center;gap:12px;padding-top:12px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));}
[data-ig-kv]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
`

    async function requestJson(url, init) {
      const response = await fetch(url, { credentials: 'same-origin', ...init })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
      return body
    }

    /** Server snapshot → editable draft; numeric fields stay strings for inputs. */
    function draftFrom(data) {
      return {
        endpoint: data?.endpoint ?? '',
        launcher: data?.launcher ?? '',
        saveDir: data?.saveDir ?? '',
        alwaysPrompt: data?.alwaysPrompt ?? '',
        alwaysNegative: data?.alwaysNegative ?? '',
        lora: data?.lora ?? '',
        loraWeight: String(data?.loraWeight ?? 0.8),
        embedding: data?.embedding ?? '',
        hypernetwork: data?.hypernetwork ?? '',
        defaultWidth: String(data?.defaultWidth ?? 512),
        defaultHeight: String(data?.defaultHeight ?? 768),
        defaultSteps: String(data?.defaultSteps ?? 28),
        defaultCfg: String(data?.defaultCfg ?? 7),
      }
    }

    const TEXT_KEYS = ['endpoint', 'launcher', 'saveDir', 'alwaysPrompt', 'alwaysNegative', 'lora', 'embedding', 'hypernetwork']
    const NUMBER_KEYS = ['loraWeight', 'defaultWidth', 'defaultHeight', 'defaultSteps', 'defaultCfg']

    function isDirty(draft, snapshot) {
      if (snapshot === null) return false
      const saved = draftFrom(snapshot)
      for (const key of TEXT_KEYS) {
        if (String(draft[key] ?? '').trim() !== String(saved[key] ?? '').trim()) return true
      }
      for (const key of NUMBER_KEYS) {
        if ((Number(draft[key]) || 0) !== (Number(saved[key]) || 0)) return true
      }
      return false
    }

    /** One store for both seats: the settings page edits, the pill reports. */
    function useImageGen() {
      const t = translate
      const [snapshot, setSnapshot] = React.useState(null)
      const [draft, setDraft] = React.useState(() => draftFrom(null))
      const [phase, setPhase] = React.useState('loading')
      const [message, setMessage] = React.useState('')
      const [models, setModels] = React.useState([])
      const [modelPhase, setModelPhase] = React.useState('idle')
      const [modelError, setModelError] = React.useState('')
      const [extras, setExtras] = React.useState({ loras: [], embeddings: [], hypernetworks: [] })
      const [extrasPhase, setExtrasPhase] = React.useState('idle')
      const [extrasError, setExtrasError] = React.useState('')
      const [startPhase, setStartPhase] = React.useState('idle')
      const [startMessage, setStartMessage] = React.useState('')
      const [dirMessage, setDirMessage] = React.useState('')

      const patch = React.useCallback((next) => {
        setDraft((previous) => ({ ...previous, ...next }))
      }, [])

      const loadSettings = React.useCallback(async () => {
        try {
          const data = await requestJson(`${API}/settings`)
          setSnapshot(data)
          setDraft(draftFrom(data))
          setPhase('ready')
          setMessage('')
        } catch (error) {
          setPhase('error')
          setMessage(error?.message ?? String(error))
        }
      }, [])

      const loadModels = React.useCallback(async () => {
        setModelPhase('loading')
        setModelError('')
        try {
          const data = await requestJson(`${API}/models`)
          const list = Array.isArray(data?.models) ? data.models : []
          setModels(list.map((entry) => (typeof entry === 'string' ? { id: entry, label: entry } : entry)))
          if (typeof data?.model === 'string' && data.model.length > 0) {
            setSnapshot((previous) => ({ ...(previous ?? {}), model: data.model }))
          }
          if (data?.ok === false) setModelError(data?.error || '')
          setModelPhase('ready')
        } catch (error) {
          setModelError(error?.message ?? String(error))
          setModelPhase('error')
        }
      }, [])

      const loadExtras = React.useCallback(async () => {
        setExtrasPhase('loading')
        setExtrasError('')
        try {
          const data = await requestJson(`${API}/extras`)
          setExtras({
            loras: Array.isArray(data?.loras) ? data.loras : [],
            embeddings: Array.isArray(data?.embeddings) ? data.embeddings : [],
            hypernetworks: Array.isArray(data?.hypernetworks) ? data.hypernetworks : [],
          })
          if (typeof data?.error === 'string' && data.error.length > 0) setExtrasError(data.error)
          setExtrasPhase('ready')
        } catch (error) {
          setExtrasError(error?.message ?? String(error))
          setExtrasPhase('error')
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          await loadSettings()
          if (!alive) return
          loadModels()
          loadExtras()
        })()
        const unsubscribe = subscribe(() => {
          if (alive) loadSettings()
        })
        return () => {
          alive = false
          unsubscribe()
        }
      }, [loadExtras, loadModels, loadSettings])

      // Locale switches should relabel whatever is already on screen.
      const [, setLocaleRevision] = React.useState(0)
      React.useEffect(() => {
        if (localeService === null || typeof localeService.subscribe !== 'function') return undefined
        return localeService.subscribe(() => setLocaleRevision((value) => value + 1))
      }, [])

      const payload = React.useCallback(
        (overrides = {}) => ({
          endpoint: draft.endpoint.trim(),
          launcher: draft.launcher.trim(),
          saveDir: draft.saveDir.trim(),
          alwaysPrompt: draft.alwaysPrompt.trim(),
          alwaysNegative: draft.alwaysNegative.trim(),
          lora: draft.lora,
          loraWeight: Number(draft.loraWeight) || 0,
          embedding: draft.embedding,
          hypernetwork: draft.hypernetwork,
          defaultWidth: Number(draft.defaultWidth) || 512,
          defaultHeight: Number(draft.defaultHeight) || 768,
          defaultSteps: Number(draft.defaultSteps) || 28,
          defaultCfg: Number(draft.defaultCfg) || 7,
          ...overrides,
        }),
        [draft],
      )

      /** Persist every field; resolves to the fresh snapshot or throws. */
      const persist = React.useCallback(
        async (overrides = {}) => {
          const body = payload(overrides)
          if (body.endpoint === '') throw new Error(t('invalid'))
          const data = await requestJson(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          setSnapshot(data)
          setDraft(draftFrom(data))
          notify()
          return data
        },
        [payload, t],
      )

      const check = React.useCallback(async () => {
        setPhase('checking')
        setMessage('')
        try {
          const data = await requestJson(`${API}/check`, { method: 'POST' })
          setSnapshot(data)
          setDraft(draftFrom(data))
          setPhase('ready')
          loadModels()
          loadExtras()
        } catch (error) {
          setPhase('error')
          setMessage(error?.message ?? String(error))
        }
      }, [loadExtras, loadModels])

      const save = React.useCallback(async () => {
        setPhase('saving')
        setMessage('')
        try {
          await persist()
          setPhase('ready')
          setMessage(t('saved'))
          loadModels()
        } catch (error) {
          setPhase('ready')
          setMessage(error?.message ?? String(error))
        }
      }, [loadModels, persist, t])

      const switchModel = React.useCallback(async (name) => {
        if (typeof name !== 'string' || name.length === 0) return
        setModelPhase('switching')
        setModelError('')
        try {
          const data = await requestJson(`${API}/model`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          })
          if (Array.isArray(data?.models)) {
            setModels(data.models.map((entry) => (typeof entry === 'string' ? { id: entry, label: entry } : entry)))
          }
          setSnapshot((previous) => ({ ...(previous ?? {}), model: data?.model ?? name }))
          setModelPhase('ready')
        } catch (error) {
          setModelPhase('ready')
          setModelError(error?.message ?? String(error))
        }
      }, [])

      const start = React.useCallback(async () => {
        const launcherPath = draft.launcher.trim()
        if (launcherPath.length === 0) {
          setStartMessage(t('launcherPlaceholder'))
          return
        }
        setStartPhase('starting')
        setStartMessage('')
        try {
          await persist({ launcher: launcherPath })
          const data = await requestJson(`${API}/launch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ launcher: launcherPath }),
          })
          setStartPhase('idle')
          setStartMessage(data.already ? t('already') : data.ok ? t('launched') : data.error || t('launchFailed'))
          check()
        } catch (error) {
          setStartPhase('idle')
          setStartMessage(error?.message ?? String(error))
        }
      }, [check, draft.launcher, persist, t])

      const browse = React.useCallback(async () => {
        const svc = hostCtx !== null && typeof hostCtx.get === 'function' ? hostCtx.get('uiWorkspace') : undefined
        if (svc === null || svc === undefined || typeof svc.pickDirectory !== 'function') {
          setDirMessage(t('pickUnavailable'))
          return
        }
        setDirMessage('')
        try {
          const picked = await svc.pickDirectory()
          if (typeof picked !== 'string' || picked.length === 0) return
          patch({ saveDir: picked })
          await persist({ saveDir: picked })
          setDirMessage(t('saved'))
        } catch (error) {
          setDirMessage(error?.message ?? String(error))
        }
      }, [patch, persist, t])

      return {
        t,
        snapshot,
        draft,
        patch,
        phase,
        message,
        models,
        modelPhase,
        modelError,
        extras,
        extrasPhase,
        extrasError,
        startPhase,
        startMessage,
        dirMessage,
        dirty: isDirty(draft, snapshot),
        check,
        save,
        start,
        browse,
        loadModels,
        loadExtras,
        switchModel,
      }
    }

    /* ─────────────────────────── the status pill ─────────────────────────── */

    function StatusPill() {
      const s = useImageGen()
      const model = s.snapshot?.model ?? ''
      const reachable = s.snapshot?.reachable === true
      const busy = s.phase === 'loading' || s.phase === 'checking'
      const dotState = busy ? 'busy' : reachable ? 'ok' : 'bad'
      const face = busy ? '(￣▽￣)ゞ' : reachable ? '(๑•̀ㅂ•́)و✧' : '(｡•́︿•̀｡)'
      return h(
        'div',
        { 'data-ig-pill-row': '' },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            'data-ig-pill': '',
            title: `${s.t('pillTitle')}\n${s.snapshot?.endpoint ?? ''}`,
            onClick: s.check,
          },
          h('span', { 'data-ig-pill-face': '', 'aria-hidden': true }, face),
          h('span', { 'data-ig-pill-label': '' }, s.t('pillLabel')),
          h('span', { 'data-ig-pill-dot': '', 'data-state': dotState }),
          h(
            'span',
            { 'data-ig-pill-status': '' },
            reachable ? s.t('online') : s.t('offline'),
            model ? ` · ${model}` : '',
          ),
        ),
      )
    }

    /* ────────────────────────── the settings page ────────────────────────── */

    function SettingsPage() {
      const s = useImageGen()
      const t = s.t
      const snapshot = s.snapshot
      const draft = s.draft
      const reachable = snapshot?.reachable === true
      const currentModel = snapshot?.model ?? ''
      const busy = s.phase === 'loading' || s.phase === 'checking' || s.phase === 'saving'
      const dotState = busy ? 'busy' : reachable ? 'ok' : 'bad'

      const options = currentModel.length > 0 && !s.models.some((entry) => entry.id === currentModel)
        ? [{ id: currentModel, label: currentModel }, ...s.models]
        : s.models
      const extrasHint = s.extrasPhase === 'loading'
        ? t('extrasScanning')
        : s.extrasError
          ? s.extrasError
          : `L${s.extras.loras.length} · E${s.extras.embeddings.length} · H${s.extras.hypernetworks.length}`

      const field = (label, note, control) =>
        h(
          'div',
          { 'data-ig-field': '' },
          h('span', { 'data-ig-field-label': '' }, label),
          control,
          note ? h('span', { 'data-ig-note': '' }, note) : null,
        )

      const textInput = (key, placeholder, onEnter) =>
        h('input', {
          'data-ig-input': '',
          value: draft[key],
          placeholder,
          spellCheck: false,
          'aria-label': placeholder,
          onChange: (event) => s.patch({ [key]: event.target.value }),
          onKeyDown: onEnter
            ? (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onEnter()
                }
              }
            : undefined,
        })

      const select = (key, names) =>
        h(
          'select',
          {
            'data-ig-select': '',
            value: draft[key],
            'aria-label': key,
            onChange: (event) => s.patch({ [key]: event.target.value }),
          },
          h('option', { value: '' }, t('none')),
          names.map((name) => h('option', { key: name, value: name }, name)),
        )

      const statusLine = h(
        'div',
        { 'data-ig-status': '' },
        h('span', { 'data-ig-dot': '', 'data-state': dotState }),
        h(
          'span',
          null,
          reachable ? t('online') : t('offline'),
          currentModel ? ` · ${currentModel}` : '',
          snapshot?.endpoint ? ` · ${snapshot.endpoint}` : '',
        ),
        h(
          'button',
          { type: 'button', 'data-ig-btn': '', onClick: s.check, disabled: busy },
          s.phase === 'checking' ? t('checking') : t('check'),
        ),
      )

      const numberInput = (key, ariaLabel, extra) =>
        h('input', {
          'data-ig-input': '',
          'data-ig-num': '',
          type: 'number',
          'aria-label': ariaLabel,
          value: draft[key],
          onChange: (event) => s.patch({ [key]: event.target.value }),
          ...extra,
        })

      return h(
        'div',
        { 'data-ig-page': '' },
        h('style', null, CSS),

        h(
          'div',
          { 'data-ig-sec': '' },
          h('div', { 'data-ig-h': '' }, t('secConnection')),
          statusLine,
          field(t('endpoint'), t('endpointNote'), textInput('endpoint', 'http://127.0.0.1:7860', s.save)),
        ),

        h(
          'div',
          { 'data-ig-sec': '' },
          h('div', { 'data-ig-h': '' }, t('secModel')),
          h(
            'div',
            { 'data-ig-line': '' },
            h(
              'select',
              {
                'data-ig-select': '',
                value: currentModel,
                'aria-label': t('model'),
                disabled: s.modelPhase === 'switching' || options.length === 0,
                onChange: (event) => s.switchModel(event.target.value),
              },
              options.length === 0
                ? h('option', { value: '' }, t('scanning'))
                : options.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
            ),
            h(
              'button',
              {
                type: 'button',
                'data-ig-btn': '',
                title: t('rescan'),
                'aria-label': t('rescan'),
                disabled: s.modelPhase === 'loading' || s.modelPhase === 'switching',
                onClick: s.loadModels,
              },
              '↻',
            ),
            h(
              'span',
              { 'data-ig-msg': '', title: s.modelError || '' },
              s.modelPhase === 'loading'
                ? t('scanning')
                : s.modelPhase === 'switching'
                  ? t('switching')
                  : s.modelError || t('count').replace('{n}', String(options.length)),
            ),
          ),
        ),

        h(
          'div',
          { 'data-ig-sec': '' },
          h('div', { 'data-ig-h': '' }, t('secLaunch')),
          field(
            t('launcher'),
            t('launchNote'),
            h(
              'div',
              { 'data-ig-line': '' },
              textInput('launcher', t('launcherPlaceholder'), s.start),
              h(
                'button',
                {
                  type: 'button',
                  'data-ig-btn': '',
                  onClick: s.start,
                  disabled: s.startPhase === 'starting' || draft.launcher.trim().length === 0,
                },
                s.startPhase === 'starting' ? t('starting') : t('launch'),
              ),
            ),
          ),
          s.startMessage ? h('span', { 'data-ig-msg': '', 'data-good': '' }, s.startMessage) : null,
        ),

        h(
          'div',
          { 'data-ig-sec': '' },
          h('div', { 'data-ig-h': '' }, t('secOutput')),
          field(
            t('saveDir'),
            t('saveDirNote'),
            h(
              'div',
              { 'data-ig-line': '' },
              textInput('saveDir', t('saveDirPlaceholder'), s.save),
              h('button', { type: 'button', 'data-ig-btn': '', onClick: s.browse }, t('browse')),
            ),
          ),
          s.dirMessage ? h('span', { 'data-ig-msg': '', 'data-good': '' }, s.dirMessage) : null,
        ),

        h(
          'div',
          { 'data-ig-sec': '' },
          h('div', { 'data-ig-h': '' }, t('secPrompt')),
          field(t('alwaysPrompt'), null, textInput('alwaysPrompt', t('alwaysPromptPlaceholder'), s.save)),
          field(t('alwaysNegative'), null, textInput('alwaysNegative', t('alwaysNegativePlaceholder'), s.save)),
          field(
            t('lora'),
            null,
            h(
              'div',
              { 'data-ig-line': '' },
              select('lora', s.extras.loras),
              numberInput('loraWeight', t('weight'), { min: 0, max: 2, step: 0.05, title: t('weight') }),
              h(
                'button',
                {
                  type: 'button',
                  'data-ig-btn': '',
                  title: t('rescanExtras'),
                  'aria-label': t('rescanExtras'),
                  disabled: s.extrasPhase === 'loading',
                  onClick: s.loadExtras,
                },
                '↻',
              ),
            ),
          ),
          h(
            'div',
            { 'data-ig-line': '' },
            h('span', { 'data-ig-field-label': '' }, t('embedding')),
            select('embedding', s.extras.embeddings),
          ),
          h(
            'div',
            { 'data-ig-line': '' },
            h('span', { 'data-ig-field-label': '' }, t('hypernetwork')),
            select('hypernetwork', s.extras.hypernetworks),
          ),
          h('span', { 'data-ig-msg': '', title: extrasHint }, extrasHint),
        ),

        h(
          'div',
          { 'data-ig-sec': '' },
          h('div', { 'data-ig-h': '' }, t('secDefaults')),
          h(
            'div',
            { 'data-ig-line': '' },
            h('span', { 'data-ig-field-label': '' }, t('defaults')),
            numberInput('defaultWidth', `${t('defaults')} W`, { min: 64, max: 2048, step: 64 }),
            h('span', { 'data-ig-note': '' }, '×'),
            numberInput('defaultHeight', `${t('defaults')} H`, { min: 64, max: 2048, step: 64 }),
            h('span', { 'data-ig-field-label': '' }, t('steps')),
            numberInput('defaultSteps', t('steps'), { min: 1, max: 150 }),
            h('span', { 'data-ig-field-label': '' }, t('cfg')),
            numberInput('defaultCfg', t('cfg'), { min: 1, max: 30, step: 0.5 }),
          ),
          h('span', { 'data-ig-note': '' }, t('defaultsNote')),
        ),

        h(
          'div',
          { 'data-ig-foot': '' },
          h(
            'button',
            {
              type: 'button',
              'data-ig-btn': '',
              'data-primary': '',
              onClick: s.save,
              disabled: s.phase === 'saving',
            },
            s.phase === 'saving' ? t('loading') : t('save'),
          ),
          h(
            'span',
            {
              'data-ig-msg': '',
              'data-good': !s.dirty && s.message === t('saved') ? '' : undefined,
              'data-warn': s.dirty ? '' : undefined,
            },
            s.dirty ? t('unsaved') : s.message || t('saved'),
          ),
        ),

        h(
          'div',
          { 'data-ig-sec': '' },
          h('div', { 'data-ig-kv': '' }, `${t('files')}: ${snapshot?.settingsFile ?? ''}`),
          h('div', { 'data-ig-kv': '' }, `${t('gallery')}: ${snapshot?.galleryDir ?? ''}`),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        hostCtx = ctx
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
            localeService = locale
            for (const id of ['zh', 'en']) {
              try {
                locale.register('image-gen', id, DICT[id])
              } catch {
                // Another instance already registered the namespace; keep that one.
              }
            }
            if (typeof locale.bind === 'function') {
              const bound = locale.bind('image-gen')
              translate = (key) => {
                try {
                  const text = bound(key)
                  return typeof text === 'string' && text.length > 0 ? text : (DICT.en[key] ?? key)
                } catch {
                  return DICT.en[key] ?? key
                }
              }
            }
          }
        } catch {
          // No locale service: the English dictionary is a complete fallback.
        }

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'image-gen',
              order: 120,
            },
            StatusPill,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'image-gen',
              order: 50,
              label: () => translate('sectionTitle'),
            },
            SettingsPage,
          ),
        )
      },
    }
  },
})
