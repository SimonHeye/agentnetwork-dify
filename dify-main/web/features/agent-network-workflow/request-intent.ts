import { basePath } from '@/utils/var'

export type AgentNetworkIntentResult = {
  normalizedTask: string
  extraInstructions: string
}

export async function requestAgentNetworkIntent(input: { task: string }): Promise<AgentNetworkIntentResult> {
  const response = await fetch(`${basePath}/internal/agent-network/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  })
  const body: unknown = await response.json()

  if (!response.ok)
    throw new Error('AGENT_NETWORK_INTENT_FAILED')
  if (!isIntentResult(body))
    throw new Error('AGENT_NETWORK_INTENT_INVALID_RESPONSE')

  return body
}

function isIntentResult(value: unknown): value is AgentNetworkIntentResult {
  if (!value || typeof value !== 'object')
    return false
  const result = value as Record<string, unknown>
  return typeof result.normalizedTask === 'string'
    && typeof result.extraInstructions === 'string'
}
