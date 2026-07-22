import type {
  AgentNetworkPseudocodeDeliveryInput,
  AgentNetworkPseudocodeDeliveryResult,
} from './types'
import { basePath } from '@/utils/var'

type DeliveryResponse = {
  delivery_id?: unknown
  code?: unknown
}

export async function sendPseudocodeToAgentNetwork(
  input: AgentNetworkPseudocodeDeliveryInput,
): Promise<AgentNetworkPseudocodeDeliveryResult> {
  const response = await fetch(`${basePath}/internal/agent-network/pseudocode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readResponse(response)

  if (!response.ok) {
    const code = typeof body.code === 'string' ? body.code : 'AGENT_NETWORK_REQUEST_FAILED'
    throw new Error(code)
  }
  if (typeof body.delivery_id !== 'string')
    throw new Error('AGENT_NETWORK_INVALID_RESPONSE')

  return { deliveryId: body.delivery_id }
}

async function readResponse(response: Response): Promise<DeliveryResponse> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null ? value as DeliveryResponse : {}
  }
  catch {
    return {}
  }
}
