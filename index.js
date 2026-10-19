/**
 * dsh-image-gen — Host half.
 *
 * Two agent tools plus one HTTP route:
 *
 * - `generate_image`  turns a prompt into pixels through a local Stable
 *   Diffusion WebUI / Forge API, stores each result as a durable attachment, and
 *   returns image content blocks so the picture appears in the conversation and
 *   the model sees it.
 * - `image_gen_info`  reports whether the service answers and which checkpoint
 *   and samplers it currently offers — the model needs that to write a prompt
 *   that matches the model in use (anime tags vs. photo tags).
 * - `/api/image-gen/*` is the bridge the client input box uses to read and write
 *   the endpoint. The endpoint lives in a small JSON file so it survives
 *   restarts without editing YAML.
 *
 * Nothing here imports a harness package: a bundle installed from a directory is
 * loaded through its real path, so `@deepseek-ai/*` would not resolve.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-image-gen'

/** `tools` is required; `attachments`, `webServer` are layered in with ctx.inject. */
export const inject = ['tools']

/** Prefix of the HTTP route the client half talks to. */
const ROUTE_PREFIX = '/api/image-gen'

/** Out-of-the-box endpoint: the default Stable Diffusion WebUI / Forge port. */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:7860'

/** A generation may queue behind other work in the WebUI, so allow plenty. */
const GENERATE_TIMEOUT_MS = 15 * 60 * 1000

/** Reachability probes stay snappy: a down server must not hang the input box. */
const PROBE_TIMEOUT_MS = 4000

/** Style presets appended to the prompt. Keys are the `style` argument values. */
const STYLE_TAGS = {
  anime: 'anime style, cel shading, clean lineart, vibrant colors, key visual',
  illustration: 'detailed illustration, digital painting, soft color grading',
  realistic: 'photorealistic, realistic skin texture, natural lighting, sharp focus, 85mm lens',
  photo: 'RAW photo, 50mm, f/1.8, natural light, film grain, depth of field',
  watercolor: 'watercolor painting, soft washes, paper texture',
  pixel: 'pixel art, 16-bit, crisp pixels, limited palette',
  '3d': '3d render, octane render, soft studio lighting, subsurface scattering',
  sketch: 'pencil sketch, graphite, hatching, monochrome',
}

/** Default negative prompt: the usual anatomy/quality guard rails. */
const DEFAULT_NEGATIVE =
  'lowres, bad anatomy, bad hands, extra fingers, fewer fingers, missing fingers, ' +
  'cropped, worst quality, low quality, jpeg artifacts, watermark, signature, ' +
  'username, text, error, blurry, deformed, disfigured, mutated, extra limbs, bad proportions'

const STYLE_VALUES = ['none', ...Object.keys(STYLE_TAGS)]

/** Prefer the deployment's DSH home, then the conventional location. */
function stateDir() {
  const home = process.env.DSH_HOME
  const root = typeof home === 'string' && home.trim().length > 0 ? home.trim() : join(homedir(), '.dsh')
  return join(root, 'image-gen')
}

/**
 * `save` in the plugin root: the one file that remembers every text box. It sits
 * next to this module, so a linked checkout keeps it in the working copy.
 */
const SAVE_FILE = fileURLToPath(new URL('./save', import.meta.url))

/** Legacy location from the first version, still read so nothing is lost. */
function legacySettingsFile() {
  return join(stateDir(), 'settings.json')
}

/**
 * Accept what a person types into the box: a bare host:port, a trailing slash, a
 * WebUI URL pasted with its path. Returns a normalized base URL, or undefined.
 */
function normalizeEndpoint(raw) {
  if (typeof raw !== 'string') return undefined
  let value = raw.trim()
  if (value.length === 0) return undefined
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.hash = ''
  url.search = ''
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/** Read one candidate settings file, tolerating a missing or broken one. */
function readSaveFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** A launch path as a person typed it: trimmed, surrounding quotes dropped. */
function normalizeLauncher(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^"(.*)"$/, '$1').trim()
}

/** A chosen output folder: trimmed, surrounding quotes dropped. */
function normalizeSaveDir(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^"(.*)"$/, '$1').trim()
}

