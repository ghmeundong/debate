const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { createReadStream, existsSync, promises: fs } = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const DEFAULT_DIALOGUE_MODEL = 'qwen2.5:3b'
const JUDGE_MODEL = 'qwen2.5:1.5b'
const DIALOGUE_MODELS = new Set(['qwen2.5:3b', 'qwen2.5:7b', 'qwen2.5:14b'])
const SETUP_ONLY = process.argv.includes('--installer-setup')
const OLLAMA_URL = 'http://127.0.0.1:11434'
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

let mainWindow
let localServer
let setupOllamaProcess
let runtimeConfig = { dialogueModel: DEFAULT_DIALOGUE_MODEL, judgeModel: JUDGE_MODEL }

ipcMain.handle('debate:get-runtime-config', () => runtimeConfig)

function setupLog(message) {
  process.stdout.write(`[setup] ${String(message).replace(/[\r\n]+/g, ' ')}\n`)
}

function getRuntimeConfigPath() {
  return path.join(app.getPath('userData'), 'runtime-config.json')
}

async function loadRuntimeConfig() {
  try {
    const saved = JSON.parse(await fs.readFile(getRuntimeConfigPath(), 'utf8'))
    if (DIALOGUE_MODELS.has(saved.dialogueModel)) runtimeConfig.dialogueModel = saved.dialogueModel
  } catch {}
  return runtimeConfig
}

async function saveRuntimeConfig(dialogueModel) {
  runtimeConfig = { dialogueModel, judgeModel: JUDGE_MODEL }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getRuntimeConfigPath(), JSON.stringify(runtimeConfig, null, 2), 'utf8')
}

function findOllama() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Ollama', 'ollama.exe'),
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  const located = spawnSync('where.exe', ['ollama.exe'], { encoding: 'utf8', windowsHide: true })
  return located.status === 0 ? located.stdout.split(/\r?\n/).find(Boolean) : null
}

function runProcess(executable, args, timeoutMs = 45 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (chunk) => {
      const text = chunk.toString()
      output = `${output}${text}`.slice(-4000)
      for (const line of text.split(/\r?\n/).filter(Boolean)) setupLog(line)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Setup process timed out.'))
    }, timeoutMs)
    child.once('close', (code) => {
      clearTimeout(timeout)
      code === 0 ? resolve(output) : reject(new Error(`Setup process exited with code ${code}: ${output.slice(-1000)}`))
    })
  })
}

async function waitForOllama(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return response.json()
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Ollama did not start. Check Windows security prompts and retry setup.')
}

async function ensureOllamaInstalled() {
  let executable = findOllama()
  if (executable) {
    setupLog(`Ollama is installed at ${executable}.`)
    return executable
  }

  setupLog('Ollama is not installed. Downloading and installing the official Windows package.')
  await runProcess('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ProgressPreference='SilentlyContinue'; irm 'https://ollama.com/install.ps1' | iex",
  ])
  executable = findOllama()
  if (!executable) throw new Error('Ollama setup finished but ollama.exe was not found.')
  setupLog('Ollama installation completed.')
  return executable
}

async function ensureOllamaServer(executable) {
  try {
    return await waitForOllama(3000)
  } catch {}

  setupLog('Starting Ollama for model setup.')
  setupOllamaProcess = spawn(executable, ['serve'], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: '1' },
  })
  setupOllamaProcess.once('error', (error) => setupLog(`Ollama server error: ${error.message}`))
  return waitForOllama()
}

async function ensureModel(model) {
  const response = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
  })
  if (!response.ok || !response.body) throw new Error(`Could not download ${model} (HTTP ${response.status}).`)

  setupLog(`Checking/downloading ${model}.`)
  const decoder = new TextDecoder()
  let pending = ''
  let lastProgress = -1
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const state = JSON.parse(line)
      if (state.error) throw new Error(state.error)
      if (Number.isFinite(state.total) && Number.isFinite(state.completed) && state.total > 0) {
        const percent = Math.floor(state.completed * 100 / state.total)
        if (percent >= lastProgress + 5 || percent === 100) {
          lastProgress = percent
          setupLog(`${model}: ${percent}% (${formatBytes(state.completed)} / ${formatBytes(state.total)})`)
        }
      } else if (state.status) {
        setupLog(`${model}: ${state.status}`)
      }
    }
  }
  if (pending.trim()) {
    const state = JSON.parse(pending)
    if (state.error) throw new Error(state.error)
  }
  setupLog(`${model} is ready.`)
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

async function prepareInstallerModels() {
  const dialogueModel = process.env.DEBATE_INSTALL_DIALOGUE_MODEL || DEFAULT_DIALOGUE_MODEL
  if (!DIALOGUE_MODELS.has(dialogueModel)) throw new Error(`Unsupported dialogue model: ${dialogueModel}`)
  const executable = await ensureOllamaInstalled()
  await ensureOllamaServer(executable)
  await ensureModel(dialogueModel)
  await ensureModel(JUDGE_MODEL)
  await saveRuntimeConfig(dialogueModel)
  setupLog(`Setup completed. Dialogue: ${dialogueModel}; judge: ${JUDGE_MODEL}.`)
}

function serveFile(request, response, webRoot) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
  } catch {
    response.writeHead(400).end('Bad request')
    return
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let filePath = path.resolve(webRoot, requested)
  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
    response.writeHead(403).end('Forbidden')
    return
  }
  if (!existsSync(filePath)) filePath = path.join(webRoot, 'index.html')
  response.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream')
  createReadStream(filePath).on('error', () => response.writeHead(404).end('Not found')).pipe(response)
}

function proxyOllama(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1')
  const endpoint = url.pathname.replace(/^\/ollama/, '')
  if (!['/api/tags', '/api/chat'].includes(endpoint)) {
    response.writeHead(404).end('Ollama endpoint is not available through this app.')
    return
  }
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: 11434,
    path: `${endpoint}${url.search}`,
    method: request.method,
    headers: { 'content-type': request.headers['content-type'] || 'application/json' },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, {
      'content-type': upstreamResponse.headers['content-type'] || 'application/json',
      'cache-control': 'no-store',
    })
    upstreamResponse.pipe(response)
  })
  upstream.on('error', (error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: `Ollama proxy failed: ${error.message}` }))
  })
  request.pipe(upstream)
}

async function startLocalServer() {
  const webRoot = path.join(__dirname, '..', 'dist')
  localServer = http.createServer((request, response) => {
    if (request.url.startsWith('/ollama/')) return proxyOllama(request, response)
    serveFile(request, response, webRoot)
  })
  await new Promise((resolve, reject) => {
    localServer.once('error', reject)
    localServer.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${localServer.address().port}`
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f5f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.loadURL(url)
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(async () => {
  if (SETUP_ONLY) {
    try {
      await prepareInstallerModels()
      app.exit(0)
    } catch (error) {
      setupLog(`Setup failed: ${error.message}`)
      app.exit(1)
    }
    return
  }

  await loadRuntimeConfig()
  if (app.isPackaged) {
    createMainWindow(await startLocalServer())
  } else {
    createMainWindow(process.env.DEBATE_DEV_URL || 'http://127.0.0.1:5173')
  }
})

app.on('will-quit', () => {
  localServer?.close()
  if (setupOllamaProcess?.pid) setupOllamaProcess.kill()
})

app.on('window-all-closed', () => app.quit())