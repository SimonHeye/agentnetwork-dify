import type { AgentNetworkPseudocodeDeliveryInput } from '../types'
import { sendPseudocodeToAgentNetwork } from '../send-pseudocode'

vi.mock('@/utils/var', () => ({ basePath: '/dify' }))

const delivery: AgentNetworkPseudocodeDeliveryInput = {
  appId: 'app-123',
  appName: 'Routing demo',
  pseudocode: 'final_result = task\n',
  diagnostics: [],
  stats: { nodes: 2, edges: 1, agents: 0, branches: 0, skills: 0 },
}

describe('sendPseudocodeToAgentNetwork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should send only to the same-origin internal route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      delivery_id: 'delivery-123',
      status: 'accepted',
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendPseudocodeToAgentNetwork(delivery)

    expect(fetchMock).toHaveBeenCalledWith('/dify/internal/agent-network/pseudocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(delivery),
    })
    expect(result).toEqual({ deliveryId: 'delivery-123' })
  })

  it('should surface a normalized error code without exposing a response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'AGENT_NETWORK_REJECTED',
      message: 'secret receiver details',
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(sendPseudocodeToAgentNetwork(delivery))
      .rejects
      .toThrow('AGENT_NETWORK_REJECTED')
  })
})
