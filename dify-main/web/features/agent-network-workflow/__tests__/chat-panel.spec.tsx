import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentNetworkChatPanel } from '../chat-panel'
import { requestAgentNetworkPlan } from '../request-plan'

const mockApplyPseudocode = vi.hoisted(() => vi.fn())
const mockPush = vi.hoisted(() => vi.fn())
const mockFetchMessages = vi.hoisted(() => vi.fn())
const mockCreateMessage = vi.hoisted(() => vi.fn())
const mockMarkApplied = vi.hoisted(() => vi.fn())
const mockMarkApplyFailed = vi.hoisted(() => vi.fn())

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}))

vi.mock('@/next/navigation', () => ({
  usePathname: () => '/app/app-1/agent-network',
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@/app/components/app/store', () => ({
  useStore: (selector: (state: { appDetail: { id: string } }) => unknown) => selector({
    appDetail: { id: 'app-1' },
  }),
}))

vi.mock('@/app/components/workflow/hooks/use-workflow', () => ({
  useNodesReadOnly: () => ({ nodesReadOnly: false }),
}))

vi.mock('../use-agent-network-workflow', () => ({
  useAgentNetworkWorkflow: () => ({ applyPseudocode: mockApplyPseudocode }),
}))

vi.mock('../request-plan', () => ({ requestAgentNetworkPlan: vi.fn() }))

vi.mock('../conversation-service', () => ({
  fetchAgentNetworkMessages: mockFetchMessages,
  createAgentNetworkMessage: mockCreateMessage,
  markAgentNetworkMessageApplied: mockMarkApplied,
  markAgentNetworkMessageApplyFailed: mockMarkApplyFailed,
  clearAgentNetworkMessages: vi.fn(),
}))

const conversation = {
  id: 'conversation-1',
  tenant_id: 'tenant-1',
  app_id: 'app-1',
  created_by: 'user-1',
  applied_message_id: null,
  applied_task: null,
  created_at: 1,
  updated_at: 1,
}

function persistedMessage(overrides: Record<string, unknown>) {
  return {
    id: 'message-1',
    conversation_id: 'conversation-1',
    role: 'user',
    status: 'success',
    apply_status: null,
    content: 'task',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

describe('AgentNetworkChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('confirm', vi.fn(() => true))
    mockFetchMessages.mockResolvedValue({ conversation, data: [] })
    mockCreateMessage.mockImplementation(async (_appId: string, payload: Record<string, unknown>) => {
      if (payload.role === 'user')
        return persistedMessage({ id: 'user-1', content: payload.content })
      if (payload.role === 'assistant') {
        return persistedMessage({
          id: 'assistant-1',
          role: 'assistant',
          content: payload.content,
          pseudocode: payload.pseudocode,
          parent_message_id: payload.parent_message_id,
          apply_status: 'not_applied',
        })
      }
      return persistedMessage({ id: 'error-1', role: 'error', status: 'failed', content: payload.content })
    })
    vi.mocked(requestAgentNetworkPlan).mockResolvedValue({ pseudocode: 'final_result = task' })
    mockApplyPseudocode.mockResolvedValue({
      graph: { nodes: [{ id: 'start' }, { id: 'end' }], edges: [{ id: 'edge' }] },
      warnings: [],
    })
    mockMarkApplied.mockResolvedValue({
      conversation: { ...conversation, applied_message_id: 'assistant-1', applied_task: 'Build a calculator workflow' },
      message: persistedMessage({
        id: 'assistant-1',
        role: 'assistant',
        content: 'applied',
        pseudocode: 'final_result = task',
        parent_message_id: 'user-1',
        apply_status: 'applied',
        nodes_count: 2,
        edges_count: 1,
      }),
    })
  })

  it('persists the task association and only applies after user confirmation', async () => {
    const user = userEvent.setup()
    render(<AgentNetworkChatPanel />)

    await user.type(screen.getByRole('textbox', { name: 'agentNetworkChat.placeholder' }), 'Build a calculator workflow')
    await user.click(screen.getByRole('button', { name: 'agentNetworkChat.send' }))

    const ready = await screen.findByText('agentNetworkChat.planReady')
    expect(requestAgentNetworkPlan).toHaveBeenCalledWith({ appId: 'app-1', task: 'Build a calculator workflow' })
    expect(mockCreateMessage).toHaveBeenCalledWith('app-1', expect.objectContaining({
      role: 'assistant',
      parent_message_id: 'user-1',
      pseudocode: 'final_result = task',
    }))
    expect(mockApplyPseudocode).not.toHaveBeenCalled()

    const article = ready.closest('article')
    expect(article).not.toBeNull()
    const buttons = within(article as HTMLElement).getAllByRole('button')
    await user.click(buttons.at(-1)!)

    await waitFor(() => expect(mockApplyPseudocode).toHaveBeenCalledWith('final_result = task', {
      preservePositions: false,
      saveDraft: true,
    }))
    expect(mockMarkApplied).toHaveBeenCalledWith('app-1', 'assistant-1', expect.objectContaining({
      nodes_count: 2,
      edges_count: 1,
    }))
  })

  it('returns to the normal workflow page when closed', async () => {
    const user = userEvent.setup()
    render(<AgentNetworkChatPanel />)
    await user.click(screen.getByRole('button', { name: 'agentNetworkChat.close' }))
    expect(mockPush).toHaveBeenCalledWith('/app/app-1/workflow')
  })
})
