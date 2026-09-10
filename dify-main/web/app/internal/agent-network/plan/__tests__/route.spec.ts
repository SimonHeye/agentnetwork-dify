import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../route'

const fetchMock = vi.fn()

function createRequest(body: unknown, origin = 'http://localhost') {
  const request = new Request('http://localhost/internal/agent-network/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  request.headers.set('origin', origin)
  return request
}

describe('POST /internal/agent-network/plan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('AGENT_NETWORK_PLAN_URL', 'http://127.0.0.1:8787/service/plan_code')
    vi.stubEnv('AGENT_NETWORK_PLAN_API_KEY', 'local-test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('should forward the documented plan_code request and return pseudocode', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      pseudocode: 'final_result = task',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const response = await POST(createRequest({
      appId: 'app-1',
      id: 'conversation-1',
      task: 'Build a search workflow',
      includeAgents: true,
      model: 'deepseek-chat',
      extraInstructions: 'Only use SearchGroup',
      existCode: 'final_result = previous_result',
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      pseudocode: 'final_result = task',
    })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8787/service/plan_code', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Authorization': 'Bearer local-test-token',
        'Content-Type': 'application/json',
      }),
    }))
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(payload).toMatchObject({
      task: 'Build a search workflow',
      id: 'conversation-1',
      include_agents: true,
      model: 'deepseek-chat',
      exist_code: 'final_result = previous_result',
      extra_instructions: 'Only use SearchGroup',
    })
  })

  it('should send the documented include_agents default without inventing fields', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      pseudocode: 'final_result = task',
    }), { status: 200 }))

    await POST(createRequest({ appId: 'app-1', id: 'conversation-1', task: 'task' }))

    const requestBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(requestBody).toMatchObject({ id: 'conversation-1', include_agents: false })
    expect(requestBody.task).toBe('task')
    expect(requestBody).not.toHaveProperty('exist_code')
    expect(requestBody).not.toHaveProperty('extra_instructions')
  })

  it('should reject cross-origin browser requests', async () => {
    const response = await POST(createRequest({ appId: 'app-1', id: 'conversation-1', task: 'task' }, 'https://example.com'))

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should surface a non-2xx Agent Network error description', async () => {
    fetchMock.mockResolvedValue(new Response('Planner model is unavailable', { status: 500 }))

    const response = await POST(createRequest({ appId: 'app-1', id: 'conversation-1', task: 'task' }))

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      code: 'AGENT_NETWORK_REJECTED',
      message: 'Planner model is unavailable',
    })
  })

  it('should reject an invalid Agent Network response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'completed' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const response = await POST(createRequest({ appId: 'app-1', id: 'conversation-1', task: 'task' }))

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ code: 'AGENT_NETWORK_INVALID_RESPONSE' })
  })
})
