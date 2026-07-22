export function isSameOriginRequest(request: Request): boolean {
  const origin = normalizedOrigin(request.headers.get('origin'))
  if (!origin)
    return true

  const directOrigin = normalizedOrigin(request.url)
  if (origin === directOrigin)
    return true

  const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'))
  const forwardedHost = firstHeaderValue(
    request.headers.get('x-forwarded-host') || request.headers.get('host'),
  )
  if (!forwardedProto || !forwardedHost)
    return false

  const forwardedPort = firstHeaderValue(request.headers.get('x-forwarded-port'))
  const defaultPort = forwardedProto === 'https' ? '443' : '80'
  const authority = forwardedPort && forwardedPort !== defaultPort && !hasExplicitPort(forwardedHost)
    ? `${forwardedHost}:${forwardedPort}`
    : forwardedHost

  return origin === normalizedOrigin(`${forwardedProto}://${authority}`)
}

function firstHeaderValue(value: string | null): string {
  return value?.split(',')[0]?.trim() ?? ''
}

function hasExplicitPort(host: string): boolean {
  if (host.startsWith('['))
    return host.includes(']:')
  return host.includes(':')
}

function normalizedOrigin(value: string | null): string | null {
  if (!value)
    return null
  try {
    return new URL(value).origin
  }
  catch {
    return null
  }
}
