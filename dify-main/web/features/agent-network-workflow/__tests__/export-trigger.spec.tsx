import type { AgentNetworkReverseResult } from '../types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentNetworkPseudocodeTrigger } from '../export-trigger'

const mockExportPseudocode = vi.hoisted(() => vi.fn())
const mockSendPseudocode = vi.hoisted(() => vi.fn())
const mockDoSyncWorkflowDraft = vi.hoisted(() => vi.fn())
const mockToastSuccess = vi.hoisted(() => vi.fn())
const mockToastError = vi.hoisted(() => vi.fn())

vi.mock('@/app/components/workflow/hooks/use-nodes-sync-draft', () => ({
  useNodesSyncDraft: () => ({ doSyncWorkflowDraft: mockDoSyncWorkflowDraft }),
}))

vi.mock('@langgenius/dify-ui/toast', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}))

vi.mock('../use-agent-network-workflow', () => ({
  useAgentNetworkWorkflow: () => ({ exportPseudocode: mockExportPseudocode }),
}))

vi.mock('../send-pseudocode', () => ({
  sendPseudocodeToAgentNetwork: mockSendPseudocode,
}))

const result = {
  source: 'answer = SearchGroup(task=task, skills=["browser-control"])\nfinal_result = answer\n',
  fileName: 'Routing demo.agentnetwork.py',
  diagnostics: [{
    severity: 'warning',
    code: 'INFERRED_VARIABLE',
    message: 'Generated answer',
    nodeId: 'searchgroup',
  }],
  stats: { nodes: 3, edges: 2, agents: 1, branches: 0, skills: 1 },
} satisfies AgentNetworkReverseResult

describe('AgentNetworkPseudocodeTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExportPseudocode.mockReturnValue(result)
    mockSendPseudocode.mockResolvedValue({ deliveryId: 'delivery-123' })
    mockDoSyncWorkflowDraft.mockImplementation(async (
      _notRefreshWhenSyncError: boolean | undefined,
      callback?: { onSuccess?: () => void },
    ) => callback?.onSuccess?.())
  })

  it('should show pseudocode and diagnostics without copy or download actions', () => {
    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)

    fireEvent.click(screen.getByRole('button', { name: 'common.operation.view' }))

    expect(screen.getByText(/SearchGroup/)).toBeInTheDocument()
    expect(screen.getByText(/Generated answer/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /copy|download/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Agent Network/i })).not.toBeInTheDocument()
    expect(mockSendPseudocode).not.toHaveBeenCalled()
  })

  it('should save the draft without sending pseudocode', async () => {
    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)
    fireEvent.click(screen.getByRole('button', { name: 'common.operation.save' }))

    await waitFor(() => expect(mockDoSyncWorkflowDraft).toHaveBeenCalledTimes(1))
    expect(mockExportPseudocode).not.toHaveBeenCalled()
    expect(mockSendPseudocode).not.toHaveBeenCalled()
    expect(mockToastSuccess).toHaveBeenCalledWith('common.api.saved')
  })

  it('should save the draft before executing with the latest pseudocode', async () => {
    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)
    fireEvent.click(screen.getByRole('button', { name: 'common.operation.execute' }))

    await waitFor(() => expect(mockDoSyncWorkflowDraft).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockSendPseudocode).toHaveBeenCalledWith({
      appId: 'app-123',
      appName: 'Routing demo',
      pseudocode: result.source,
      diagnostics: result.diagnostics,
      stats: result.stats,
    }))
    const saveCallOrder = mockDoSyncWorkflowDraft.mock.invocationCallOrder.at(0)
    const sendCallOrder = mockSendPseudocode.mock.invocationCallOrder.at(0)
    expect(saveCallOrder).toBeDefined()
    expect(sendCallOrder).toBeDefined()
    if (saveCallOrder === undefined || sendCallOrder === undefined)
      throw new Error('Expected both save and delivery calls')
    expect(saveCallOrder).toBeLessThan(sendCallOrder)
    expect(mockToastSuccess).toHaveBeenCalledWith('common.api.success')
  })

  it('should not send when saving the Dify draft fails', async () => {
    mockDoSyncWorkflowDraft.mockImplementation(async (
      _notRefreshWhenSyncError: boolean | undefined,
      callback?: { onError?: () => void },
    ) => callback?.onError?.())

    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)
    fireEvent.click(screen.getByRole('button', { name: 'common.operation.save' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('common.api.actionFailed'))
    expect(mockExportPseudocode).not.toHaveBeenCalled()
    expect(mockSendPseudocode).not.toHaveBeenCalled()
  })

  it('should not execute when saving the Dify draft fails', async () => {
    mockDoSyncWorkflowDraft.mockImplementation(async (
      _notRefreshWhenSyncError: boolean | undefined,
      callback?: { onError?: () => void },
    ) => callback?.onError?.())

    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)
    fireEvent.click(screen.getByRole('button', { name: 'common.operation.execute' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('common.api.actionFailed'))
    expect(mockExportPseudocode).not.toHaveBeenCalled()
    expect(mockSendPseudocode).not.toHaveBeenCalled()
  })

  it('should show diagnostics and not send when reverse compilation fails', async () => {
    mockExportPseudocode.mockReturnValue({
      ...result,
      source: null,
      diagnostics: [{ severity: 'error', code: 'UNSUPPORTED_NODE', message: 'Unsupported node' }],
    })
    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)

    fireEvent.click(screen.getByRole('button', { name: 'common.operation.execute' }))

    expect(await screen.findByText('Unsupported node')).toBeInTheDocument()
    expect(mockSendPseudocode).not.toHaveBeenCalled()
  })
})