/** Create the folder if needed and confirm it is usable. */
function ensureDirectory(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** A short free-text setting: trimmed, quotes dropped, empty when absent. */
function normalizeText(raw) {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Endpoint, paths, and the extra prompt/model bits: save file, legacy, env. */
function readSettings() {
  for (const file of [SAVE_FILE, legacySettingsFile()]) {
    const raw = readSaveFile(file)
    const endpoint = normalizeEndpoint(raw.endpoint)
    if (endpoint !== undefined) {
      return {
        endpoint,
        launcher: normalizeLauncher(raw.launcher),
        saveDir: normalizeSaveDir(raw.saveDir),
        alwaysPrompt: normalizeText(raw.alwaysPrompt),
        alwaysNegative: normalizeText(raw.alwaysNegative),
        lora: normalizeText(raw.lora),
        loraWeight: clampNumber(Number(raw.loraWeight), DEFAULT_LORA_WEIGHT, 0, 2),
        embedding: normalizeText(raw.embedding),
        hypernetwork: normalizeText(raw.hypernetwork),
        defaultWidth: clampInteger(Number(raw.defaultWidth), DEFAULT_WIDTH, 64, MAX_EDGE),
        defaultHeight: clampInteger(Number(raw.defaultHeight), DEFAULT_HEIGHT, 64, MAX_EDGE),
        defaultSteps: clampInteger(Number(raw.defaultSteps), DEFAULT_STEPS, 1, 150),
        defaultCfg: clampNumber(Number(raw.defaultCfg), DEFAULT_CFG, 1, 30),
        source: 'saved',
        file,
      }
    }
  }
  const base = {
    launcher: '',
    saveDir: '',
    alwaysPrompt: '',
    alwaysNegative: '',
    lora: '',
    loraWeight: DEFAULT_LORA_WEIGHT,
    embedding: '',
    hypernetwork: '',
    defaultWidth: DEFAULT_WIDTH,
    defaultHeight: DEFAULT_HEIGHT,
    defaultSteps: DEFAULT_STEPS,
    defaultCfg: DEFAULT_CFG,
    file: SAVE_FILE,
  }
  const fromEnv = normalizeEndpoint(process.env.DSH_IMAGE_GEN_ENDPOINT)
  if (fromEnv !== undefined) return { ...base, endpoint: fromEnv, source: 'env' }
  return { ...base, endpoint: DEFAULT_ENDPOINT, source: 'default' }
}

/** Persist every setting atomically; fall back to DSH home if root is read-only. */
function writeSettings(settings) {
  const {
    endpoint,
    launcher,
    saveDir,
    alwaysPrompt = '',
    alwaysNegative = '',
    lora = '',
    loraWeight = DEFAULT_LORA_WEIGHT,
    embedding = '',
    hypernetwork = '',
    defaultWidth = DEFAULT_WIDTH,
    defaultHeight = DEFAULT_HEIGHT,
    defaultSteps = DEFAULT_STEPS,
    defaultCfg = DEFAULT_CFG,
  } = settings
  const payload = `${JSON.stringify(
    {
      endpoint,
      launcher,
      saveDir,
      alwaysPrompt,
      alwaysNegative,
      lora,
      loraWeight,
      embedding,
      hypernetwork,
      defaultWidth,
      defaultHeight,
      defaultSteps,
      defaultCfg,
    },
    null,
    2,
  )}\n`
  try {
    const tmp = `${SAVE_FILE}.tmp`
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, SAVE_FILE)
    return SAVE_FILE
  } catch {
    const fallback = legacySettingsFile()
    mkdirSync(dirname(fallback), { recursive: true })
    const tmp = `${fallback}.tmp`
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, fallback)
    return fallback
  }
}

/** True while the caller's turn is still alive. */
function aborted(signal) {
  return signal === undefined ? false : signal.aborted === true
}

/** Turn a fetch failure into something a person can act on. */
function describeFailure(error, endpoint) {
  if (aborted(error?.signal)) return `已取消（${endpoint}）`
  const cause = error?.cause
  const code = cause?.code ?? error?.code
  if (error?.name === 'AbortError' || cause?.name === 'AbortError') {
    return `请求绘图接口超时：${endpoint}`
  }
  if (code === 'ECONNREFUSED') {
    return (
      `连不上绘图接口 ${endpoint}（ECONNREFUSED）。` +
      '请确认 Stable Diffusion WebUI / Forge 已启动（带 --api），或在 设置 → 小鲸鱼画板 里改成实际地址。'
    )
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `绘图接口地址解析失败：${endpoint}（${code}）`
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return `与绘图接口的连接中断：${endpoint}（${code}）`
  }
  return `请求绘图接口失败：${endpoint}（${code ?? error?.message ?? error}）`
}

/**
 * One request to the WebUI: its own timeout, fused with the turn's cancellation.
 */
