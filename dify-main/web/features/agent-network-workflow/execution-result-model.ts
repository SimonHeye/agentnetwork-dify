import {
  formatAgentNetworkFinalResult,
  unwrapAgentNetworkFinalResult,
} from './format-execute-result'

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
])

const URL_FIELDS = ['url', 'file_url', 'download_url', 'href'] as const
const NAME_FIELDS = ['filename', 'file_name', 'name'] as const
const MIME_FIELDS = ['mime_type', 'mimeType', 'content_type'] as const

export type AgentNetworkExecutionResultPresentation
  = | {
    kind: 'text'
    value: string
  }
  | {
    kind: 'number'
    value: number
  }
  | {
    kind: 'json'
    value: string
  }
  | {
    kind: 'resource'
    resourceKind: 'image' | 'file'
    url: string
    name: string
    extension: string
    mimeType: string | undefined
  }

export function normalizeAgentNetworkExecutionResult(
  finalResult: unknown,
): AgentNetworkExecutionResultPresentation {
  const value = unwrapAgentNetworkFinalResult(finalResult)

  if (typeof value === 'number')
    return { kind: 'number', value }

  if (typeof value === 'string') {
    const resource = parseStringResource(value)
    return resource ?? { kind: 'text', value }
  }

  const structuredResource = parseStructuredResource(value)
  if (structuredResource)
    return structuredResource

  if (value === undefined)
    return { kind: 'text', value: '' }

  return {
    kind: 'json',
    value: formatAgentNetworkFinalResult(value),
  }
}

function parseStringResource(value: string): Extract<AgentNetworkExecutionResultPresentation, { kind: 'resource' }> | null {
  const trimmed = value.trim()
  const markdownLink = trimmed.match(/^!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/i)
  if (markdownLink) {
    const label = markdownLink[1]?.trim()
    const url = markdownLink[2]
    if (url)
      return createResource(url, label || undefined)
  }

  return createResource(trimmed)
}

function parseStructuredResource(value: unknown): Extract<AgentNetworkExecutionResultPresentation, { kind: 'resource' }> | null {
  if (!isRecord(value))
    return null

  const url = getStringField(value, URL_FIELDS)
  if (!url)
    return null

  return createResource(
    url,
    getStringField(value, NAME_FIELDS),
    getStringField(value, MIME_FIELDS),
  )
}

function createResource(
  value: string,
  preferredName?: string,
  preferredMimeType?: string,
): Extract<AgentNetworkExecutionResultPresentation, { kind: 'resource' }> | null {
  const url = parseHttpUrl(value)
  if (!url)
    return null

  const mimeType = preferredMimeType
    || url.searchParams.get('response-content-type')
    || url.searchParams.get('content-type')
    || undefined
  const pathName = safeDecodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
  const queryName = getQueryFileName(url)
  const name = preferredName?.trim() || queryName || pathName || url.hostname
  const extension = fileExtension(pathName || name)
  const resourceKind = mimeType?.toLowerCase().startsWith('image/')
    || IMAGE_EXTENSIONS.has(extension)
    ? 'image'
    : 'file'

  return {
    kind: 'resource',
    resourceKind,
    url: url.toString(),
    name,
    extension,
    mimeType,
  }
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
    ) {
      return null
    }
    return url
  }
  catch {
    return null
  }
}

function getQueryFileName(url: URL): string {
  for (const key of ['filename', 'file_name', 'name']) {
    const value = url.searchParams.get(key)?.trim()
    if (value)
      return safeDecodeURIComponent(value)
  }

  const disposition = url.searchParams.get('response-content-disposition')
  const match = disposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)
  return match?.[1] ? safeDecodeURIComponent(match[1].trim()) : ''
}

function fileExtension(name: string): string {
  const match = name.match(/\.([a-z0-9]{1,12})$/i)
  return match?.[1]?.toLowerCase() ?? ''
}

function getStringField(
  value: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const item = value[field]
    if (typeof item === 'string' && item.trim())
      return item.trim()
  }
  return undefined
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
