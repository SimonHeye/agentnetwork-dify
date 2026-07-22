import type { AgentNetworkCompileResult } from '../types'
import type { LLMNodeType } from '@/app/components/workflow/nodes/llm/types'
import type { Edge, Node } from '@/app/components/workflow/types'
import { act, renderHook } from '@testing-library/react'
import { BlockEnum } from '@/app/components/workflow/types'
import { AgentNetworkCompileError } from '../types'
import { useAgentNetworkWorkflow } from '../use-agent-network-workflow'

const mockHandleUpdateWorkflowCanvas = vi.hoisted(() => vi.fn())
const mockDoSyncWorkflowDraft = vi.hoisted(() => vi.fn(async () => undefined))
const mockGetNodes = vi.hoisted(() => vi.fn())
const mockGetEdges = vi.hoisted(() => vi.fn())
const mockGetViewport = vi.hoisted(() => vi.fn())
const mockIsConnected = vi.hoisted(() => vi.fn())
const mockGetIsLeader = vi.hoisted(() => vi.fn())
const mockWorkflowState = vi.hoisted(() => ({
  nodesDefaultConfigs: {} as Record<string, unknown>,
}))
const difyNodeDefaults = {
  llm: {
    model: {
      provider: 'default-provider',
      name: 'default-model',
      mode: 'chat',
      completion_params: {},
    },
  },
}
const mockCanvasState = vi.hoisted(() => ({
  nodes: [] as Node[],
  edges: [] as Edge[],
}))

vi.mock('reactflow', async importOriginal => ({
  ...(await importOriginal<typeof import('reactflow')>()),
  useReactFlow: () => ({
    getNodes: mockGetNodes,
    getEdges: mockGetEdges,
    getViewport: mockGetViewport,
  }),
}))

vi.mock('@/app/components/workflow/collaboration/core/collaboration-manager', () => ({
  collaborationManager: {
    isConnected: mockIsConnected,
    getIsLeader: mockGetIsLeader,
  },
}))

vi.mock('@/app/components/workflow/hooks/use-workflow-update', () => ({
  useWorkflowUpdate: () => ({ handleUpdateWorkflowCanvas: mockHandleUpdateWorkflowCanvas }),
}))

vi.mock('@/app/components/workflow/hooks-store/store', () => ({
  useHooksStore: (selector: (state: { doSyncWorkflowDraft: typeof mockDoSyncWorkflowDraft }) => unknown) => (
    selector({ doSyncWorkflowDraft: mockDoSyncWorkflowDraft })
  ),
}))

vi.mock('@/app/components/workflow/store', () => ({
  useWorkflowStore: () => ({ getState: () => mockWorkflowState }),
}))