async function requestJson(endpoint, path, init, { timeoutMs, signal } = {}) {
  const controller = new AbortController()
  const budget = timeoutMs ?? PROBE_TIMEOUT_MS
  const timer = setTimeout(() => {
    controller.abort(new Error(`请求超时（${Math.round(budget / 1000)} 秒）`))
  }, budget)
  const signals = [controller.signal]
  if (signal !== undefined) signals.push(signal)
  try {
    return await fetch(`${endpoint}${path}`, {
      ...init,
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    throw new Error(describeFailure(error, endpoint), { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

/** Read a short body excerpt without letting it throw over the real failure. */
async function excerpt(response, limit = 400) {
  try {
    const text = await response.text()
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  } catch {
    return ''
  }
}

/** JSON body or a readable error that names the status and the first bytes. */
async function readJson(response, endpoint, what) {
  if (!response.ok) {
    const detail = await excerpt(response)
    throw new Error(`绘图服务返回 HTTP ${response.status}（${what}）：${detail || '无响应内容'}`)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new Error(`绘图服务的响应不是 JSON（${what}）：${error?.message ?? error}`)
  }
}

/** The checkpoint name, whichever shape the WebUI reports it in. */
function checkpointName(options) {
  const value = options?.sd_model_checkpoint
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    return String(value.title ?? value.model_name ?? value.name ?? '')
  }
  return ''
}

/** Probe the service; never throws. */
async function probe(endpoint, { signal, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const response = await requestJson(endpoint, '/sdapi/v1/options', { method: 'GET' }, { timeoutMs, signal })
    const options = await readJson(response, endpoint, 'GET /sdapi/v1/options')
    return { reachable: true, model: checkpointName(options), error: '' }
  } catch (error) {
    return { reachable: false, model: '', error: error?.message ?? String(error) }
  }
}

/**
 * Forge appends a short hash to checkpoint titles (`name.safetensors [e31a1d00f9]`)
 * while `sd_model_checkpoint` reports the bare name, so both sides are compared
 * through this key.
 */
function stripModelHash(value) {
  return String(value).replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '').trim()
}

/** What a person reads in the dropdown: the file name, without folder or hash. */
function modelLabel(title) {
  const clean = stripModelHash(title)
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] || clean
}

/** Comparison key shared by every match below. */
function modelKey(value) {
  return stripModelHash(String(value)).toLowerCase()
}

/** Which listed option id the service currently reports as the loaded checkpoint. */
function resolveCurrentTitle(models, current) {
  if (typeof current !== 'string' || current.length === 0) return ''
  const match =
    models.find((model) => model.id === current) ??
    models.find((model) => modelKey(model.id) === modelKey(current)) ??
    models.find((model) => model.name === current) ??
    models.find((model) => modelKey(model.name) === modelKey(current))
  return match?.id ?? current
}

/**
 * The checkpoints the service offers. `id` is what the WebUI's own dropdown
 * sends (and what `sd_model_checkpoint` accepts); `label` is the short name.
 */
async function listModels(endpoint, { signal, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const response = await requestJson(endpoint, '/sdapi/v1/sd-models', { method: 'GET' }, { timeoutMs, signal })
  const body = await readJson(response, endpoint, 'GET /sdapi/v1/sd-models')
  if (!Array.isArray(body)) return []
  const seen = new Set()
  const models = []
  for (const entry of body) {
    const title = String(entry?.title ?? entry?.model_name ?? '').trim()
    if (title.length === 0 || seen.has(title)) continue
    seen.add(title)
    models.push({ id: title, label: modelLabel(title), name: String(entry?.model_name ?? title) })
  }
  return models
}

/** base64 response → real bytes, so the attachment store sees a picture. */
function decodeBase64Image(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return undefined
  const cleaned = base64.startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64
  try {
    return Buffer.from(cleaned, 'base64')
  } catch {
    return undefined
  }
}

/** Trust the bytes over a guessed extension when picking the media type. */
function sniffMediaType(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { mediaType: 'image/png', ext: 'png' }
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mediaType: 'image/jpeg', ext: 'jpg' }
  }
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mediaType: 'image/webp', ext: 'webp' }
  }
  return { mediaType: 'image/png', ext: 'png' }
}

