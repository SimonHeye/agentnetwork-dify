import { basePath } from '@/utils/var'

type PlanResponse = {
  request_id?: unknown
  pseudocode?: unknown
  code?: unknown
}

export type AgentNetworkPlanResult = {
  requestId: string
  pseudocode: string
}

export async function requestAgentNetworkPlan(input: {
  appId: string
  task: string
}): Promise<AgentNetworkPlanResult> {
  const response = await fetch(`${basePath}/internal/agent-network/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  })
  const body = await readResponse(response)

  if (!response.ok) {
    const code = typeof body.code === 'string' ? body.code : 'AGENT_NETWORK_REQUEST_FAILED'
    throw new Error(code)
  }
  if (typeof body.request_id !== 'string' || typeof body.pseudocode !== 'string')
    throw new Error('AGENT_NETWORK_INVALID_RESPONSE')

  return {
    requestId: body.request_id,
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