describe('useAgentNetworkWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsConnected.mockReturnValue(false)
    mockGetIsLeader.mockReturnValue(true)
    mockWorkflowState.nodesDefaultConfigs = difyNodeDefaults
    mockGetViewport.mockReturnValue({ x: 12, y: 24, zoom: 0.9 })
    mockCanvasState.nodes = [
      {
        id: 'echogroup',
        position: { x: 900, y: 700 },
        positionAbsolute: { x: 900, y: 700 },
        data: { type: BlockEnum.LLM, title: 'EchoGroup', desc: '' },
      },
    ]
    mockCanvasState.edges = []
    mockGetNodes.mockImplementation(() => mockCanvasState.nodes)
    mockGetEdges.mockImplementation(() => mockCanvasState.edges)
    mockHandleUpdateWorkflowCanvas.mockImplementation((graph: AgentNetworkCompileResult['graph']) => {
      mockCanvasState.nodes = graph.nodes
      mockCanvasState.edges = graph.edges
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  describe('Canvas updates', () => {
    it('should apply an already compiled graph without parsing pseudocode again', async () => {
      const { result } = renderHook(() => useAgentNetworkWorkflow())
      const compiledGraph: AgentNetworkCompileResult['graph'] = {
        nodes: [{
          id: 'server-node',
          position: { x: 80, y: 280 },
          data: { type: BlockEnum.LLM, title: 'Server node', desc: '' },
        }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 0.7 },
      }

      await act(async () => {
        await result.current.applyCompiledGraph(compiledGraph, {
          preservePositions: false,
          saveDraft: true,
        })
      })

      expect(mockHandleUpdateWorkflowCanvas).toHaveBeenCalledTimes(1)
      expect(mockCanvasState.nodes[0]?.id).toBe('server-node')
      expect(mockDoSyncWorkflowDraft).toHaveBeenCalledTimes(1)
    })

    it('should compile with Dify defaults and preserve matching node positions', async () => {
      const { result } = renderHook(() => useAgentNetworkWorkflow())
      let compiled: Awaited<ReturnType<typeof result.current.applyPseudocode>> | undefined

      await act(async () => {
        compiled = await result.current.applyPseudocode(
          'answer = EchoGroup(task=task)\nfinal_result = answer',
        )
      })

      const echo = compiled?.graph.nodes.find(node => node.id === 'echogroup')
      expect((echo?.data as LLMNodeType | undefined)?.model).toMatchObject({
        provider: 'default-provider',
        name: 'default-model',
      })
      expect(echo?.position).toEqual({ x: 900, y: 700 })
      expect(compiled?.graph.viewport).toEqual({ x: 12, y: 24, zoom: 0.9 })
      const echoData = echo?.data as unknown as Record<string, unknown> | undefined
      expect(echoData?._agentNetworkRevision).toBeUndefined()
      expect(mockHandleUpdateWorkflowCanvas).toHaveBeenCalledTimes(1)
      const appliedGraph = mockHandleUpdateWorkflowCanvas.mock.calls[0]?.[0] as AgentNetworkCompileResult['graph']
      const appliedData = appliedGraph.nodes.find(node => node.id === 'echogroup')?.data
      expect((appliedData as unknown as Record<string, unknown> | undefined)?._agentNetworkRevision)
        .toEqual(expect.any(String))
      expect(mockDoSyncWorkflowDraft).not.toHaveBeenCalled()
    })

    it('should use generated positions when preservation is disabled', async () => {
      const { result } = renderHook(() => useAgentNetworkWorkflow())
      let compiled: Awaited<ReturnType<typeof result.current.applyPseudocode>> | undefined

      await act(async () => {
        compiled = await result.current.applyPseudocode(
          'answer = EchoGroup(task=task)\nfinal_result = answer',
          { preservePositions: false },
        )
      })

      const echo = compiled?.graph.nodes.find(node => node.id === 'echogroup')
      expect(echo?.position).not.toEqual({ x: 900, y: 700 })
      expect(compiled?.graph.viewport).toEqual({ x: 0, y: 0, zoom: 0.7 })
    })

    it('should use the AgentNetwork DeepSeek model when a blank app has no Dify default', async () => {
      mockWorkflowState.nodesDefaultConfigs = { llm: {} }
      const { result } = renderHook(() => useAgentNetworkWorkflow())
      let compiled: Awaited<ReturnType<typeof result.current.applyPseudocode>> | undefined

      await act(async () => {
        compiled = await result.current.applyPseudocode(
          'answer = EchoGroup(task=task)\nfinal_result = answer',
        )
      })

      const echo = compiled?.graph.nodes.find(node => node.id === 'echogroup')
      expect((echo?.data as LLMNodeType | undefined)?.model).toEqual({
        provider: 'langgenius/deepseek/deepseek',
        name: 'deepseek-chat',
        mode: 'chat',
        completion_params: {},
      })
    })
  })

  describe('Draft persistence', () => {
    it('should sync the Dify draft once when explicitly requested', async () => {
      const { result } = renderHook(() => useAgentNetworkWorkflow())

      await act(async () => {
        await result.current.applyPseudocode(
          'answer = EchoGroup(task=task)\nfinal_result = answer',
          { saveDraft: true },
        )
      })

      expect(mockDoSyncWorkflowDraft).toHaveBeenCalledTimes(1)
    })

    it('should not sync when the generated graph was not applied to the canvas', async () => {
      mockHandleUpdateWorkflowCanvas.mockImplementationOnce(() => undefined)
      const { result } = renderHook(() => useAgentNetworkWorkflow())

      await expect(result.current.applyPseudocode(
        'answer = EchoGroup(task=task)\nfinal_result = answer',
        { saveDraft: true },
      )).rejects.toThrow(/was not applied to the canvas/)

      expect(mockDoSyncWorkflowDraft).not.toHaveBeenCalled()
    })
  })

  describe('Safety', () => {
    it('should reject graph replacement for a collaboration follower', async () => {
      mockIsConnected.mockReturnValue(true)
      mockGetIsLeader.mockReturnValue(false)
      const { result } = renderHook(() => useAgentNetworkWorkflow())

      await expect(result.current.applyPseudocode(
        'answer = EchoGroup(task=task)\nfinal_result = answer',
      )).rejects.toThrow(/collaboration leader/)
      expect(mockHandleUpdateWorkflowCanvas).not.toHaveBeenCalled()
    })

    it('should surface compiler validation errors without changing the canvas', async () => {
      const { result } = renderHook(() => useAgentNetworkWorkflow())

      await expect(result.current.applyPseudocode(
        'answer = helper(task=task)\nfinal_result = answer',
      )).rejects.toBeInstanceOf(AgentNetworkCompileError)
      expect(mockHandleUpdateWorkflowCanvas).not.toHaveBeenCalled()
    })
  })
})