/** `info` arrives as a JSON string in A1111/Forge; tolerate objects too. */
function parseInfo(info) {
  if (info !== null && typeof info === 'object') return info
  if (typeof info !== 'string' || info.length === 0) return {}
  try {
    const parsed = JSON.parse(info)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** A stable, sortable file name for the gallery copy. */
function galleryName(seed, ext) {
  const now = new Date()
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-` +
    `${Math.random().toString(36).slice(2, 6)}`
  return `img-${stamp}-${seed >= 0 ? seed : 'rand'}.${ext}`
}

/** Keep a plain file copy beside the settings so the picture outlives the chat. */
function saveGalleryCopy(data, seed, ext) {
  try {
    const dir = join(stateDir(), 'gallery')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, galleryName(seed, ext))
    writeFileSync(file, data)
    return file
  } catch {
    return ''
  }
}

/** Copy one picture into the folder the person chose, when one is set. */
function saveOutputCopy(data, seed, ext, saveDir) {
  if (typeof saveDir !== 'string' || saveDir.length === 0) return ''
  try {
    mkdirSync(saveDir, { recursive: true })
    const file = join(saveDir, galleryName(seed, ext))
    writeFileSync(file, data)
    return file
  } catch {
    // An unwritable folder must not cost the person the picture itself.
    return ''
  }
}

/* ────────────────────────────── tool schemas ────────────────────────────── */

const IMAGE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    seed: { type: 'integer' },
    file: { type: 'string' },
    copy: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'seed'],
}

const GENERATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    endpoint: { type: 'string' },
    model: { type: 'string' },
    prompt: { type: 'string' },
    negativePrompt: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    steps: { type: 'integer' },
    cfgScale: { type: 'number' },
    seed: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    images: { type: 'array', items: IMAGE_ITEM_SCHEMA },
  },
  required: [
    'endpoint',
    'prompt',
    'negativePrompt',
    'width',
    'height',
    'steps',
    'cfgScale',
    'seed',
    'elapsedMs',
    'images',
  ],
}

const GENERATE_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'The positive prompt you author yourself (English, comma-separated tags). Describe subject, appearance, pose, composition, background, lighting, style and quality. Translate the user’s request into tags instead of pasting their words.',
    },
    negative_prompt: {
      type: 'string',
      description: 'What to avoid. Omit to use the built-in anatomy/quality guard rails.',
    },
    style: {
      type: 'string',
      enum: STYLE_VALUES,
      description:
        'Optional preset whose tags are appended to the prompt: anime, illustration, realistic, photo, watercolor, pixel, 3d, sketch. Default none.',
    },
    width: { type: 'integer', description: 'Pixels. Default 512. SD1.5: 512×768; SDXL/FLUX: 832×1216 or 1024×1024.' },
    height: { type: 'integer', description: 'Pixels. Default 768.' },
    steps: { type: 'integer', description: 'Sampling steps. Default 28; 20–30 suits most SD1.5/SDXL models.' },
    cfg_scale: { type: 'number', description: 'Prompt adherence. Default 7; 4–5 for SDXL/FLUX, 7–8 for SD1.5.' },
    sampler_name: {
      type: 'string',
      description: 'A sampler the service reports (see image_gen_info). Omit to use the WebUI default, e.g. "DPM++ 2M Karras".',
    },
    seed: {
      type: 'integer',
      description: 'Random seed; -1 (default) for a new one. Reuse a reported seed to reproduce or vary one picture.',
    },
    count: { type: 'integer', description: 'How many pictures in this call, 1–4. Default 1.' },
  },
  required: ['prompt'],
}

const INFO_PARAMETERS = {
  type: 'object',
  properties: {},
  required: [],
}

const INFO_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    endpoint: { type: 'string' },
    reachable: { type: 'boolean' },
    model: { type: 'string' },
    models: { type: 'array', items: { type: 'string' } },
    samplers: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
  required: ['endpoint', 'reachable', 'model', 'models', 'samplers'],
}

/* ─────────────────────────────── content ─────────────────────────────── */

/** The text + one image block per picture the model and the transcript see. */
function renderGenerated(value) {
  const lines = [
    `(๑•̀ㅂ•́)و✧ 已生成 ${value.images.length} 张图 · ${value.width}×${value.height} · ${value.steps} steps · CFG ${value.cfgScale}` +
      ` · ${(value.elapsedMs / 1000).toFixed(1)}s${value.model ? ` · ${value.model}` : ''}`,
    `Prompt: ${value.prompt}`,
  ]
  if (value.negativePrompt) lines.push(`Negative: ${value.negativePrompt}`)
  const blocks = [{ type: 'text', text: lines.join('\n') }]
  for (const [index, image] of value.images.entries()) {
    const parts = [`图 ${index + 1}/${value.images.length}`, `seed ${image.seed}`]
    if (image.file) parts.push(`文件 ${image.file}`)
    if (image.copy) parts.push(`另存 ${image.copy}`)
    blocks.push({ type: 'text', text: parts.join(' · ') })
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name ? { name: image.name } : {}),
      },
    })
  }
  return blocks
}

function renderInfo(value) {
  if (!value.reachable) {
    return [
      {
        type: 'text',
        text:
          `(｡•́︿•̀｡) 绘图接口未连接：${value.endpoint}\n${value.error || '没有更多信息'}\n` +
          '如果地址不对，在 设置 → 小鲸鱼画板 里改掉它再试。',
      },
    ]
  }
  const lines = [
    `(◕ᴗ◕✿) 绘图接口可用：${value.endpoint}`,
    `当前模型：${value.model || '（未报告）'}`,
  ]
  if (value.models.length > 0) lines.push(`可用模型：${value.models.slice(0, 12).join(' / ')}`)
  if (value.samplers.length > 0) lines.push(`采样器：${value.samplers.slice(0, 16).join(', ')}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/* ──────────────────────────────── tools ──────────────────────────────── */

const DEFAULT_STEPS = 28
const DEFAULT_CFG = 7
const DEFAULT_LORA_WEIGHT = 0.8
const DEFAULT_WIDTH = 512
const DEFAULT_HEIGHT = 768
const MAX_EDGE = 2048

function clampInteger(value, fallback, min, max) {
  const number = Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}

function clampNumber(value, fallback, min, max) {
  const number = Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
}

/** Validate the model-authored arguments before a slow generation starts. */
function readArguments(args, settings) {
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('prompt 不能为空：请先写好提示词再调用 generate_image')
  if (prompt.length > 4000) throw new Error('prompt 过长（超过 4000 字符）')
  const style = typeof args?.style === 'string' ? args.style : 'none'
  if (style !== 'none' && STYLE_TAGS[style] === undefined) {
    throw new Error(`未知 style "${style}"，可用：${STYLE_VALUES.join(', ')}`)
  }
  const baseNegative =
    typeof args?.negative_prompt === 'string' && args.negative_prompt.trim().length > 0
      ? args.negative_prompt.trim()
      : DEFAULT_NEGATIVE
  // The person's always-on negative words belong to every picture.
  const negative = settings.alwaysNegative ? `${baseNegative}, ${settings.alwaysNegative}` : baseNegative
  const sampler = typeof args?.sampler_name === 'string' && args.sampler_name.trim().length > 0
    ? args.sampler_name.trim()
    : undefined
  return {
    prompt,
    style,
    negative,
    sampler,
    width: clampInteger(args?.width, settings.defaultWidth, 64, MAX_EDGE),
    height: clampInteger(args?.height, settings.defaultHeight, 64, MAX_EDGE),
    steps: clampInteger(args?.steps, settings.defaultSteps, 1, 150),
    cfgScale: clampNumber(args?.cfg_scale, settings.defaultCfg, 1, 30),
    seed: clampInteger(args?.seed, -1, -1, 2 ** 31 - 1),
    count: clampInteger(args?.count, 1, 1, 4),
  }
}

/**
 * Base prompt, then the always-on prompt, style tags, an embedding tag, and the
 * LoRA tag — the same order the WebUI's own UI would produce.
 */
function composePrompt(prompt, style, settings) {
  const parts = [prompt]
  if (settings.alwaysPrompt) parts.push(settings.alwaysPrompt)
  if (style !== 'none' && STYLE_TAGS[style]) parts.push(STYLE_TAGS[style])
  if (settings.embedding) parts.push(`embedding:${settings.embedding}`)
  if (settings.lora) parts.push(`<lora:${settings.lora}:${settings.loraWeight}>`)
  return parts.filter((part) => typeof part === 'string' && part.length > 0).join(', ')
}

/**
 * Build both tools. Deferred behind `attachments` because a picture without a
 * durable image store could not be shown in the conversation.
 */
function registerTools(ctx) {
  const attachments = ctx.attachments

  ctx.tools.register({
    name: 'generate_image',
    description:
      'Draw a picture with the local Stable Diffusion WebUI / Forge server and show it in the conversation. ' +
      'You write the prompt yourself: turn what the person asked for into concrete English tags (subject, ' +
      'appearance, pose, composition, background, lighting, style, quality), then call this tool. ' +
      'The result contains the rendered image, so describe it briefly afterwards instead of restating the prompt. ' +
      'Each picture is also saved under the plugin data directory. ' +
      "The person's saved settings add an always-on prompt, an always-on negative prompt, a LoRA (with its " +
      'weight), an embedding and a hypernetwork to every picture, so do not repeat those tags yourself. ' +
      'Omitted width/height/steps/cfg_scale fall back to the defaults saved in the plugin settings. Always pass an ' +
      'explicit negative_prompt that guards hands and anatomy (bad hands, extra fingers, missing fingers, fused ' +
      'fingers, mutated hands, extra limbs); the built-in default already covers exactly those. ' +
      'If the call reports that the service is unreachable, call image_gen_info, tell the person, and mention that ' +
      'the endpoint can be changed in 左下角头像 → 设置 → 小鲸鱼画板.',
    parameters: GENERATE_PARAMETERS,
    timeoutMs: GENERATE_TIMEOUT_MS + 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: GENERATE_OUTPUT_SCHEMA,
      render: (_args, value) => renderGenerated(value),
      presentationMeta: (_args, value) => ({ images: value.images.length, seed: value.seed }),
    },
    presentCall(args) {
      return { card: 'generic', title: `Generate image · ${Math.round(Number(args?.width) || DEFAULT_WIDTH)}×${Math.round(Number(args?.height) || DEFAULT_HEIGHT)}`, kind: 'other' }
    },
    presentResult(_args, result) {
      if (result.isError) return { card: 'generic', title: 'Generate image failed', kind: 'other' }
      return { card: 'generic', title: 'Generated image', kind: 'other' }
    },
    async execute(args, exec) {
      const settings = readSettings()
      const input = readArguments(args, settings)
      const endpoint = settings.endpoint
      const prompt = composePrompt(input.prompt, input.style, settings)

      const payload = {
        prompt,
        negative_prompt: input.negative,
        steps: input.steps,
        cfg_scale: input.cfgScale,
        width: input.width,
        height: input.height,
        seed: input.seed,
        batch_size: input.count,
        n_iter: 1,
        save_images: false,
        send_images: true,
      }
      if (input.sampler !== undefined) payload.sampler_name = input.sampler
      // A hypernetwork lives in global options; overriding it per request keeps
      // the person's WebUI session untouched.
      if (settings.hypernetwork) {
        payload.override_settings = {
          sd_hypernetwork: settings.hypernetwork,
          sd_hypernetwork_strength: 1,
        }
      }

      const started = Date.now()
      const response = await requestJson(
        endpoint,
        '/sdapi/v1/txt2img',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        { timeoutMs: GENERATE_TIMEOUT_MS, signal: exec.signal },
      )
      const body = await readJson(response, endpoint, 'POST /sdapi/v1/txt2img')
      const encoded = Array.isArray(body?.images) ? body.images : []
      if (encoded.length === 0) {
        throw new Error('绘图服务没有返回图片（images 为空）；可能是显存不足或参数被拒绝，换个小一点的分辨率再试')
      }

      const info = parseInfo(body?.info)
      const seeds = Array.isArray(info.all_seeds) ? info.all_seeds : []
      const requestedModel = typeof info.sd_model_name === 'string' ? info.sd_model_name : ''

      const images = []
      for (const [index, base64] of encoded.entries()) {
        const data = decodeBase64Image(base64)
        if (data === undefined || data.length === 0) {
          throw new Error(`绘图服务返回的第 ${index + 1} 张图无法解码`)
        }
        const { mediaType, ext } = sniffMediaType(data)
        const seed = Number.isFinite(seeds[index])
          ? seeds[index]
          : Number.isFinite(info.seed)
            ? info.seed
            : input.seed
        const file = saveGalleryCopy(data, seed, ext)
        // The person's chosen folder gets its own copy, so the picture is where
        // they expect it without opening the plugin data directory.
        const copy = saveOutputCopy(data, seed, ext, settings.saveDir)
        const ref = await attachments.saveImage({
          data,
          mediaType,
          name: `image-gen-${seed >= 0 ? seed : 'random'}-${index + 1}.${ext}`,
        })
        images.push({
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          name: ref.name,
          seed,
          file,
          copy,
        })
      }

      return {
        endpoint,
        model: requestedModel,
        prompt,
        negativePrompt: input.negative,
        width: input.width,
        height: input.height,
        steps: input.steps,
        cfgScale: input.cfgScale,
        seed: images[0]?.seed ?? input.seed,
        elapsedMs: Date.now() - started,
        images,
      }
    },
  })

  ctx.tools.register({
    name: 'image_gen_info',
    description:
      'Check the local image-generation endpoint: whether it answers, which checkpoint is loaded, and which ' +
      'models and samplers it offers. Call it before the first picture of a session, or when generate_image ' +
      'reports a connection problem, so the prompt matches the model in use.',
    parameters: INFO_PARAMETERS,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    output: {
      schema: INFO_OUTPUT_SCHEMA,
      render: (_args, value) => renderInfo(value),
    },
    async execute(_args, exec) {
      const { endpoint } = readSettings()
      const [options, models, samplers] = await Promise.allSettled([
        requestJson(endpoint, '/sdapi/v1/options', { method: 'GET' }, { timeoutMs: PROBE_TIMEOUT_MS, signal: exec.signal }).then(
          (response) => readJson(response, endpoint, 'GET /sdapi/v1/options'),
        ),
        requestJson(endpoint, '/sdapi/v1/sd-models', { method: 'GET' }, { timeoutMs: PROBE_TIMEOUT_MS, signal: exec.signal }).then(
          (response) => readJson(response, endpoint, 'GET /sdapi/v1/sd-models'),
        ),
        requestJson(endpoint, '/sdapi/v1/samplers', { method: 'GET' }, { timeoutMs: PROBE_TIMEOUT_MS, signal: exec.signal }).then(
          (response) => readJson(response, endpoint, 'GET /sdapi/v1/samplers'),
        ),
      ])

      if (options.status === 'rejected') {
        return {
          endpoint,
          reachable: false,
          model: '',
          models: [],
          samplers: [],
          error: options.reason?.message ?? String(options.reason),
        }
      }

      const modelNames = models.status === 'fulfilled' && Array.isArray(models.value)
        ? models.value.map((entry) => String(entry?.model_name ?? entry?.title ?? '')).filter(Boolean)
        : []
      const samplerNames = samplers.status === 'fulfilled' && Array.isArray(samplers.value)
        ? samplers.value.map((entry) => String(entry?.name ?? '')).filter(Boolean)
        : []

      return {
        endpoint,
        reachable: true,
        model: checkpointName(options.value),
        models: modelNames,
        samplers: samplerNames,
        error: '',
      }
    },
  })
}

/* ─────────────────────────────── http route ─────────────────────────────── */

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store',
  })
  res.end(data)
}

