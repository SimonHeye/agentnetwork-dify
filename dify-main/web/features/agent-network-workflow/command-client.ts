import type { AgentNetworkCompileResult } from './types'
import { basePath } from '@/utils/var'

export type AgentNetworkGraphCommand = {
  command_id: string
  app_id: string
  status: 'processing'
  graph: AgentNetworkCompileResult['graph']
  warnings: string[]
  preserve_positions: boolean
  save_draft: boolean
}

type CompleteAgentNetworkGraphCommandInput = {
  status: 'completed' | 'failed'
  error?: string
}

const ENDPOINT = `${basePath}/agent-network/pseudocode`

export async function fetchPendingAgentNetworkGraphCommand(
  appId: string,
  signal?: AbortSignal,
): Promise<AgentNetworkGraphCommand | null> {
  const response = await fetch(`${ENDPOINT}?app_id=${encodeURIComponent(appId)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  })
  if (response.status === 204)
    return null
  if (!response.ok)
    throw new Error(`Unable to fetch AgentNetwork graph command (${response.status})`)
  return await response.json() as AgentNetworkGraphCommand
}

export async function completeAgentNetworkGraphCommand(
  commandId: string,
  result: CompleteAgentNetworkGraphCommandInput,
): Promise<void> {
  const response = await fetch(ENDPOINT, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ command_id: commandId, ...result }),
  })
  if (!response.ok)
    throw new Error(`Unable to complete AgentNetwork graph command (${response.status})`)
}
