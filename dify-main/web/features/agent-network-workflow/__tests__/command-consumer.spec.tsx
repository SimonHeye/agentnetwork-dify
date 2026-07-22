import type { AgentNetworkGraphCommand } from '../command-client'
import type { AgentNetworkCompileResult } from '../types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import {
  completeAgentNetworkGraphCommand,
  fetchPendingAgentNetworkGraphCommand,
} from '../command-client'
import { AgentNetworkCommandConsumer } from '../command-consumer'

const mockApplyCompiledGraph = vi.hoisted(() => vi.fn(async () => undefined))
const mockAppState = vi.hoisted(() => ({ appId: 'app-1' as string | undefined }))
const mockReadOnlyState = vi.hoisted(() => ({ nodesReadOnly: false }))

vi.mock('@/app/components/app/store', () => ({
  useStore: (selector: (state: { appDetail?: { id: string } }) => unknown) => (
    selector({ appDetail: mockAppState.appId ? { id: mockAppState.appId } : undefined })
  ),
}))

vi.mock('@/app/components/workflow/hooks/use-workflow', () => ({
  useNodesReadOnly: () => mockReadOnlyState,
}))

vi.mock('../use-agent-network-workflow', () => ({
  useAgentNetworkWorkflow: () => ({ applyCompiledGraph: mockApplyCompiledGraph }),
}))

vi.mock('../command-client', () => ({
  fetchPendingAgentNetworkGraphCommand: vi.fn(),
  completeAgentNetworkGraphCommand: vi.fn(async () => undefined),
}))

const graph: AgentNetworkCompileResult['graph'] = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 0.7 },
}

const command: AgentNetworkGraphCommand = {
  command_id: 'command-1',
  app_id: 'app-1',
  status: 'processing',
  graph,
  warnings: [],
  preserve_positions: true,
  save_draft: true,
}

function renderConsumer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentNetworkCommandConsumer />
    </QueryClientProvider>,
  )
}

describe('AgentNetworkCommandConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAppState.appId = 'app-1'
    mockReadOnlyState.nodesReadOnly = false
    vi.mocked(fetchPendingAgentNetworkGraphCommand).mockResolvedValue(command)
  })

  it('should apply a server-compiled graph and report completion', async () => {
    renderConsumer()

    await waitFor(() => {
      expect(mockApplyCompiledGraph).toHaveBeenCalledWith(graph, {
        preservePositions: true,
        saveDraft: true,
      })
    })
    await waitFor(() => {
      expect(completeAgentNetworkGraphCommand).toHaveBeenCalledWith('command-1', {
        status: 'completed',
      })
    })
  })

  it('should report a render failure', async () => {
    mockApplyCompiledGraph.mockRejectedValueOnce(new Error('canvas failed'))

    renderConsumer()

    await waitFor(() => {
      expect(completeAgentNetworkGraphCommand).toHaveBeenCalledWith('command-1', {
        status: 'failed',
        error: 'canvas failed',
      })
    })
  })

  it('should not claim commands without an editable app canvas', async () => {
    mockReadOnlyState.nodesReadOnly = true

    renderConsumer()

    await Promise.resolve()
    expect(fetchPendingAgentNetworkGraphCommand).not.toHaveBeenCalled()
    expect(mockApplyCompiledGraph).not.toHaveBeenCalled()
  })
})