/** Read a tiny JSON request body; refuses anything that is not an object. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`请求体不是 JSON：${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

/** One consistent snapshot of the settings for the settings page and the pill. */
async function currentState() {
  const settings = readSettings()
  const status = await probe(settings.endpoint)
  return {
    endpoint: settings.endpoint,
    launcher: settings.launcher,
    launcherExists: settings.launcher.length > 0 && existsSync(settings.launcher),
    saveDir: settings.saveDir,
    saveDirExists: settings.saveDir.length > 0 && existsSync(settings.saveDir),
    alwaysPrompt: settings.alwaysPrompt,
    alwaysNegative: settings.alwaysNegative,
    lora: settings.lora,
    loraWeight: settings.loraWeight,
    embedding: settings.embedding,
    hypernetwork: settings.hypernetwork,
    defaultWidth: settings.defaultWidth,
    defaultHeight: settings.defaultHeight,
    defaultSteps: settings.defaultSteps,
    defaultCfg: settings.defaultCfg,
    source: settings.source,
    defaultEndpoint: DEFAULT_ENDPOINT,
    settingsFile: SAVE_FILE,
    galleryDir: join(stateDir(), 'gallery'),
    reachable: status.reachable,
    model: status.model,
    error: status.error,
  }
}

/**
 * Scan the models the WebUI lists besides checkpoints: LoRAs, textual-inversion
 * embeddings, and hypernetworks. Missing endpoints degrade to an empty list.
 */
