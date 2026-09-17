import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { RuntimeService } from './runtime/runtimeService'
import type {
  PrototypeStyleState, StartUiLearningInput, UiBaselineCandidateSummary, UiBaselineContext, UiBaselinePreviewResult,
  UiComponentType, UiCoverageState, UiLearningState, UiPagePattern
} from '../src/prototypeStyle'

const pagePatternIds: UiPagePattern[] = ['list', 'detail', 'form', 'dashboard', 'modal', 'drawer']
const componentIds: UiComponentType[] = ['button', 'input', 'select', 'search', 'table', 'pagination', 'tabs', 'tag', 'form', 'modal', 'drawer', 'card', 'header', 'sidebar']
const captureIntervalMs = 3_000
const screenshotSanitizeCss = '*:not(svg):not(path){color:transparent !important;text-shadow:none !important;caret-color:transparent !important} input,textarea{color:transparent !important} svg text,svg tspan{fill:transparent !important;color:transparent !important} img,canvas,video{filter:blur(12px) !important}'

type StyleValue = string | number | null
interface ElementStyleSample {
  selector: string
  color: string
  backgroundColor: string
  borderColor: string
  borderRadius: string
  boxShadow: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  height: number
  width: number
  padding: string
  margin: string
}

interface RawCapture {
  url: string
  viewport: { width: number; height: number }
  metrics: Record<string, number>
  globalStyle: ElementStyleSample | null
  componentStyles: Record<string, ElementStyleSample[]>
  cssVariables: Record<string, string>
  boxes: Array<{ role: string; x: number; y: number; width: number; height: number }>
}

interface UiLearningSample {
  id: string
  route: string
  capturedAt: string
  fingerprint: string
  patterns: UiPagePattern[]
  components: UiComponentType[]
  metrics: Record<string, number>
  viewport: { width: number; height: number }
  globalStyle: ElementStyleSample | null
  componentStyles: Record<string, ElementStyleSample[]>
  cssVariables: Record<string, string>
  boxes: RawCapture['boxes']
  screenshotPath: string | null
}

interface LearningManifest {
  sessionId: string
  name: string
  sourceUrl: string
  startedAt: string
  updatedAt: string
  status: 'learning' | 'interrupted' | 'candidate-ready'
  message: string | null
}

interface CandidateManifest extends UiBaselineCandidateSummary {
  version: number
  directory: string
}

interface CurrentManifest {
  name: string
  version: number
  sourceUrl: string
  updatedAt: string
  learnedPageCount: number
  patternCount: number
  componentCount: number
}

interface BaselineDocument {
  meta: { name: string; version: number; updatedAt: string; sourceUrl: string }
  globals: Record<string, unknown>
}

function emptyCoverage(): UiCoverageState {
  return {
    pagePatterns: Object.fromEntries(pagePatternIds.map((id) => [id, false])) as Record<UiPagePattern, boolean>,
    components: Object.fromEntries(componentIds.map((id) => [id, false])) as Record<UiComponentType, boolean>,
    summary: '尚未开始界面学习。',
    nextSuggestion: '先打开一个常用列表页面。'
  }
}

export function sanitizeRoute(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const pathname = url.pathname.split('/').map((part) => {
      if (/^\d{4,}$/.test(part)) return ':id'
      if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(part)) return ':id'
      if (/^[A-Za-z0-9_-]{18,}$/.test(part)) return ':id'
      return part
    }).join('/')
    return `${url.origin}${pathname}`
  } catch {
    return 'unknown-route'
  }
}

