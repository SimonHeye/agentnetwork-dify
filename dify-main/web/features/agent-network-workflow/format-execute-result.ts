export function unwrapAgentNetworkFinalResult(finalResult: unknown): unknown {
  if (
    finalResult
    && typeof finalResult === 'object'
    && !Array.isArray(finalResult)
    && Object.hasOwn(finalResult, 'value')
  ) {
    return (finalResult as Record<string, unknown>).value
  }

  return finalResult
}

export function formatAgentNetworkFinalResult(finalResult: unknown): string {
  const value = unwrapAgentNetworkFinalResult(finalResult)
  if (typeof value === 'string')
    return value
  if (value === undefined)
    return ''

  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  }
  catch {
    return String(value)
  }
}