async function listExtras(endpoint, { signal } = {}) {
  const settle = (path, what, method = 'GET') =>
    requestJson(endpoint, path, { method }, { timeoutMs: PROBE_TIMEOUT_MS, signal }).then((response) =>
      readJson(response, endpoint, what),
    )
  const loraNamesOf = (value) =>
    Array.isArray(value)
      ? value.map((entry) => String(entry?.alias || entry?.name || '').trim()).filter(Boolean)
      : []

  const [firstLoras, embeddings, hypernets] = await Promise.allSettled([
    settle('/sdapi/v1/loras', 'GET /sdapi/v1/loras'),
    settle('/sdapi/v1/embeddings', 'GET /sdapi/v1/embeddings'),
    settle('/sdapi/v1/hypernetworks', 'GET /sdapi/v1/hypernetworks'),
  ])

  // The WebUI caches its LoRA list: a freshly added file answers [] until the
  // list is refreshed, so an empty answer deserves one retry after refreshing.
  let loras = firstLoras
  let loraNames = loras.status === 'fulfilled' ? loraNamesOf(loras.value) : []
  if (loraNames.length === 0) {
    try {
      await requestJson(endpoint, '/sdapi/v1/refresh-loras', { method: 'POST' }, { timeoutMs: 20_000, signal })
      loras = await settle('/sdapi/v1/loras', 'GET /sdapi/v1/loras').then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      )
      loraNames = loras.status === 'fulfilled' ? loraNamesOf(loras.value) : []
    } catch {
      // A WebUI without the refresh route keeps its cached answer.
    }
  }

  const embeddingNames = embeddings.status === 'fulfilled' && embeddings.value !== null && typeof embeddings.value === 'object'
    ? Object.keys(embeddings.value.loaded ?? {}).filter(Boolean)
    : []
  const hypernetworkNames = hypernets.status === 'fulfilled' && Array.isArray(hypernets.value)
    ? hypernets.value.map((entry) => String(entry?.name ?? entry ?? '')).filter(Boolean)
    : []
  const failure = [loras, embeddings, hypernets].find((entry) => entry.status === 'rejected')

  const unique = (names) => [...new Set(names)].sort((a, b) => a.localeCompare(b))
  return {
    loras: unique(loraNames),
    embeddings: unique(embeddingNames),
    hypernetworks: unique(hypernetworkNames),
    error: failure === undefined ? '' : (failure.reason?.message ?? String(failure.reason)),
  }
}

