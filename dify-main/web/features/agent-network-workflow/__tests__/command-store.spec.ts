import type { AgentNetworkCompileResult } from '../types'
import {
  claimNextAgentNetworkCommand,
  completeAgentNetworkCommand,
  enqueueAgentNetworkCommand,
  getAgentNetworkCommand,
  resetAgentNetworkCommandStore,
} from '../command-store'

const graph: AgentNetworkCompileResult['graph'] = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 0.7 },
}

describe('agent-network command store', () => {
  beforeEach(() => {
    resetAgentNetworkCommandStore()
  })

  it('should enqueue and atomically claim a compiled graph for one app', () => {
    const command = enqueueAgentNetworkCommand({
      appId: 'app-1',
      graph,
      warnings: [],
      preservePositions: true,
      saveDraft: true,
    })

    expect(claimNextAgentNetworkCommand('app-1')).toMatchObject({
      id: command.id,
      appId: 'app-1',
      status: 'processing',
    })
    expect(claimNextAgentNetworkCommand('app-1')).toBeUndefined()
  })

  it('should keep commands isolated by app id', () => {
    enqueueAgentNetworkCommand({
      appId: 'app-1',
      graph,
      warnings: [],
      preservePositions: true,
      saveDraft: true,
    })

    expect(claimNextAgentNetworkCommand('app-2')).toBeUndefined()
    expect(claimNextAgentNetworkCommand('app-1')).toBeDefined()
  })

  it('should expose the browser completion result', () => {
    const command = enqueueAgentNetworkCommand({
      appId: 'app-1',
      graph,
      warnings: ['unused variable'],
      preservePositions: false,
      saveDraft: false,
    })

    claimNextAgentNetworkCommand('app-1')
    const completed = completeAgentNetworkCommand(command.id, {
      status: 'completed',
    })

    expect(completed).toMatchObject({
      id: command.id,
      status: 'completed',
      warnings: ['unused variable'],
    })
    expect(getAgentNetworkCommand(command.id)?.status).toBe('completed')
  })

  it('should return undefined for an unknown command', () => {
    expect(completeAgentNetworkCommand('missing', {
      status: 'failed',
      error: 'not found',
    })).toBeUndefined()
  })
})