function validLearningUrl(value: string): string {
  const trimmed = value.trim()
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { throw new Error('请输入有效的内部系统地址。') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 http / https 地址。')
  parsed.hash = ''
  return parsed.toString()
}

export function classifyCapture(capture: Pick<RawCapture, 'metrics'>): { patterns: UiPagePattern[]; components: UiComponentType[] } {
  const m = capture.metrics
  const patterns = new Set<UiPagePattern>()
  const components = new Set<UiComponentType>()
  if ((m.tables ?? 0) > 0) { patterns.add('list'); components.add('table') }
  if ((m.forms ?? 0) > 0 || (m.formControls ?? 0) >= 4) { patterns.add('form'); components.add('form') }
  if ((m.detailPairs ?? 0) >= 3 || (m.infoSections ?? 0) >= 2) patterns.add('detail')
  if ((m.dashboardCards ?? 0) >= 3 || (m.charts ?? 0) > 0) patterns.add('dashboard')
  if ((m.modals ?? 0) > 0) { patterns.add('modal'); components.add('modal') }
  if ((m.drawers ?? 0) > 0) { patterns.add('drawer'); components.add('drawer') }
  if ((m.buttons ?? 0) > 0) components.add('button')
  if ((m.inputs ?? 0) > 0) components.add('input')
  if ((m.selects ?? 0) > 0) components.add('select')
  if ((m.searchAreas ?? 0) > 0) components.add('search')
  if ((m.paginations ?? 0) > 0) components.add('pagination')
  if ((m.tabs ?? 0) > 0) components.add('tabs')
  if ((m.tags ?? 0) > 0) components.add('tag')
  if ((m.cards ?? 0) > 0) components.add('card')
  if ((m.headers ?? 0) > 0) components.add('header')
  if ((m.sidebars ?? 0) > 0) components.add('sidebar')
  if (!patterns.size && (m.tables ?? 0) === 0 && (m.formControls ?? 0) < 4) patterns.add('detail')
  return { patterns: [...patterns], components: [...components] }
}

export function buildCoverage(samples: UiLearningSample[]): UiCoverageState {
  const patternSet = new Set(samples.flatMap((sample) => sample.patterns))
  const componentSet = new Set(samples.flatMap((sample) => sample.components))
  const pagePatterns = Object.fromEntries(pagePatternIds.map((id) => [id, patternSet.has(id)])) as Record<UiPagePattern, boolean>
  const components = Object.fromEntries(componentIds.map((id) => [id, componentSet.has(id)])) as Record<UiComponentType, boolean>
  let nextSuggestion: string | null = null
  if (!pagePatterns.list) nextSuggestion = '建议打开一个包含查询区域和表格的常用页面。'
  else if (!pagePatterns.detail) nextSuggestion = '已学习列表页面。接下来建议打开其中一条数据的“查看/详情”。'
  else if (!pagePatterns.form) nextSuggestion = '已学习详情页面。可以继续打开一个新增或编辑页面，帮助学习表单样式。'
  else if (!components.tabs) nextSuggestion = '主页面类型已经比较完整；如果系统有 Tabs，可以再打开一个包含 Tabs 的页面。'
  else if (!components.modal && !components.drawer) nextSuggestion = '界面学习已经比较完整。建议再打开一个包含弹窗或抽屉的页面。'
  const summary = samples.length === 0 ? '尚未采集页面。'
    : pagePatterns.list && pagePatterns.detail && pagePatterns.form ? '界面学习已经比较完整。'
      : `已自动学习 ${samples.length} 个典型页面。`
  return { pagePatterns, components, summary, nextSuggestion }
}

function mode(values: string[], fallback = ''): string {
  const counts = new Map<string, number>()
  for (const value of values.map((item) => item.trim()).filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? fallback
}

function median(values: number[], fallback = 0): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return fallback
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function componentStyle(samples: UiLearningSample[], component: UiComponentType): Record<string, StyleValue> | null {
  const entries = samples.flatMap((sample) => sample.componentStyles[component] ?? [])
  if (!entries.length) return null
  return {
    backgroundColor: mode(entries.map((item) => item.backgroundColor)),
    color: mode(entries.map((item) => item.color)),
    borderColor: mode(entries.map((item) => item.borderColor)),
    borderRadius: mode(entries.map((item) => item.borderRadius)),
    boxShadow: mode(entries.map((item) => item.boxShadow)),
    fontSize: mode(entries.map((item) => item.fontSize)),
    fontWeight: mode(entries.map((item) => item.fontWeight)),
    height: median(entries.map((item) => item.height)),
    padding: mode(entries.map((item) => item.padding))
  }
}

function patternDocument(samples: UiLearningSample[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const pattern of pagePatternIds) {
    const matched = samples.filter((sample) => sample.patterns.includes(pattern))
    if (!matched.length) continue
    const components = componentIds.filter((component) => matched.some((sample) => sample.components.includes(component)))
    result[`${pattern}_page`] = {
      sampleCount: matched.length,
      components,
      typicalViewport: {
        width: median(matched.map((sample) => sample.viewport.width)),
        height: median(matched.map((sample) => sample.viewport.height))
      }
    }
  }
  return result
}

export function buildBaselineDocuments(samples: UiLearningSample[], name: string, sourceUrl: string, version: number, updatedAt: string): {
  baseline: BaselineDocument; components: Record<string, unknown>; patterns: Record<string, unknown>
} {
  const globalEntries = samples.map((sample) => sample.globalStyle).filter((value): value is ElementStyleSample => Boolean(value))
  const cssVariables = new Map<string, string[]>()
  for (const sample of samples) for (const [key, value] of Object.entries(sample.cssVariables)) cssVariables.set(key, [...(cssVariables.get(key) ?? []), value])
  const variables = Object.fromEntries([...cssVariables.entries()].map(([key, values]) => [key, mode(values)]).filter(([, value]) => Boolean(value)))
  const baseline: BaselineDocument = {
    meta: { name, version, updatedAt, sourceUrl: sanitizeRoute(sourceUrl) },
    globals: {
      page: {
        backgroundColor: mode(globalEntries.map((item) => item.backgroundColor), '#ffffff'),
        color: mode(globalEntries.map((item) => item.color), '#1f2937'),
        fontFamily: mode(globalEntries.map((item) => item.fontFamily), 'system-ui, sans-serif'),
        fontSize: mode(globalEntries.map((item) => item.fontSize), '14px'),
        lineHeight: mode(globalEntries.map((item) => item.lineHeight), '1.5')
      },
      shape: { borderRadius: mode(globalEntries.map((item) => item.borderRadius), '8px') },
      layout: {
        viewportWidth: median(samples.map((sample) => sample.viewport.width), 1440),
        contentWidth: median(samples.flatMap((sample) => sample.boxes.filter((box) => box.role === 'main').map((box) => box.width)), 1200)
      },
      cssVariables: variables
    }
  }
  const components: Record<string, unknown> = {}
  for (const component of componentIds) {
    const style = componentStyle(samples, component)
    if (style) components[component] = style
  }
  return { baseline, components, patterns: patternDocument(samples) }
}

function htmlEscape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char))
}