/** Launch the configured server, in its own window, detached from the Harness. */
function spawnLauncher(launcher) {
  const cwd = dirname(launcher)
  const ext = extname(launcher).toLowerCase()
  const options = { cwd, detached: true, stdio: 'ignore', windowsHide: false }
  let child
  if (process.platform === 'win32' && (ext === '.bat' || ext === '.cmd')) {
    // `start` opens a real console window so the server's own log stays visible.
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start', '""', launcher], options)
  } else if (ext === '.ps1') {
    child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher], options)
  } else if (ext === '.py') {
    child = spawn(process.env.DSH_IMAGE_GEN_PYTHON || 'python', [launcher], options)
  } else {
    child = spawn(launcher, [], options)
  }
  child.on('error', () => {})
  child.unref()
  return child
}

/** Poll the endpoint until it answers or the budget runs out. */
async function waitForEndpoint(endpoint, { timeoutMs = 180_000 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const status = await probe(endpoint, { timeoutMs: 1500 })
    if (status.reachable) {
      return { reachable: true, model: status.model, waitedMs: Date.now() - started, error: '' }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return {
    reachable: false,
    model: '',
    waitedMs: Date.now() - started,
    error: '等待超时，服务还没起来（看下启动窗口里的报错）',
  }
}

function registerRoute(ctx) {
  const handler = async (req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      pathname = '/'
    }
    const path = pathname.slice(ROUTE_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && (path === '/settings' || path === '/state')) {
        return json(res, 200, await currentState())
      }
      if (req.method === 'POST' && path === '/check') {
        return json(res, 200, await currentState())
      }
      if (req.method === 'POST' && path === '/settings') {
        const body = await readBody(req)
        const endpoint = normalizeEndpoint(body?.endpoint)
        const launcher = normalizeLauncher(body?.launcher)
        const saveDir = normalizeSaveDir(body?.saveDir)
        const alwaysPrompt = normalizeText(body?.alwaysPrompt)
        const alwaysNegative = normalizeText(body?.alwaysNegative)
        const lora = normalizeText(body?.lora)
        const loraWeight = clampNumber(Number(body?.loraWeight), DEFAULT_LORA_WEIGHT, 0, 2)
        const embedding = normalizeText(body?.embedding)
        const hypernetwork = normalizeText(body?.hypernetwork)
        const defaultWidth = clampInteger(Number(body?.defaultWidth), DEFAULT_WIDTH, 64, MAX_EDGE)
        const defaultHeight = clampInteger(Number(body?.defaultHeight), DEFAULT_HEIGHT, 64, MAX_EDGE)
        const defaultSteps = clampInteger(Number(body?.defaultSteps), DEFAULT_STEPS, 1, 150)
        const defaultCfg = clampNumber(Number(body?.defaultCfg), DEFAULT_CFG, 1, 30)
        if (endpoint === undefined) {
          return json(res, 400, { ok: false, invalid: true, error: '地址无效：需要 http(s)://host:port 形式的绘图接口地址' })
        }
        if (saveDir.length > 0 && !ensureDirectory(saveDir)) {
          return json(res, 400, { ok: false, invalid: true, error: `保存目录不可用：${saveDir}` })
        }
        writeSettings({
          endpoint,
          launcher,
          saveDir,
          alwaysPrompt,
          alwaysNegative,
          lora,
          loraWeight,
          embedding,
          hypernetwork,
          defaultWidth,
          defaultHeight,
          defaultSteps,
          defaultCfg,
        })
        return json(res, 200, { ok: true, ...(await currentState()) })
      }
      if (req.method === 'POST' && path === '/launch') {
        const body = await readBody(req)
        const saved = readSettings()
        const typed = normalizeLauncher(typeof body?.launcher === 'string' ? body.launcher : '')
        const launcher = typed.length > 0 ? typed : saved.launcher
        if (launcher.length === 0) {
          return json(res, 400, { ok: false, error: '还没有设置应用启动路径' })
        }
        if (!existsSync(launcher)) {
          return json(res, 400, { ok: false, error: `启动路径不存在：${launcher}` })
        }
        const current = await probe(saved.endpoint)
        if (current.reachable) {
          return json(res, 200, {
            ok: true,
            started: false,
            already: true,
            reachable: true,
            model: current.model,
            waitedMs: 0,
            error: '',
          })
        }
        try {
          spawnLauncher(launcher)
        } catch (error) {
          return json(res, 500, { ok: false, error: `启动失败：${error?.message ?? error}` })
        }
        const wait = await waitForEndpoint(saved.endpoint)
        return json(res, 200, {
          ok: wait.reachable,
          started: true,
          already: false,
          reachable: wait.reachable,
          model: wait.model,
          waitedMs: wait.waitedMs,
          error: wait.error,
        })
      }
      if (req.method === 'GET' && path === '/extras') {
        const { endpoint } = readSettings()
        try {
          const extras = await listExtras(endpoint)
          return json(res, 200, { ok: extras.error.length === 0, endpoint, ...extras })
        } catch (error) {
          return json(res, 200, {
            ok: false,
            endpoint,
            loras: [],
            embeddings: [],
            hypernetworks: [],
            error: error?.message ?? String(error),
          })
        }
      }
      if (req.method === 'GET' && path === '/models') {
        const { endpoint } = readSettings()
        try {
          const [models, status] = await Promise.all([listModels(endpoint), probe(endpoint)])
          return json(res, 200, {
            ok: true,
            endpoint,
            models: models.map((model) => ({ id: model.id, label: model.label })),
            model: resolveCurrentTitle(models, status.model),
            reachable: status.reachable,
            error: status.error,
          })
        } catch (error) {
          return json(res, 200, {
            ok: false,
            endpoint,
            models: [],
            model: '',
            reachable: false,
            error: error?.message ?? String(error),
          })
        }
      }
      if (req.method === 'POST' && path === '/model') {
        const body = await readBody(req)
        const wanted = typeof body?.name === 'string' ? body.name.trim() : ''
        if (wanted.length === 0) return json(res, 400, { ok: false, error: '缺少模型名' })
        const { endpoint } = readSettings()
        let models
        try {
          models = await listModels(endpoint)
        } catch (error) {
          return json(res, 502, { ok: false, error: error?.message ?? String(error) })
        }
        const match =
          models.find((model) => model.id === wanted) ??
          models.find((model) => modelKey(model.id) === modelKey(wanted)) ??
          models.find((model) => model.name === wanted) ??
          models.find((model) => modelKey(model.label) === modelKey(wanted))
        if (match === undefined) {
          return json(res, 400, { ok: false, error: `没有这个模型：${wanted}` })
        }
        // Loading a checkpoint can take tens of seconds; give it room.
        const response = await requestJson(
          endpoint,
          '/sdapi/v1/options',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sd_model_checkpoint: match.id }),
          },
          { timeoutMs: 180_000 },
        )
        await readJson(response, endpoint, 'POST /sdapi/v1/options')
        const status = await probe(endpoint)
        return json(res, 200, {
          ok: true,
          endpoint,
          model: resolveCurrentTitle(models, status.model),
          reachable: status.reachable,
          models: models.map((model) => ({ id: model.id, label: model.label })),
          error: status.error,
        })
      }
      return json(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
    } catch (error) {
      return json(res, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler,
      }),
    'dsh-image-gen: /api/image-gen route',
  )
}

/**
 * Mount the plugin: tools when an attachment store exists, the route when a web
 * server exists. Either half alone still leaves the other usable.
 */
export function apply(ctx) {
  ctx.inject(['attachments'], (imageCtx) => {
    registerTools(imageCtx)
  })
  ctx.inject(['webServer'], (webCtx) => {
    registerRoute(webCtx)
  })
}
