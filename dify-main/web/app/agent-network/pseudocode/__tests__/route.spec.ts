import { resetAgentNetworkCommandStore } from '@/features/agent-network-workflow/command-store'
import { GET, PATCH, POST } from '../route'

const validSource = 'answer = SearchGroup(task=task)\nfinal_result = answer'

function jsonRequest(method: string, body: Record<string, unknown>, authorization?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (authorization)
    headers.set('Authorization', authorization)
  return new Request('http://localhost/agent-network/pseudocode', {
    method,
    headers,
    body: JSON.stringify(body),
  })
}

describe('agent-network pseudocode route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAgentNetworkCommandStore()
    vi.stubEnv('AGENT_NETWORK_API_KEY', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('should compile posted pseudocode and queue the graph', async () => {
    const response = await POST(jsonRequest('POST', {
      app_id: 'app-1',
      source: validSource,
    }))

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      status: 'pending',
      warnings: [],
      node_count: 3,
      edge_count: 2,
    })

    const pendingResponse = await GET(new Request(
      'http://localhost/agent-network/pseudocode?app_id=app-1',
    ))
    expect(pendingResponse.status).toBe(200)
    await expect(pendingResponse.json()).resolves.toMatchObject({
      app_id: 'app-1',
      status: 'processing',
      graph: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'start' }),
          expect.objectContaining({ id: 'searchgroup' }),
        ]),
      },
    })
  })

  it('should reject invalid pseudocode', async () => {
    const response = await POST(jsonRequest('POST', {
      app_id: 'app-1',
      source: 'for item in items:\n    WorkGroup(task=item)',
    }))

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: 'compile_failed',
    })
  })

  it('should reject malformed request payloads', async () => {
    const response = await POST(jsonRequest('POST', {
      app_id: '',
      source: '',
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
    })
  })

  it('should require the configured service token', async () => {
    vi.stubEnv('AGENT_NETWORK_API_KEY', 'demo-secret')

    const unauthorized = await POST(jsonRequest('POST', {
      app_id: 'app-1',
      source: validSource,
    }))
    const authorized = await POST(jsonRequest('POST', {
      app_id: 'app-1',
      source: validSource,
    }, 'Bearer demo-secret'))

    expect(unauthorized.status).toBe(401)
    expect(authorized.status).toBe(202)
  })

  it('should return no content when the app has no pending graph', async () => {
    const response = await GET(new Request(
      'http://localhost/agent-network/pseudocode?app_id=app-1',
    ))

    expect(response.status).toBe(204)
  })

  it('should record the browser render result', async () => {
    const createdResponse = await POST(jsonRequest('POST', {
      app_id: 'app-1',
      source: validSource,
    }))
    const created = await createdResponse.json() as { command_id: string }

    const response = await PATCH(jsonRequest('PATCH', {
      command_id: created.command_id,
      status: 'completed',
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      command_id: created.command_id,
      status: 'completed',
    })
  })
})
