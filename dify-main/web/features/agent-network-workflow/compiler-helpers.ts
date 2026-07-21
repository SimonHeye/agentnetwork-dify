import type { ParsedComparison, ParsedValue } from './python-syntax'

export function schemaTypeForComparison(comparison: ParsedComparison): 'string' | 'number' | 'boolean' {
  if (comparison.value?.expr !== 'const')
    return 'string'
  if (comparison.value.valueType === 'int' || comparison.value.valueType === 'float')
    return 'number'
  if (comparison.value.valueType === 'bool')
    return 'boolean'
  return 'string'
}

export function schemaTypeForInput(input: string | undefined): string {
  if (input === 'number')
    return 'number'
  if (input === 'file' || input === 'file-list')
    return input
  return 'string'
}

export function difyVariableType(type: string): string {
  return type === 'file-list' ? 'array[file]' : type
}

export function inputType(type: string): string {
  const types: Record<string, string> = {
    'paragraph': 'text-input',
    'text-input': 'text-input',
    'number': 'number',
    'file': 'file',
    'file-list': 'file-list',
    'select': 'select',
  }
  return types[type] ?? 'text-input'
}

export function selectorTemplate(selector: string[]): string {
  return `{{#${selector.join('.')}#}}`
}

export function cloneProducerMap(value: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value).map(([name, sources]) => [name, [...sources]]))
}

export function mergeProducerMaps(values: Array<Record<string, string[]>>): Record<string, string[]> {
  const merged: Record<string, string[]> = {}
  for (const value of values) {
    for (const [name, sources] of Object.entries(value))
      merged[name] = [...new Set([...(merged[name] ?? []), ...sources])]
  }
  return merged
}

export function intersectSets(values: Set<string>[]): Set<string> {
  if (!values.length)
    return new Set()
  return new Set([...values[0]!].filter(value => values.every(items => items.has(value))))
}

export function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function conditionValue(operator: string, value: ParsedValue | null): string | boolean | null {
  if (operator === 'truthy' || operator === 'falsy')
    return ''
  if (value?.expr !== 'const')
    return null
  if (value.value === null)
    return ''
  return typeof value.value === 'boolean' ? value.value : `${value.value}`
}
