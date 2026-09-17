import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBaselineDocuments, buildCoverage, classifyCapture, sanitizeRoute } from './prototypeStyleService'

test('sanitizeRoute removes query/hash and masks dynamic ids', () => {
  assert.equal(
    sanitizeRoute('https://internal.example.com/customer/123456?token=secret#detail'),
    'https://internal.example.com/customer/:id'
  )
})

test('classifyCapture identifies common list-page components without LLM', () => {
  const result = classifyCapture({ metrics: {
    tables: 1, forms: 0, formControls: 2, detailPairs: 0, infoSections: 0, dashboardCards: 0, charts: 0,
    modals: 0, drawers: 0, buttons: 3, inputs: 1, selects: 1, searchAreas: 1, paginations: 1, tabs: 1,
    tags: 1, cards: 0, headers: 1, sidebars: 1
  } })
  assert.ok(result.patterns.includes('list'))
  assert.ok(result.components.includes('table'))
  assert.ok(result.components.includes('pagination'))
  assert.ok(result.components.includes('search'))
})

test('coverage and baseline are derived from sanitized structural samples', () => {
  const sample = {
    id: 'sample-001', route: 'https://internal.example.com/list', capturedAt: '2026-09-17T00:00:00.000Z', fingerprint: 'abc',
    patterns: ['list'] as const, components: ['button', 'table', 'pagination'] as const, metrics: {}, viewport: { width: 1440, height: 900 },
    globalStyle: { selector: 'body', color: '#111827', backgroundColor: '#f8fafc', borderColor: 'transparent', borderRadius: '0px', boxShadow: 'none', fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', lineHeight: '20px', height: 900, width: 1440, padding: '0px', margin: '0px' },
    componentStyles: {
      button: [{ selector: 'button', color: '#fff', backgroundColor: '#285db7', borderColor: '#285db7', borderRadius: '8px', boxShadow: 'none', fontFamily: 'Inter', fontSize: '14px', fontWeight: '500', lineHeight: '20px', height: 36, width: 80, padding: '0 14px', margin: '0' }],
      table: [{ selector: 'table', color: '#111827', backgroundColor: '#fff', borderColor: '#e5e7eb', borderRadius: '0px', boxShadow: 'none', fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', lineHeight: '20px', height: 500, width: 1200, padding: '0px', margin: '0px' }]
    },
    cssVariables: { '--primary-color': '#285db7' }, boxes: [{ role: 'main', x: 200, y: 0, width: 1200, height: 900 }], screenshotPath: null
  }
  const coverage = buildCoverage([sample as never])
  assert.equal(coverage.pagePatterns.list, true)
  assert.equal(coverage.components.table, true)
  const docs = buildBaselineDocuments([sample as never], 'Default UI', 'https://internal.example.com', 1, '2026-09-17T00:00:00.000Z')
  assert.ok(docs.patterns.list_page)
  assert.ok(docs.components.button)
  assert.equal((docs.baseline.globals.page as Record<string, unknown>).fontFamily, 'Inter')
})