function previewHtml(baseline: BaselineDocument, components: Record<string, unknown>): string {
  const page = (baseline.globals.page ?? {}) as Record<string, unknown>
  const shape = (baseline.globals.shape ?? {}) as Record<string, unknown>
  const button = (components.button ?? {}) as Record<string, unknown>
  const input = (components.input ?? components.select ?? {}) as Record<string, unknown>
  const table = (components.table ?? {}) as Record<string, unknown>
  const tabs = (components.tabs ?? {}) as Record<string, unknown>
  const radius = htmlEscape(button.borderRadius ?? shape.borderRadius ?? '8px')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:${htmlEscape(page.backgroundColor ?? '#f6f8fb')};color:${htmlEscape(page.color ?? '#1f2937')};font-family:${htmlEscape(page.fontFamily ?? 'system-ui,sans-serif')};font-size:${htmlEscape(page.fontSize ?? '14px')};line-height:${htmlEscape(page.lineHeight ?? '1.5')}}
  .shell{display:grid;grid-template-columns:196px 1fr;min-height:100vh}.side{background:#fff;border-right:1px solid #e5e7eb;padding:22px 14px}.brand{font-weight:700;margin:0 8px 20px}.nav{padding:9px 10px;border-radius:${radius};margin:4px 0}.nav.active{background:#eef4ff;color:#285db7}.main{padding:24px 28px}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.panel{background:#fff;border:1px solid #e6eaf0;border-radius:${htmlEscape(shape.borderRadius ?? '10px')};padding:18px}.filters{display:flex;gap:10px;margin-bottom:14px}.input{height:${htmlEscape(input.height ?? 36)}px;border:1px solid ${htmlEscape(input.borderColor ?? '#d8dee8')};border-radius:${htmlEscape(input.borderRadius ?? radius)};padding:${htmlEscape(input.padding ?? '0 10px')};background:${htmlEscape(input.backgroundColor ?? '#fff')};min-width:180px}.btn{height:${htmlEscape(button.height ?? 36)}px;border:1px solid ${htmlEscape(button.borderColor ?? button.backgroundColor ?? '#285db7')};border-radius:${radius};padding:${htmlEscape(button.padding ?? '0 14px')};background:${htmlEscape(button.backgroundColor ?? '#285db7')};color:${htmlEscape(button.color ?? '#fff')};font-size:${htmlEscape(button.fontSize ?? '14px')};font-weight:${htmlEscape(button.fontWeight ?? '500')}}
  .tabs{display:flex;gap:22px;border-bottom:1px solid #e5e7eb;margin-bottom:14px}.tab{padding:10px 0;border-bottom:2px solid transparent}.tab.active{border-color:${htmlEscape((tabs.borderColor as string) || button.backgroundColor || '#285db7')};font-weight:600}table{width:100%;border-collapse:collapse;background:${htmlEscape(table.backgroundColor ?? '#fff')}}th,td{text-align:left;padding:12px;border-bottom:1px solid ${htmlEscape(table.borderColor ?? '#edf0f4')}}th{font-weight:600}.tag{display:inline-block;padding:3px 8px;border-radius:999px;background:#eef4ff;color:#285db7}
  .modal{margin:26px auto 0;max-width:520px;background:#fff;border:1px solid #e5e7eb;border-radius:${htmlEscape(shape.borderRadius ?? '10px')};box-shadow:0 16px 42px rgba(15,23,42,.12);padding:18px}.muted{color:#758195;font-size:12px}</style></head><body><div class="shell"><aside class="side"><div class="brand">ESPow Internal</div><div class="nav active">客户管理</div><div class="nav">任务中心</div><div class="nav">系统设置</div></aside><main class="main"><div class="head"><div><h2 style="margin:0">客户列表</h2><div class="muted">UI Baseline Preview · ${htmlEscape(baseline.meta.name)}</div></div><button class="btn">新增客户</button></div><section class="panel"><div class="tabs"><div class="tab active">全部</div><div class="tab">待处理</div><div class="tab">已完成</div></div><div class="filters"><div class="input">客户名称</div><div class="input">状态</div><button class="btn">查询</button></div><table><thead><tr><th>客户</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody><tr><td>示例客户 A</td><td><span class="tag">处理中</span></td><td>2026-09-17</td><td>查看</td></tr><tr><td>示例客户 B</td><td><span class="tag">已完成</span></td><td>2026-09-16</td><td>查看</td></tr></tbody></table></section><div class="modal"><strong>编辑客户</strong><p class="muted">用于预览表单、按钮和弹窗的组合效果。</p><div class="filters"><div class="input" style="flex:1">示例内容</div><button class="btn">保存</button></div></div></main></div></body></html>`
}

function captureScript(): string {
  return `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const count = (selector) => [...document.querySelectorAll(selector)].filter(visible).length;
    const style = (el, selector) => { if (!el || !visible(el)) return null; const s=getComputedStyle(el); const r=el.getBoundingClientRect(); return {selector,color:s.color,backgroundColor:s.backgroundColor,borderColor:s.borderColor,borderRadius:s.borderRadius,boxShadow:s.boxShadow,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,height:Math.round(r.height),width:Math.round(r.width),padding:s.padding,margin:s.margin}; };
    const styles = (selector) => [...document.querySelectorAll(selector)].filter(visible).slice(0,8).map((el)=>style(el,selector)).filter(Boolean);
    const cls = (needle) => [...document.querySelectorAll('[class]')].filter((el)=>visible(el) && String(el.className).toLowerCase().includes(needle)).length;
    const metrics = {
      tables: count('table,[role="table"],[role="grid"]'), forms: count('form'), formControls: count('input,select,textarea,[role="combobox"]'), passwordInputs: count('input[type="password"]'), buttons: count('button,[role="button"],input[type="button"],input[type="submit"]'),
      inputs: count('input:not([type="hidden"]),textarea'), selects: count('select,[role="combobox"]'), tabs: count('[role="tab"],.tabs .tab,.ant-tabs-tab,.el-tabs__item'),
      modals: count('[role="dialog"],dialog,.modal,.ant-modal,.el-dialog'), drawers: count('.drawer,.ant-drawer,.el-drawer,[class*="drawer" i]'),
      paginations: count('[class*="pagination" i],[aria-label*="pagination" i],.ant-pagination,.el-pagination'), searchAreas: count('[class*="search" i],[class*="filter" i],form[role="search"]'),
      tags: count('.tag,.badge,[class*="tag" i],[class*="badge" i],[class*="status" i]'), cards: count('.card,[class*="card" i],.ant-card,.el-card'),
      headers: count('header,[class*="header" i]'), sidebars: count('aside,[class*="sidebar" i],[class*="sider" i]'),
      detailPairs: count('dl dt,[class*="description" i] dt,[class*="detail" i] [class*="label" i]'), infoSections: count('[class*="detail" i] section,[class*="info" i] section'),
      dashboardCards: count('[class*="metric" i],[class*="stat" i],.ant-statistic'), charts: count('canvas,svg[class*="chart" i],[class*="echarts" i]')
    };
    const componentStyles = {
      button: styles('button,[role="button"]'), input: styles('input:not([type="hidden"]),textarea'), select: styles('select,[role="combobox"]'), search: styles('[class*="search" i],[class*="filter" i]'),
      table: styles('table,[role="table"],[role="grid"]'), pagination: styles('[class*="pagination" i],.ant-pagination,.el-pagination'), tabs: styles('[role="tab"],.ant-tabs-tab,.el-tabs__item'),
      tag: styles('.tag,.badge,[class*="tag" i],[class*="badge" i],[class*="status" i]'), form: styles('form'), modal: styles('[role="dialog"],dialog,.modal,.ant-modal,.el-dialog'),
      drawer: styles('.drawer,.ant-drawer,.el-drawer,[class*="drawer" i]'), card: styles('.card,[class*="card" i],.ant-card,.el-card'), header: styles('header,[class*="header" i]'), sidebar: styles('aside,[class*="sidebar" i],[class*="sider" i]')
    };
    const rootStyle=getComputedStyle(document.documentElement); const cssVariables={}; for (const key of [...rootStyle].filter((key)=>key.startsWith('--')).slice(0,80)) { const v=rootStyle.getPropertyValue(key).trim(); if(v && v.length<160) cssVariables[key]=v; }
    const boxes=[...document.querySelectorAll('main,header,aside,nav,form,table,[role="dialog"]')].filter(visible).slice(0,30).map((el)=>{const r=el.getBoundingClientRect();return {role:(el.getAttribute('role')||el.tagName).toLowerCase(),x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}});
    return {url:location.href,viewport:{width:innerWidth,height:innerHeight},metrics,globalStyle:style(document.body,'body'),componentStyles,cssVariables,boxes};
  })()`
}

export class PrototypeStyleService {
  private timer: NodeJS.Timeout | null = null
  private captureBusy = false
  private manifest: LearningManifest | null = null

  constructor(private readonly root: string, private readonly runtime: RuntimeService) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    const manifest = await this.readJson<LearningManifest>(join(this.root, 'learning.json'))
    if (manifest?.status === 'learning') {
      manifest.status = 'interrupted'
      manifest.message = '上次界面学习被中断，可重新开始学习；已采集样本仍保留。'
      manifest.updatedAt = new Date().toISOString()
      await this.writeJson(join(this.root, 'learning.json'), manifest)
    }
    this.manifest = manifest
  }

  async getState(): Promise<PrototypeStyleState> {
    const current = await this.readUsableCurrentManifest()
    const candidate = await this.readCandidate()
    const samples = await this.readSamples()
    const coverage = buildCoverage(samples)
    const manifest = this.manifest ?? await this.readJson<LearningManifest>(join(this.root, 'learning.json'))
    return {
      baseline: current ? {
        configured: true, name: current.name, learnedPageCount: current.learnedPageCount, patternCount: current.patternCount,
        componentCount: current.componentCount, updatedAt: current.updatedAt, version: current.version
      } : { configured: false, name: null, learnedPageCount: 0, patternCount: 0, componentCount: 0, updatedAt: null, version: null },
      learning: {
        status: manifest?.status ?? 'idle', sessionId: manifest?.sessionId ?? null, sourceUrl: manifest?.sourceUrl ?? null,
        startedAt: manifest?.startedAt ?? null, updatedAt: manifest?.updatedAt ?? null, learnedPageCount: samples.length,
        coverage, message: manifest?.message ?? null
      },
      candidate
    }
  }

  async startLearning(input: StartUiLearningInput): Promise<PrototypeStyleState> {
    const sourceUrl = validLearningUrl(input.url)
    await this.closeBrowser()
    await fs.rm(join(this.root, 'candidate'), { recursive: true, force: true })
    const current = await this.readUsableCurrentManifest()
    const sessionId = randomUUID()
    const now = new Date().toISOString()
    this.manifest = {
      sessionId,
      name: input.name?.trim() || current?.name || '公司后台默认样式',
      sourceUrl,
      startedAt: now,
      updatedAt: now,
      status: 'learning',
      message: '请像平时一样浏览几个常用页面，ESPow 会自动学习界面风格。'
    }
    await fs.mkdir(join(this.root, 'learning', sessionId, 'references'), { recursive: true })
    await this.writeJson(join(this.root, 'learning.json'), this.manifest)
    await this.openBrowser(sourceUrl)
    return this.getState()
  }

  async openLearningBrowser(): Promise<PrototypeStyleState> {
    if (!this.manifest?.sourceUrl) return this.getState()
    if (this.manifest.status !== 'learning') {
      this.manifest.status = 'learning'
      this.manifest.message = '已继续界面学习；请像平时一样浏览页面。'
      this.manifest.updatedAt = new Date().toISOString()
      await fs.rm(join(this.root, 'candidate'), { recursive: true, force: true })
      await this.writeJson(join(this.root, 'learning.json'), this.manifest)
    }
    const browser = await this.runtime.uiLearningStatus().catch(() => ({ active: false }))
    if (!browser.active) await this.openBrowser(this.manifest.sourceUrl)
    else await this.runtime.focusUiLearning()
    return this.getState()
  }

  async stopLearning(): Promise<PrototypeStyleState> {
    await this.closeBrowser()
    if (this.manifest?.status === 'learning') {
      this.manifest.status = 'interrupted'
      this.manifest.message = '学习已暂停；已采集样本保留。'
      this.manifest.updatedAt = new Date().toISOString()
      await this.writeJson(join(this.root, 'learning.json'), this.manifest)
    }
    return this.getState()
  }

  async finishLearning(): Promise<PrototypeStyleState> {
    if (!this.manifest) throw new Error('尚未开始界面学习。')
    await this.captureCurrentPage()
    const samples = await this.readSamples()
    if (!samples.length) throw new Error('还没有采集到可用页面，请先在学习浏览器中打开至少一个页面。')
    await this.closeBrowser()
    const current = await this.readUsableCurrentManifest()
    const version = (current?.version ?? 0) + 1
    const now = new Date().toISOString()
    const docs = buildBaselineDocuments(samples, this.manifest.name, this.manifest.sourceUrl, version, now)
    const patterns = docs.patterns
    const components = docs.components
    const coverage = buildCoverage(samples)
    const candidate: CandidateManifest = {
      id: this.manifest.sessionId,
      name: this.manifest.name,
      sourceUrl: sanitizeRoute(this.manifest.sourceUrl),
      createdAt: now,
      learnedPageCount: samples.length,
      patternCount: Object.keys(patterns).length,
      componentCount: Object.keys(components).length,
      version,
      directory: 'candidate'
    }
    const candidateDir = join(this.root, 'candidate')
    await fs.rm(candidateDir, { recursive: true, force: true })
    await fs.mkdir(join(candidateDir, 'references'), { recursive: true })
    for (const sample of samples) {
      if (!sample.screenshotPath) continue
      const source = join(this.root, 'learning', this.manifest.sessionId, sample.screenshotPath)
      try { await fs.copyFile(source, join(candidateDir, 'references', basename(sample.screenshotPath))) } catch { /* Reference screenshots are optional. */ }
    }
    await fs.writeFile(join(candidateDir, 'baseline.yaml'), stringifyYaml(docs.baseline), 'utf8')
    await fs.writeFile(join(candidateDir, 'components.yaml'), stringifyYaml(components), 'utf8')
    await fs.writeFile(join(candidateDir, 'patterns.yaml'), stringifyYaml(patterns), 'utf8')
    await fs.writeFile(join(candidateDir, 'preview.html'), previewHtml(docs.baseline, components), 'utf8')
    await this.writeJson(join(candidateDir, 'manifest.json'), candidate)
    await this.writeJson(join(candidateDir, 'coverage.json'), coverage)
    this.manifest.status = 'candidate-ready'
    this.manifest.message = 'UI Baseline 已生成候选，请预览确认后保存。'
    this.manifest.updatedAt = now
    await this.writeJson(join(this.root, 'learning.json'), this.manifest)
    return this.getState()
  }

  async saveCandidate(): Promise<PrototypeStyleState> {
    const candidate = await this.readCandidateManifest()
    if (!candidate) throw new Error('没有可保存的 UI Baseline 候选。')
    const candidateDir = join(this.root, 'candidate')
    const currentDir = join(this.root, 'current')
    const staging = join(this.root, `.current-${randomUUID()}`)
    const backup = join(this.root, `.current-backup-${randomUUID()}`)
    await fs.cp(candidateDir, staging, { recursive: true })
    // Validate the structured assets before replacing the last known-good baseline.
    parseYaml(await fs.readFile(join(staging, 'baseline.yaml'), 'utf8'))
    parseYaml(await fs.readFile(join(staging, 'components.yaml'), 'utf8'))
    parseYaml(await fs.readFile(join(staging, 'patterns.yaml'), 'utf8'))
    const manifest: CurrentManifest = {
      name: candidate.name, version: candidate.version, sourceUrl: candidate.sourceUrl, updatedAt: candidate.createdAt,
      learnedPageCount: candidate.learnedPageCount, patternCount: candidate.patternCount, componentCount: candidate.componentCount
    }
    await this.writeJson(join(staging, 'manifest.json'), manifest)
    let backedUp = false
    try {
      try { await fs.rename(currentDir, backup); backedUp = true } catch { /* First configuration has no current directory. */ }
      await fs.rename(staging, currentDir)
      if (backedUp) await fs.rm(backup, { recursive: true, force: true })
    } catch (error) {
      await fs.rm(currentDir, { recursive: true, force: true }).catch(() => undefined)
      if (backedUp) await fs.rename(backup, currentDir).catch(() => undefined)
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    await fs.rm(candidateDir, { recursive: true, force: true })
    if (this.manifest) {
      this.manifest.status = 'interrupted'
      this.manifest.message = '已保存为当前原型样式。需要更新时可重新学习。'
      this.manifest.updatedAt = new Date().toISOString()
      await this.writeJson(join(this.root, 'learning.json'), this.manifest)
    }
    return this.getState()
  }

  async discardCandidate(): Promise<PrototypeStyleState> {
    await fs.rm(join(this.root, 'candidate'), { recursive: true, force: true })
    if (this.manifest?.status === 'candidate-ready') {
      this.manifest.status = 'interrupted'
      this.manifest.message = '候选已丢弃；采集样本仍保留，可重新学习。'
      this.manifest.updatedAt = new Date().toISOString()
      await this.writeJson(join(this.root, 'learning.json'), this.manifest)
    }
    return this.getState()
  }

  async getPreview(): Promise<UiBaselinePreviewResult> {
    const candidate = await this.readCandidate()
    if (candidate) return { candidate, html: await fs.readFile(join(this.root, 'candidate', 'preview.html'), 'utf8') }
    const current = await this.readUsableCurrentManifest()
    if (!current) return { candidate: null, html: null, error: '尚未配置原型样式。' }
    try { return { candidate: null, html: await fs.readFile(join(this.root, 'current', 'preview.html'), 'utf8') } }
    catch { return { candidate: null, html: null, error: '当前 UI Baseline 预览文件不可用，请重新学习。' } }
  }

  async resolveContext(hint: string): Promise<UiBaselineContext | null> {
    const currentDir = join(this.root, 'current')
    const manifest = await this.readUsableCurrentManifest()
    if (!manifest) return null
    try {
      const baseline = parseYaml(await fs.readFile(join(currentDir, 'baseline.yaml'), 'utf8')) as BaselineDocument
      const allComponents = parseYaml(await fs.readFile(join(currentDir, 'components.yaml'), 'utf8')) as Record<string, unknown>
      const allPatterns = parseYaml(await fs.readFile(join(currentDir, 'patterns.yaml'), 'utf8')) as Record<string, unknown>
      const lower = hint.toLowerCase()
      const wantedPatterns = new Set<string>()
      const wantedComponents = new Set<string>()
      const rules: Array<[RegExp, string, string[]]> = [
        [/(列表|list|table|表格|分页|查询|筛选)/i, 'list_page', ['table', 'pagination', 'search', 'button']],
        [/(详情|detail|summary|信息区)/i, 'detail_page', ['card', 'tabs', 'tag', 'button']],
        [/(新增|编辑|表单|form|input|select)/i, 'form_page', ['form', 'input', 'select', 'button']],
        [/(dashboard|看板|指标|统计)/i, 'dashboard_page', ['card', 'tag']],
        [/(弹窗|modal|dialog)/i, 'modal_page', ['modal', 'button', 'input']],
        [/(抽屉|drawer)/i, 'drawer_page', ['drawer', 'button', 'input']],
        [/(tabs?|标签页)/i, '', ['tabs']], [/(导航|sidebar|侧边栏)/i, '', ['sidebar', 'header']]
      ]
      for (const [pattern, page, components] of rules) if (pattern.test(lower)) { if (page) wantedPatterns.add(page); components.forEach((item) => wantedComponents.add(item)) }
      if (!wantedPatterns.size) {
        const firstPattern = Object.keys(allPatterns)[0]
        if (firstPattern) wantedPatterns.add(firstPattern)
      }
      if (!wantedComponents.size) ['button', 'input', 'table', 'tabs'].forEach((item) => wantedComponents.add(item))
      const pattern = Object.fromEntries([...wantedPatterns].filter((key) => key in allPatterns).map((key) => [key, allPatterns[key]]))
      const components = Object.fromEntries([...wantedComponents].filter((key) => key in allComponents).slice(0, 6).map((key) => [key, allComponents[key]]))
      const baselineGlobals = baseline.globals as Record<string, unknown>
      const allVariables = (baselineGlobals.cssVariables ?? {}) as Record<string, unknown>
      const selectedVariables = Object.fromEntries(Object.entries(allVariables)
        .filter(([key]) => /(color|font|radius|space|gap|padding|height|width)/i.test(key))
        .slice(0, 16))
      const globals = {
        page: baselineGlobals.page ?? {},
        shape: baselineGlobals.shape ?? {},
        layout: baselineGlobals.layout ?? {},
        ...(Object.keys(selectedVariables).length ? { cssVariables: selectedVariables } : {})
      }
      return {
        version: manifest.version, name: manifest.name, updatedAt: manifest.updatedAt,
        globals, pattern, components,
        loadedKeys: ['globals.page', 'globals.shape', 'globals.layout', ...Object.keys(pattern).map((key) => `patterns.${key}`), ...Object.keys(components).map((key) => `components.${key}`)]
      }
    } catch {
      return null
    }
  }

  async close(): Promise<void> { await this.closeBrowser() }

  private async openBrowser(url: string): Promise<void> {
    await this.closeBrowser()
    const profileDir = join(this.root, 'browser-profile')
    await fs.mkdir(profileDir, { recursive: true })
    try {
      await this.runtime.startUiLearning(url, profileDir)
      this.timer = setInterval(() => { void this.captureCurrentPage() }, captureIntervalMs)
    } catch (error) {
      await this.markLearningInterrupted('Rust Playwright 学习浏览器启动失败；已保留当前采集记录。')
      throw error
    }
  }

  private async captureCurrentPage(): Promise<void> {
    const manifest = this.manifest
    if (!manifest || manifest.status !== 'learning' || this.captureBusy) return
    this.captureBusy = true
    let raw: RawCapture | null = null
    try {
      const result = await this.runtime.captureUiLearning(captureScript())
      raw = result.capture as RawCapture | null
    } catch {
      const status = await this.runtime.uiLearningStatus().catch(() => ({ active: false }))
      if (!status.active) {
        this.stopTimer()
        await this.markLearningInterrupted('学习浏览器已关闭；已采集样本保留。')
      }
      this.captureBusy = false
      return
    }
    try {
      if (!raw?.metrics || !raw.viewport) return
      // Login/authentication pages are intentionally excluded from UI learning.
      const authRoute = /\/(?:login|sign-?in|auth|sso|oauth)(?:\/|$)/i.test(new URL(raw.url).pathname)
      if ((raw.metrics.passwordInputs ?? 0) > 0 || (authRoute && (raw.metrics.tables ?? 0) === 0 && (raw.metrics.formControls ?? 0) <= 5)) return
      const classified = classifyCapture(raw)
      const route = sanitizeRoute(raw.url)
      const structuralSignature = {
        route,
        patterns: [...classified.patterns].sort(),
        components: [...classified.components].sort(),
        viewport: raw.viewport,
        boxes: (raw.boxes ?? []).map((box) => ({ role: box.role, width: Math.round(box.width / 20) * 20, height: Math.round(box.height / 20) * 20 }))
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(structuralSignature)).digest('hex').slice(0, 20)
      const samples = await this.readSamples()
      if (samples.some((sample) => sample.fingerprint === fingerprint)) return
      const sessionDir = join(this.root, 'learning', manifest.sessionId)
      const id = `sample-${String(samples.length + 1).padStart(3, '0')}-${fingerprint.slice(0, 6)}`
      let screenshotPath: string | null = null
      try {
        screenshotPath = `references/${id}.png`
        await this.runtime.screenshotUiLearning(join(sessionDir, screenshotPath), screenshotSanitizeCss)
      } catch { screenshotPath = null /* Screenshot is optional; structural capture remains useful. */ }
      const sample: UiLearningSample = {
        id, route, capturedAt: new Date().toISOString(), fingerprint,
        patterns: classified.patterns, components: classified.components, metrics: raw.metrics, viewport: raw.viewport,
        globalStyle: raw.globalStyle, componentStyles: raw.componentStyles ?? {}, cssVariables: raw.cssVariables ?? {}, boxes: raw.boxes ?? [], screenshotPath
      }
      await fs.writeFile(join(sessionDir, `${id}.json`), `${JSON.stringify(sample, null, 2)}\n`, 'utf8')
      manifest.updatedAt = sample.capturedAt
      manifest.message = buildCoverage([...samples, sample]).nextSuggestion ?? '界面学习已经比较完整，可以现在完成。'
      await this.writeJson(join(this.root, 'learning.json'), manifest)
    } catch { /* Login/transition pages can be temporarily inaccessible; next polling cycle retries. */ }
    finally { this.captureBusy = false }
  }

  private async markLearningInterrupted(message: string): Promise<void> {
    if (this.manifest?.status !== 'learning') return
    this.manifest.status = 'interrupted'
    this.manifest.message = message
    this.manifest.updatedAt = new Date().toISOString()
    await this.writeJson(join(this.root, 'learning.json'), this.manifest)
  }

  private async readSamples(): Promise<UiLearningSample[]> {
    const sessionId = this.manifest?.sessionId
    if (!sessionId) return []
    const directory = join(this.root, 'learning', sessionId)
    try {
      const names = (await fs.readdir(directory)).filter((name) => /^sample-.+\.json$/.test(name)).sort()
      const samples: UiLearningSample[] = []
      for (const name of names) {
        const value = await this.readJson<UiLearningSample>(join(directory, name))
        if (value) samples.push(value)
      }
      return samples
    } catch { return [] }
  }

  private async readCandidateManifest(): Promise<CandidateManifest | null> { return this.readJson<CandidateManifest>(join(this.root, 'candidate', 'manifest.json')) }
  private async readCandidate(): Promise<UiBaselineCandidateSummary | null> {
    const value = await this.readCandidateManifest()
    if (!value) return null
    const { id, name, sourceUrl, createdAt, learnedPageCount, patternCount, componentCount } = value
    return { id, name, sourceUrl, createdAt, learnedPageCount, patternCount, componentCount }
  }

  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
  private async closeBrowser(): Promise<void> {
    this.stopTimer()
    await this.runtime.stopUiLearning().catch(() => undefined)
  }

  private async readUsableCurrentManifest(): Promise<CurrentManifest | null> {
    const currentDir = join(this.root, 'current')
    const manifest = await this.readJson<CurrentManifest>(join(currentDir, 'manifest.json'))
    if (!manifest) return null
    try {
      parseYaml(await fs.readFile(join(currentDir, 'baseline.yaml'), 'utf8'))
      parseYaml(await fs.readFile(join(currentDir, 'components.yaml'), 'utf8'))
      parseYaml(await fs.readFile(join(currentDir, 'patterns.yaml'), 'utf8'))
      return manifest
    } catch { return null }
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try { return JSON.parse(await fs.readFile(path, 'utf8')) as T } catch { return null }
  }
  private async writeJson(path: string, value: unknown): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }
}
