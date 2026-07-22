import type { AgentNetworkPseudocodeDeliveryInput } from '@/features/agent-network-workflow/types'
import { POST } from '../route'

const delivery: AgentNetworkPseudocodeDeliveryInput = {
  appId: 'app-123',
  appName: 'Routing demo',
  pseudocode: 'final_result = task\n',
  diagnostics: [],
  stats: { nodes: 2, edges: 1, agents: 0, branches: 0, skills: 0 },
}

function request(body: unknown = delivery, origin = 'http://localhost') {
  const value = new Request('http://localhost/internal/agent-network/pseudocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  value.headers.set('origin', origin)
  return value
}

describe('POST /internal/agent-network/pseudocode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('AGENT_NETWORK_PSEUDOCODE_URL', 'http://127.0.0.1:8787/pseudocode')
    vi.stubEnv('AGENT_NETWORK_PSEUDOCODE_API_KEY', 'local-test-token')
    vi.stubEnv('AGENT_NETWORK_PSEUDOCODE_TIMEOUT_MS', '5000')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('should forward a versioned event with server-only authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request())
    const responseBody = await response.json()

    expect(response.status).toBe(202)
    expect(responseBody).toMatchObject({ status: 'accepted', delivery_id: expect.any(String) })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:8787/pseudocode')
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Authorization': 'Bearer local-test-token',
        'Content-Type': 'application/json',
        'X-Dify-Delivery-Id': responseBody.delivery_id,
      }),
      cache: 'no-store',
    })
    expect(JSON.parse(init.body as string)).toMatchObject({
      schema_version: '1.0',
      event: 'dify.workflow.pseudocode.generated',
      delivery_id: responseBody.delivery_id,
      sent_at: expect.any(String),
      app: { id: 'app-123', name: 'Routing demo' },
      pseudocode: delivery.pseudocode,
      diagnostics: [],
      stats: delivery.stats,
    })
  })

  it('should reject invalid browser payloads before contacting Agent Network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request({ ...delivery, pseudocode: '' }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: 'INVALID_REQUEST' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should reject cross-origin delivery requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request(delivery, 'https://example.com'))

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should report missing receiver configuration', async () => {
    vi.stubEnv('AGENT_NETWORK_PSEUDOCODE_URL', '')
    vi.stubGlobal('fetch', vi.fn())

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: 'AGENT_NETWORK_NOT_CONFIGURED' })
  })

  it('should normalize receiver failures without returning its response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private receiver error', { status: 500 })))

    const response = await POST(request())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ code: 'AGENT_NETWORK_REJECTED' })
  })
})
