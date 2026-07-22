import type {
  AgentNetworkCompileOptions,
  AgentNetworkCompileResult,
  AgentNetworkModelConfig,
  AgentNetworkReverseOptions,
  AgentNetworkReverseResult,
} from './types'
import type { Edge, Node } from '@/app/components/workflow/types'
import { useCallback } from 'react'
import { useReactFlow } from 'reactflow'
import { collaborationManager } from '@/app/components/workflow/collaboration/core/collaboration-manager'
import { useHooksStore } from '@/app/components/workflow/hooks-store/store'
import { useWorkflowUpdate } from '@/app/components/workflow/hooks/use-workflow-update'
import { useWorkflowStore } from '@/app/components/workflow/store'
import { BlockEnum } from '@/app/components/workflow/types'
import {
  compileAgentNetworkPseudocode,
} from './compiler'
import { AGENT_NETWORK_DEFAULT_MODEL } from './constants'
import { compileDifyGraphToAgentNetworkPseudocode } from './reverse-compiler'
import { AgentNetworkCompileError } from './types'

export type ApplyAgentNetworkGraphOptions = {
  preservePositions?: boolean
  saveDraft?: boolean
}

export type ApplyAgentNetworkPseudocodeOptions = AgentNetworkCompileOptions & ApplyAgentNetworkGraphOptions

const CANVAS_REVISION_FIELD = '_agentNetworkRevision'
let canvasRevision = 0

export function useAgentNetworkWorkflow() {
  const reactFlow = useReactFlow()
  const workflowStore = useWorkflowStore()
  const doSyncWorkflowDraft = useHooksStore(state => state.doSyncWorkflowDraft)
  const { handleUpdateWorkflowCanvas } = useWorkflowUpdate()

  const applyCompiledGraph = useCallback(async (
    graph: AgentNetworkCompileResult['graph'],
    options: ApplyAgentNetworkGraphOptions = {},
  ): Promise<AgentNetworkCompileResult['graph']> => {
    if (collaborationManager.isConnected() && !collaborationManager.getIsLeader()) {
      throw new AgentNetworkCompileError(
        'Only the collaboration leader can replace the workflow from AgentNetwork pseudocode',
      )
    }

    const { preservePositions = true, saveDraft = false } = options
    const preparedGraph = preservePositions
      ? preserveCanvasState(graph, reactFlow.getNodes(), reactFlow.getViewport())
      : graph
    const revision = `${Date.now()}-${++canvasRevision}`
    const canvasGraph = withCanvasRevision(preparedGraph, revision)

    handleUpdateWorkflowCanvas(canvasGraph)
    if (saveDraft) {
      await waitForCanvasGraph(reactFlow, preparedGraph, revision)
      await doSyncWorkflowDraft()
    }
    return preparedGraph
  }, [doSyncWorkflowDraft, handleUpdateWorkflowCanvas, reactFlow])

  const applyPseudocode = useCallback(async (
    source: string,
    options: ApplyAgentNetworkPseudocodeOptions = {},
  ): Promise<AgentNetworkCompileResult> => {
    const { preservePositions = true, saveDraft = false, ...compileOptions } = options
    const configuredDefaults = workflowStore.getState().nodesDefaultConfigs?.[BlockEnum.LLM]
    const llmDefaultConfig = compileOptions.llmDefaultConfig ?? asRecord(configuredDefaults)
    const result = compileAgentNetworkPseudocode(source, {
      ...compileOptions,
      model: compileOptions.model ?? modelFromDefaultConfig(llmDefaultConfig) ?? AGENT_NETWORK_DEFAULT_MODEL,
      llmDefaultConfig,
    })
    const graph = await applyCompiledGraph(result.graph, { preservePositions, saveDraft })
    return { ...result, graph }
  }, [applyCompiledGraph, workflowStore])

  const exportPseudocode = (
    options: AgentNetworkReverseOptions = {},
  ): AgentNetworkReverseResult => {
    return compileDifyGraphToAgentNetworkPseudocode({
      nodes: reactFlow.getNodes(),
      edges: reactFlow.getEdges(),
      viewport: reactFlow.getViewport(),
    }, options)
  }

  return { applyCompiledGraph, applyPseudocode, exportPseudocode }
}

function preserveCanvasState(
  graph: AgentNetworkCompileResult['graph'],
  currentNodes: Node[],
  viewport: AgentNetworkCompileResult['graph']['viewport'],
): AgentNetworkCompileResult['graph'] {
  const existingNodes = new Map(currentNodes.map(node => [node.id, node]))
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const existing = existingNodes.get(node.id)
      if (!existing)
        return node
      return {
        ...node,
        position: { ...existing.position },
        positionAbsolute: existing.positionAbsolute
          ? { ...existing.positionAbsolute }
          : { ...existing.position },
      }
    }),
    viewport,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function modelFromDefaultConfig(value: Record<string, unknown> | undefined): AgentNetworkModelConfig | undefined {
  const model = asRecord(value?.model)
  if (!model
    || typeof model.provider !== 'string' || !model.provider
    || typeof model.name !== 'string' || !model.name
    || typeof model.mode !== 'string' || !model.mode) {
    return undefined
  }

  return {
    provider: model.provider,
    name: model.name,
    mode: model.mode,
    completion_params: asRecord(model.completion_params) ?? {},
  }
}

type CanvasReader = {
  getNodes: () => Node[]
  getEdges: () => Edge[]
}

async function waitForCanvasGraph(
  canvas: CanvasReader,
  graph: AgentNetworkCompileResult['graph'],
  revision: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (canvasContainsGraph(canvas, graph, revision))
      return
    await nextAnimationFrame()
  }
  if (!canvasContainsGraph(canvas, graph, revision)) {
    throw new AgentNetworkCompileError(
      'The generated workflow was not applied to the canvas, so the draft was not saved',
    )
  }
}

function canvasContainsGraph(
  canvas: CanvasReader,
  graph: AgentNetworkCompileResult['graph'],
  revision: string,
): boolean {
  const currentNodes = new Map(canvas.getNodes().map(node => [node.id, node]))
  const currentEdges = new Map(canvas.getEdges().map(edge => [edge.id, edge]))
  if (currentNodes.size !== graph.nodes.length || currentEdges.size !== graph.edges.length)
    return false

  const nodesMatch = graph.nodes.every((node) => {
    const current = currentNodes.get(node.id)
    return current && canvasRevisionOf(current) === revision
  })
  const edgesMatch = graph.edges.every((edge) => {
    const current = currentEdges.get(edge.id)
    return current
      && current.source === edge.source
      && current.target === edge.target
      && current.sourceHandle === edge.sourceHandle
      && current.targetHandle === edge.targetHandle
  })
  return nodesMatch && edgesMatch
}

function canvasRevisionOf(node: Node): unknown {
  const data = node.data as unknown as Record<string, unknown>
  return data[CANVAS_REVISION_FIELD]
}

function withCanvasRevision(
  graph: AgentNetworkCompileResult['graph'],
  revision: string,
): AgentNetworkCompileResult['graph'] {
  return {
    ...graph,
    nodes: graph.nodes.map(node => ({
      ...node,
      data: {
        ...node.data,
        [CANVAS_REVISION_FIELD]: revision,
      },
    })),
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}
