import { resolveAgentNetworkExecuteTask } from '../resolve-execute-task'

describe('resolveAgentNetworkExecuteTask', () => {
  it('should use the initial plan task during the demo phase', () => {
    expect(resolveAgentNetworkExecuteTask({ initialTask: 'Initial task' }))
      .toBe('Initial task')
  })

  it('should prefer a later execution task when one becomes available', () => {
    expect(resolveAgentNetworkExecuteTask({
      initialTask: 'Initial task',
      executeTask: 'Updated task',
    })).toBe('Updated task')
  })

  it('should fall back to the initial task when the execution task is blank', () => {
    expect(resolveAgentNetworkExecuteTask({
      initialTask: 'Initial task',
      executeTask: '   ',
    })).toBe('Initial task')
  })

  it('should return null when no task context exists', () => {
    expect(resolveAgentNetworkExecuteTask(undefined)).toBeNull()
  })
})
