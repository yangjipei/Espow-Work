import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const task = process.argv.slice(2).join(' ').trim()
const mapUrl = new URL('../.agent/feature-map.json', import.meta.url)
const map = JSON.parse(await readFile(fileURLToPath(mapUrl), 'utf8'))

const normalize = (value) => value.toLocaleLowerCase('zh-CN').replace(/[\s_-]+/g, '')
const normalizedTask = normalize(task)

const scoreTerms = (terms = [], base = 0) => terms.reduce((score, term) => {
  const normalizedTerm = normalize(term)
  return normalizedTerm && normalizedTask.includes(normalizedTerm)
    ? score + base + normalizedTerm.length
    : score
}, 0)

const rankedFeatures = map.features
  .map((feature) => ({ feature, score: scoreTerms(feature.aliases, 100) }))
  .filter(({ score }) => score > 0)
  .sort((left, right) => right.score - left.score)

if (!task || rankedFeatures.length === 0) {
  console.log('CONTEXT_NOT_FOUND')
  process.exit(0)
}

const feature = rankedFeatures[0].feature
const rankedScopes = Object.entries(feature.scopes)
  .map(([id, scope]) => ({ id, scope, score: scoreTerms(scope.keywords, 10) }))
  .sort((left, right) => right.score - left.score)
const matchedScope = rankedScopes.find(({ score }) => score > 0)
  ?? rankedScopes.find(({ id }) => id === feature.defaultScope)
const scope = matchedScope.scope

const excludedDirectories = map.excluded
  .filter((entry) => entry.endsWith('/'))
  .map((entry) => entry.slice(0, -1))
const excludedFileFragments = map.excluded
  .filter((entry) => entry.startsWith('*'))
  .map((entry) => entry.slice(1).replace(/\*$/, ''))
const isExcluded = (path) => {
  const normalizedPath = path.replaceAll('\\', '/')
  const segments = normalizedPath.split('/')
  return excludedDirectories.some((directory) =>
    normalizedPath === directory
    || normalizedPath.startsWith(`${directory}/`)
    || segments.includes(directory)
  ) || excludedFileFragments.some((fragment) => normalizedPath.includes(fragment))
}
const safePaths = (paths) => paths.filter((path) => !isExcluded(path))
const printPaths = (label, paths) => {
  console.log(`${label}:`)
  const safe = safePaths(paths)
  console.log(safe.length ? safe.join('\n') : '(none)')
}

console.log('FEATURE_CONTEXT')
console.log('')
console.log('Task:')
console.log(task)
console.log('')
console.log('Feature:')
console.log(feature.id)
console.log('')
console.log('Scope:')
console.log(matchedScope.id)
console.log('')
printPaths('PRIMARY', scope.primary)
console.log('')
printPaths('RELATED', scope.related)
console.log('')
printPaths('TESTS', scope.tests)
