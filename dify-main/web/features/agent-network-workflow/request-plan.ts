import { basePath } from '@/utils/var'

type PlanResponse = {
  pseudocode?: unknown
  code?: unknown
  message?: unknown
}

export type AgentNetworkPlanResult = {
  pseudocode: string
}

export async function requestAgentNetworkPlan(input: {
  appId: string
  task: string
  includeAgents?: boolean
  model?: string
  extraInstructions?: string
}): Promise<AgentNetworkPlanResult> {
  const response = await fetch(`${basePath}/internal/agent-network/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      ...input,
      includeAgents: input.includeAgents ?? false,
    }),
  })
  const body = await readResponse(response)

  if (!response.ok) {
    const message = typeof body.message === 'string'
      ? body.message
      : typeof body.code === 'string' ? body.code : 'AGENT_NETWORK_REQUEST_FAILED'
    throw new Error(message)
  }
  if (typeof body.pseudocode !== 'string')
    throw new Error('AGENT_NETWORK_INVALID_RESPONSE')

  return {
    pseudocode: body.pseudocode,
  }
}

async function readResponse(response: Response): Promise<PlanResponse> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null ? value as PlanResponse : {}
  }
  catch {
    return {}
  }
}
