import type { AgentNetworkReverseResult } from '../types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentNetworkPseudocodeTrigger } from '../export-trigger'

const mockExportPseudocode = vi.hoisted(() => vi.fn())
const mockExecuteCode = vi.hoisted(() => vi.fn())
const mockFetchConversation = vi.hoisted(() => vi.fn())
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

vi.mock('../execute-code', () => ({
  executeAgentNetworkCode: mockExecuteCode,
}))

vi.mock('../conversation-service', () => ({
  fetchAgentNetworkConversation: mockFetchConversation,
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
    mockFetchConversation.mockImplementation(async (appId: string) => ({
      id: 'conversation-1',
      tenant_id: 'tenant-1',
      app_id: appId,
      created_by: 'user-1',
      applied_message_id: appId === 'app-123' ? 'assistant-1' : null,
      applied_task: appId === 'app-123' ? 'Original task' : null,
      created_at: 1,
      updated_at: 1,
    }))
    mockExportPseudocode.mockReturnValue(result)
    mockExecuteCode.mockResolvedValue({
      finalResult: { value: 'done', raw: { answer: 'raw' } },
      context: {},
      trace: [{ identifier: 'SearchGroup', vertex: 'SearchGroup', params: {}, scalar: 'done' }],
      calls: 1,
    })
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
    expect(mockExecuteCode).not.toHaveBeenCalled()
  })

  it('should save the draft without sending pseudocode', async () => {
    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)
    fireEvent.click(screen.getByRole('button', { name: 'common.operation.save' }))

    await waitFor(() => expect(mockDoSyncWorkflowDraft).toHaveBeenCalledTimes(1))
    expect(mockExportPseudocode).not.toHaveBeenCalled()
    expect(mockExecuteCode).not.toHaveBeenCalled()
    expect(mockToastSuccess).toHaveBeenCalledWith('common.api.saved')
  })

  it('should save the draft before executing with the latest pseudocode', async () => {
    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)
    fireEvent.click(screen.getByRole('button', { name: 'common.operation.execute' }))

    await waitFor(() => expect(mockDoSyncWorkflowDraft).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockExecuteCode).toHaveBeenCalledWith({
      task: 'Original task',
      code: result.source,
      params: {},
      need_task: false,
      need_match: false,
      include_agents: true,
    }))
    const saveCallOrder = mockDoSyncWorkflowDraft.mock.invocationCallOrder.at(0)
    const sendCallOrder = mockExecuteCode.mock.invocationCallOrder.at(0)
    expect(saveCallOrder).toBeDefined()
    expect(sendCallOrder).toBeDefined()
    if (saveCallOrder === undefined || sendCallOrder === undefined)
      throw new Error('Expected both save and delivery calls')
    expect(saveCallOrder).toBeLessThan(sendCallOrder)
    expect(mockToastSuccess).toHaveBeenCalledWith('done')
    expect(await screen.findByText('final_result')).toBeInTheDocument()
    expect(screen.getByText('SearchGroup')).toBeInTheDocument()
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
    expect(mockExecuteCode).not.toHaveBeenCalled()
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
    expect(mockExecuteCode).not.toHaveBeenCalled()
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
    expect(mockExecuteCode).not.toHaveBeenCalled()
  })
  it('should require a successful initial plan before execution', async () => {
    render(<AgentNetworkPseudocodeTrigger appId="app-missing" workflowName="Routing demo" />)

    fireEvent.click(screen.getByRole('button', { name: 'common.operation.execute' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('common.agentNetworkChat.initialTaskMissing'))
    expect(mockDoSyncWorkflowDraft).not.toHaveBeenCalled()
    expect(mockExecuteCode).not.toHaveBeenCalled()
  })

  it('should display the execute_code error description', async () => {
    mockExecuteCode.mockRejectedValue(new Error('NameError: name \'UnknownGroup\' is not defined'))
    render(<AgentNetworkPseudocodeTrigger appId="app-123" workflowName="Routing demo" />)

    fireEvent.click(screen.getByRole('button', { name: 'common.operation.execute' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      'NameError: name \'UnknownGroup\' is not defined',
    ))
  })
})
