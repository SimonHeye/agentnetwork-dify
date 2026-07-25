import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestAgentNetworkPlan } from '../request-plan'

const fetchMock = vi.fn()

vi.mock('@/utils/var', () => ({ basePath: '/dify' }))

describe('requestAgentNetworkPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should request all supported planning options through the same-origin proxy', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      pseudocode: 'final_result = task',
    }), { status: 200 }))

    await expect(requestAgentNetworkPlan({
      appId: 'app-1',
      task: 'task',
      includeAgents: true,
      model: 'deepseek-chat',
      extraInstructions: 'Only use SearchGroup',
    })).resolves.toEqual({
      pseudocode: 'final_result = task',
    })
    expect(fetchMock).toHaveBeenCalledWith('/dify/internal/agent-network/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        appId: 'app-1',
        task: 'task',
        includeAgents: true,
        model: 'deepseek-chat',
        extraInstructions: 'Only use SearchGroup',
      }),
    })
  })

  it('should use the documented include_agents default', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      pseudocode: 'final_result = task',
    }), { status: 200 }))

    await requestAgentNetworkPlan({ appId: 'app-1', task: 'task' })

    expect(fetchMock).toHaveBeenCalledWith('/dify/internal/agent-network/plan', expect.objectContaining({
      body: JSON.stringify({ appId: 'app-1', task: 'task', includeAgents: false }),
    }))
  })

  it('should surface the Agent Network error description', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: 'AGENT_NETWORK_REJECTED',
      message: 'Planner model is unavailable',
    }), { status: 502 }))

    await expect(requestAgentNetworkPlan({ appId: 'app-1', task: 'task' }))
      .rejects
      .toThrow('Planner model is unavailable')
  })
})
