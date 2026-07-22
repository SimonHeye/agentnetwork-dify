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
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('AGENT_NETWORK_PLAN_URL', 'http://127.0.0.1:8787/plan')
    vi.stubEnv('AGENT_NETWORK_PLAN_API_KEY', 'local-test-token')
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('forwards the task to Agent Network and returns pseudocode', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      request_id: 'request-1',
      pseudocode: 'final_result = task',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const response = await POST(createRequest({ appId: 'app-1', task: 'Build a search workflow' }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      request_id: 'request-1',
      pseudocode: 'final_result = task',
    })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8787/plan', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Authorization': 'Bearer local-test-token',
        'Content-Type': 'application/json',
      }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(requestBody).toMatchObject({
      schema_version: '1.0',
      app_id: 'app-1',
      task: 'Build a search workflow',
    })
  })

  it('rejects cross-origin browser requests', async () => {
    const response = await POST(createRequest({ appId: 'app-1', task: 'task' }, 'https://example.com'))

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid Agent Network response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'completed' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const response = await POST(createRequest({ appId: 'app-1', task: 'task' }))

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ code: 'AGENT_NETWORK_INVALID_RESPONSE' })
  })
})
