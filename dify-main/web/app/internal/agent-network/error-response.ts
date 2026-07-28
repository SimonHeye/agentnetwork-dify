const MAX_ERROR_MESSAGE_LENGTH = 10_000

export async function readAgentNetworkErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.text()).trim()
    if (!body)
      return httpFallback(response)

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('application/json')) {
      const message = readJsonErrorMessage(body)
      if (message)
        return truncate(message)
    }

    if (contentType.includes('text/html') || looksLikeHtml(body)) {
      const message = htmlToText(body)
      return truncate(message || httpFallback(response))
    }

    return truncate(body)
  }
  catch {
    return httpFallback(response)
  }
}

function readJsonErrorMessage(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body)
    if (typeof value === 'string')
      return value.trim() || null
    if (!isRecord(value))
      return null
    for (const key of ['message', 'error', 'detail', 'description']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate.trim())
        return candidate.trim()
    }
    return null
  }
  catch {
    return null
  }
}

function htmlToText(body: string): string {
  return decodeHtmlEntities(
    body
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter((line, index, lines) => line && line !== lines[index - 1])
    .join('\n')
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
}

function looksLikeHtml(value: string): boolean {
  return /^\s*<!doctype html|^\s*<html\b|<body\b|<h[1-6]\b/i.test(value)
}

function httpFallback(response: Response): string {
  const status = response.statusText.trim()
  return `AgentNetwork request failed (HTTP ${response.status}${status ? ` ${status}` : ''})`
}

function truncate(value: string): string {
  return value.slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
