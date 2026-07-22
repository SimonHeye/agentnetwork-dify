import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestAgentNetworkPlan } from '../request-plan'

const fetchMock = vi.fn()

vi.mock('@/utils/var', () => ({ basePath: '/dify' }))

describe('requestAgentNetworkPlan', () => {
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('requests a plan through the same-origin Dify proxy', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      request_id: 'request-1',
      pseudocode: 'final_result = task',
    }), { status: 200 }))

    await expect(requestAgentNetworkPlan({ appId: 'app-1', task: 'task' })).resolves.toEqual({
      requestId: 'request-1',
      pseudocode: 'final_result = task',
    })
    expect(fetchMock).toHaveBeenCalledWith('/dify/internal/agent-network/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ appId: 'app-1', task: 'task' }),
    })
  })

  it('surfaces the proxy error code', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: 'AGENT_NETWORK_UNAVAILABLE',
    }), { status: 502 }))

    await expect(requestAgentNetworkPlan({ appId: 'app-1', task: 'task' }))
      .rejects
      .toThrow('AGENT_NETWORK_UNAVAILABLE')
  })
})
