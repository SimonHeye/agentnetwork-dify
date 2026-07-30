import type {
  AgentNetworkExecuteInput,
  AgentNetworkExecuteResult,
} from './types'
import { basePath } from '@/utils/var'

type ExecuteResponse = {
  final_result?: unknown
  context?: unknown
  trace?: unknown
  calls?: unknown
  code?: unknown
  message?: unknown
}

export async function executeAgentNetworkCode(
  input: AgentNetworkExecuteInput,
): Promise<AgentNetworkExecuteResult> {
  const response = await fetch(`${basePath}/internal/agent-network/pseudocode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      ...input,
      params: input.params ?? {},
      need_task: input.need_task ?? false,
      need_match: input.need_match ?? true,
      include_agents: input.include_agents ?? true,
    }),
  })
  const body = await readResponse(response)

  if (!response.ok) {
    const message = typeof body.message === 'string'
      ? body.message
      : typeof body.code === 'string' ? body.code : 'AGENT_NETWORK_REQUEST_FAILED'
    throw new Error(message)
  }
  if (
    !('final_result' in body)
    || !isRecord(body.context)
    || !Array.isArray(body.trace)
    || typeof body.calls !== 'number'
  )
    throw new Error('AGENT_NETWORK_INVALID_RESPONSE')

  return {
    finalResult: body.final_result,
    context: body.context,
    trace: body.trace as AgentNetworkExecuteResult['trace'],
    calls: body.calls,
  }
}

async function readResponse(response: Response): Promise<ExecuteResponse> {
  try {
    const value: unknown = await response.json()
    return isRecord(value) ? value : {}
  }
  catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
