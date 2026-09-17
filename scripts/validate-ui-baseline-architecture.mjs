import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const fail = (message) => { console.error(`FAIL: ${message}`); process.exitCode = 1 }
const ok = (message) => console.log(`OK: ${message}`)

const pkg = JSON.parse(read('package.json'))
const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
if ('playwright-core' in allDeps || 'playwright' in allDeps) fail('Node/Electron Playwright dependency must not exist')
else ok('Node/Electron Playwright dependency absent')

const cargo = read('espow-runtime/Cargo.toml')
if (!/playwright-rs\s*=\s*"0\.18\.1"/.test(cargo)) fail('Rust Runtime must depend on playwright-rs 0.18.1')
else ok('Rust Playwright dependency present')

const rustMain = read('espow-runtime/src/main.rs')
const rpcMethods = ['ui_learning.start','ui_learning.focus','ui_learning.capture','ui_learning.screenshot','ui_learning.status','ui_learning.stop']
for (const method of rpcMethods) {
  if (!rustMain.includes(`"${method}"`)) fail(`Missing Rust Runtime RPC: ${method}`)
}
if (rpcMethods.every((method) => rustMain.includes(`"${method}"`))) ok('Rust UI Learning RPC surface complete')

const service = read('electron/prototypeStyleService.ts')
if (/playwright-core|from\s+['"]playwright['"]|BrowserWindow/.test(service)) fail('PrototypeStyleService must not own a Node Playwright/BrowserWindow browser')
else ok('Electron PrototypeStyleService has no browser implementation')
if (!service.includes('runtime.startUiLearning') || !service.includes('runtime.captureUiLearning') || !service.includes('runtime.screenshotUiLearning')) fail('PrototypeStyleService must delegate browser work to Rust Runtime')
else ok('Electron delegates browser work to Rust Runtime')

const app = read('src/App.tsx')
const menu = [
  'Agent 模型配置', '业务与系统配置', '原型样式配置', '产品文档模板',
  '系统运行诊断', 'Token 统计看板', 'Agent Runtime 版本'
]
let pos = -1
let ordered = true
for (const label of menu) {
  const next = app.indexOf(`>${label}</button>`, pos + 1)
  if (next < 0) { ordered = false; fail(`Missing settings menu item: ${label}`); break }
  if (next <= pos) { ordered = false; fail(`Settings menu out of order at: ${label}`); break }
  pos = next
}
if (ordered) ok('Settings menu names/order verified')

const context = read('electron/runtime/contextManager.ts')
if (!context.includes('resolveContext')) fail('Prototype context must resolve saved UI Baseline')
else ok('Prototype context uses saved UI Baseline resolver')

if (process.exitCode) process.exit(process.exitCode)
console.log('UI Baseline architecture validation passed.')
