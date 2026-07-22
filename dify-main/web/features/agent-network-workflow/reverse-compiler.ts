import type {
  AgentNetworkReverseDiagnostic,
  AgentNetworkReverseOptions,
  AgentNetworkReverseResult,
  AgentNetworkReverseStats,
} from './types'
import type { Edge, Node, WorkflowDataUpdater } from '@/app/components/workflow/types'
import { BlockEnum } from '@/app/components/workflow/types'
import { isAgentNetworkGroup } from './groups'

const SUPPORTED_NODE_TYPES = new Set<BlockEnum>([
  BlockEnum.Start,
  BlockEnum.LLM,
  BlockEnum.IfElse,
  BlockEnum.End,
])
const PYTHON_RESERVED_WORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
])

type JsonRecord = Record<string, unknown>
type BranchCase = {
  caseId: string
  conditions: JsonRecord[]
  logicalOperator: 'and' | 'or'
}

class ReverseAbort extends Error {}

class GraphReverseCompiler {
  private readonly graph: WorkflowDataUpdater
  private readonly diagnostics: AgentNetworkReverseDiagnostic[] = []
  private readonly nodesById = new Map<string, Node>()
  private readonly outgoing = new Map<string, Edge[]>()
  private readonly incoming = new Map<string, Edge[]>()
  private readonly emitted = new Set<string>()
  private readonly variableNames = new Map<string, string>()
  private readonly functionNames = new Map<string, string>()
  private readonly startVariables = new Set<string>()
  private startId = ''

  constructor(graph: WorkflowDataUpdater) {
    this.graph = graph
  }

  compile(): { source: string | null, diagnostics: AgentNetworkReverseDiagnostic[], stats: AgentNetworkReverseStats } {
    try {
      this.indexGraph()
      this.validateGraph()
      this.prepareNames()

      const body: string[] = []
      const terminated = this.emitSequence(this.startId, 0, new Set(), body, new Set())
      if (!terminated)
        this.fail('MISSING_OUTPUT', 'Workflow does not reach an End node')

      const reachable = this.collectReachable(this.startId)
      const unreachable = this.graph.nodes.filter(node => !reachable.has(node.id))
      if (unreachable.length) {
        this.fail(
          'UNREACHABLE_NODES',
          `Workflow contains unreachable nodes: ${unreachable.map(node => `${node.data.title} (${node.id})`).join(', ')}`,
        )
      }

      const header = [
        '# Generated from the current Dify workflow.graph.',
        '# This is AgentNetwork pseudocode; review diagnostics before using it.',
        '',
      ]
      return {
        source: `${[...header, ...body].join('\n').trimEnd()}\n`,
        diagnostics: this.diagnostics,
        stats: this.stats(),
      }
    }
    catch (error) {
      if (!(error instanceof ReverseAbort)) {
        this.diagnostics.push({
          severity: 'error',
          code: 'UNEXPECTED_ERROR',
          message: error instanceof Error ? error.message : 'Unexpected reverse compilation error',
        })
      }
      return { source: null, diagnostics: this.diagnostics, stats: this.stats() }
    }
  }

  private indexGraph() {
    for (const node of this.graph.nodes) {
      if (this.nodesById.has(node.id))
        this.fail('DUPLICATE_NODE', `Duplicate node id ${node.id}`, node.id)
      this.nodesById.set(node.id, node)
      this.outgoing.set(node.id, [])
      this.incoming.set(node.id, [])
    }
    for (const edge of this.graph.edges) {
      const sourceEdges = this.outgoing.get(edge.source)
      const targetEdges = this.incoming.get(edge.target)
      if (!sourceEdges || !targetEdges)
        this.fail('DANGLING_EDGE', `Edge ${edge.id} references a missing node`)
      sourceEdges.push(edge)
      targetEdges.push(edge)
    }
  }

  private validateGraph() {
    if (!this.graph.nodes.length)
      this.fail('EMPTY_GRAPH', 'The workflow graph is empty')

    const starts = this.graph.nodes.filter(node => node.data.type === BlockEnum.Start)
    if (starts.length !== 1)
      this.fail('START_COUNT', `Expected exactly one Start node, found ${starts.length}`)
    this.startId = starts[0]!.id

    for (const node of this.graph.nodes) {
      if (!SUPPORTED_NODE_TYPES.has(node.data.type)) {
        this.fail(
          'UNSUPPORTED_NODE',
          `Node ${node.data.title} has unsupported type ${node.data.type}; it was not removed from the export silently`,
          node.id,
        )
      }
      if (node.data.type === BlockEnum.Start && (this.incoming.get(node.id)?.length ?? 0) > 0)
        this.fail('START_HAS_INPUT', 'Start node cannot have incoming edges', node.id)
      if (node.data.type === BlockEnum.End && (this.outgoing.get(node.id)?.length ?? 0) > 0)
        this.fail('END_HAS_OUTPUT', 'End node cannot have outgoing edges', node.id)
    }

    this.assertAcyclic(this.startId, new Set(), new Set())
  }

  private prepareNames() {
    const start = this.nodesById.get(this.startId)!
    const variables = Array.isArray(asRecord(start.data).variables) ? asRecord(start.data).variables as unknown[] : []
    for (const item of variables) {
      const variable = asRecord(item).variable
      if (typeof variable === 'string' && isPythonIdentifier(variable))
        this.startVariables.add(variable)
    }

    const endHints = new Map<string, string[]>()
    for (const node of this.graph.nodes) {
      if (node.data.type !== BlockEnum.End)
        continue
      const outputs = asArray(asRecord(node.data).outputs)
      for (const outputValue of outputs) {
        const output = asRecord(outputValue)
        const selector = stringArray(output.value_selector)
        const variable = output.variable === 'final_result' ? 'answer' : output.variable
        if (!selector.length || typeof variable !== 'string' || !isPythonIdentifier(variable))
          continue
        const sourceId = selector[0]!
        const names = endHints.get(sourceId) ?? []
        if (!names.includes(variable))
          names.push(variable)
        endHints.set(sourceId, names)
      }
    }

    const usedVariables = new Set(this.startVariables)
    for (const node of this.graph.nodes) {
      if (node.data.type !== BlockEnum.LLM)
        continue

      const title = node.data.title || 'Agent'
      const configuredGroup = asRecord(node.data).agent_network_group
      const callable = isAgentNetworkGroup(configuredGroup)
        ? configuredGroup
        : fallbackGroupName(title, node.id, this.diagnostics)
      this.functionNames.set(node.id, callable)
      const hints = endHints.get(node.id) ?? []
      let variable = hints[0]
      if (hints.length > 1) {
        this.warn(
          'MULTIPLE_OUTPUT_NAMES',
          `Node output has multiple names (${hints.join(', ')}); using ${hints[0]}`,
          node.id,
        )
      }
      if (!variable) {
        variable = uniqueName(`${snakeName(stripGroupSuffix(title)) || `agent_${shortId(node.id)}`}_result`, usedVariables)
        this.warn(
          'INFERRED_VARIABLE',
          `Graph does not retain the original assignment name for ${title}; generated ${variable}`,
          node.id,
        )
      }
      this.variableNames.set(node.id, variable)
      usedVariables.add(variable)
    }
  }

  private emitSequence(
    startId: string,
    indent: number,
    stopIds: Set<string>,
    lines: string[],
    activePath: Set<string>,
  ): boolean {
    let currentId: string | null = startId
    while (currentId) {
      if (stopIds.has(currentId))
        return false
      if (activePath.has(currentId))
        this.fail('CYCLE', `Workflow contains a cycle at node ${currentId}`, currentId)
      if (this.emitted.has(currentId))
        this.fail('UNSTRUCTURED_JOIN', `Node ${currentId} is reached through an unstructured join`, currentId)

      activePath.add(currentId)
      this.emitted.add(currentId)
      const node = this.nodesById.get(currentId)
      if (!node)
        this.fail('MISSING_NODE', `Node ${currentId} does not exist`)

      if (node.data.type === BlockEnum.Start) {
        currentId = this.singleSuccessor(node)
      }
      else if (node.data.type === BlockEnum.LLM) {
        this.emitAgent(node, indent, lines)
        currentId = this.singleSuccessor(node)
      }
      else if (node.data.type === BlockEnum.End) {
        this.emitEnd(node, indent, lines)
        activePath.delete(node.id)
        return true
      }
      else if (node.data.type === BlockEnum.IfElse) {
        const result = this.emitBranch(node, indent, lines, activePath)
        if (result.terminated) {
          activePath.delete(node.id)
          return true
        }
        currentId = result.joinId
      }
      else {
        this.fail('UNSUPPORTED_NODE', `Unsupported node type ${node.data.type}`, node.id)
      }
      activePath.delete(node.id)
    }
    return false
  }

  private emitAgent(node: Node, indent: number, lines: string[]) {
    const data = asRecord(node.data)
    const variable = this.variableNames.get(node.id)!
    const callable = this.functionNames.get(node.id)!
    const prompt = this.renderPrompt(node)
    const skills = this.readSkills(node)
    const model = asRecord(data.model)

    if (typeof model.provider === 'string' || typeof model.name === 'string') {
      const provider = typeof model.provider === 'string' ? model.provider : 'unknown-provider'
      const name = typeof model.name === 'string' ? model.name : 'unknown-model'
      lines.push(`${padding(indent)}# Dify model: ${provider} / ${name}`)
    }
    lines.push(`${padding(indent)}${variable} = ${callable}(`)
    lines.push(`${padding(indent + 1)}task=${prompt},`)
    if (skills.length)
      lines.push(`${padding(indent + 1)}skills=[${skills.map(pythonString).join(', ')}],`)
    lines.push(`${padding(indent)})`)
    lines.push('')
  }

  private emitEnd(node: Node, indent: number, lines: string[]) {
    const outputs = asArray(asRecord(node.data).outputs)
    if (outputs.length !== 1) {
      this.fail(
        'END_OUTPUT_COUNT',
        `End node must have exactly one output for canonical pseudocode, found ${outputs.length}`,
        node.id,
      )
    }
    const selector = stringArray(asRecord(outputs[0]).value_selector)
    if (!selector.length)
      this.fail('END_OUTPUT_SELECTOR', 'End output is missing a value selector', node.id)
    lines.push(`${padding(indent)}final_result = ${this.selectorExpression(selector, node.id)}`)
    lines.push('')
  }

  private emitBranch(
    node: Node,
    indent: number,
    lines: string[],
    activePath: Set<string>,
  ): { terminated: boolean, joinId: string | null } {
    const cases = this.readCases(node)
    const outgoing = this.outgoing.get(node.id) ?? []
    const entries = cases.map(branchCase => ({
      branchCase,
      target: this.branchTarget(node, outgoing, branchCase.caseId),
    }))
    const elseTarget = this.branchTarget(node, outgoing, 'false')
    const targets = [...entries.map(entry => entry.target), elseTarget]
    const joinId = this.findCommonJoin(targets)
    const terminalMerge = joinId ? null : this.findTerminalMerge(targets)
    const stopIds = joinId
      ? new Set([joinId])
      : new Set(terminalMerge?.endIds ?? [])
    let everyBranchTerminates = true

    entries.forEach((entry, index) => {
      const keyword = index === 0 ? 'if' : 'elif'
      lines.push(`${padding(indent)}${keyword} ${this.renderCase(entry.branchCase, node.id)}:`)
      if (stopIds.has(entry.target)) {
        lines.push(`${padding(indent + 1)}pass`)
      }
      else {
        const terminated = this.emitSequence(entry.target, indent + 1, stopIds, lines, new Set(activePath))
        everyBranchTerminates &&= terminated
      }
    })

    lines.push(`${padding(indent)}else:`)
    if (stopIds.has(elseTarget)) {
      lines.push(`${padding(indent + 1)}pass`)
    }
    else {
      const terminated = this.emitSequence(elseTarget, indent + 1, stopIds, lines, new Set(activePath))
      everyBranchTerminates &&= terminated
    }
    lines.push('')

    if (joinId)
      return { terminated: false, joinId }
    if (terminalMerge) {
      terminalMerge.endIds.forEach(endId => this.emitted.add(endId))
      lines.push(`${padding(indent)}final_result = ${terminalMerge.expression}`)
      lines.push('')
      return { terminated: true, joinId: null }
    }
    if (!everyBranchTerminates)
      this.fail('OPEN_BRANCH', `Every branch of ${node.data.title} must reach an End node or a common join`, node.id)
    return { terminated: true, joinId: null }
  }

  private renderCase(branchCase: BranchCase, nodeId: string): string {
    if (!branchCase.conditions.length)
      this.fail('EMPTY_CONDITION', `Branch case ${branchCase.caseId} has no conditions`, nodeId)
    const rendered = branchCase.conditions.map(condition => this.renderCondition(condition, nodeId))
    return rendered.join(` ${branchCase.logicalOperator} `)
  }

  private renderCondition(condition: JsonRecord, nodeId: string): string {
    const selector = stringArray(condition.variable_selector)
    if (!selector.length)
      this.fail('CONDITION_SELECTOR', 'If/Else condition is missing variable_selector', nodeId)
    let left = this.selectorExpression(selector, nodeId)
    if (typeof condition.key === 'string' && condition.key)
      left = `${left}.get(${pythonString(condition.key)})`

    const operator = typeof condition.comparison_operator === 'string' ? condition.comparison_operator : ''
    const value = pythonValue(condition.value)
    const binary: Record<string, string> = {
      'is': '==',
      'is not': '!=',
      '=': '==',
      '\u2260': '!=',
      '>': '>',
      '\u2265': '>=',
      '<': '<',
      '\u2264': '<=',
      'in': 'in',
      'not in': 'not in',
    }
    if (binary[operator])
      return `${left} ${binary[operator]} ${value}`
    if (operator === 'empty')
      return `not ${left}`
    if (operator === 'not empty')
      return left
    if (operator === 'is null')
      return `${left} is None`
    if (operator === 'is not null')
      return `${left} is not None`
    if (operator === 'contains')
      return `${value} in ${left}`
    if (operator === 'not contains')
      return `${value} not in ${left}`
    if (operator === 'start with')
      return `${left}.startswith(${value})`
    if (operator === 'end with')
      return `${left}.endswith(${value})`
    this.fail('UNSUPPORTED_OPERATOR', `Unsupported If/Else operator ${operator || '(empty)'}`, nodeId)
  }

  private renderPrompt(node: Node): string {
    const templates = asArray(asRecord(node.data).prompt_template)
    const texts = templates
      .map(item => asRecord(item).text)
      .filter((text): text is string => typeof text === 'string')
    const prompt = texts.join('\n')
    if (!prompt) {
      const fallback = this.startVariables.has('task') ? 'task' : pythonString('')
      this.warn('EMPTY_PROMPT', `Node ${node.data.title} has no prompt; using ${fallback}`, node.id)
      return fallback
    }

    const tokens = [...prompt.matchAll(/\{\{#([^#]+)#\}\}/g)]
    if (tokens.length === 1 && tokens[0]![0] === prompt)
      return this.selectorExpression(tokens[0]![1]!.split('.'), node.id)
    if (!tokens.length)
      return pythonString(prompt)

    let cursor = 0
    let rendered = ''
    for (const token of tokens) {
      const index = token.index ?? 0
      rendered += escapeFStringLiteral(prompt.slice(cursor, index))
      rendered += `{${this.selectorExpression(token[1]!.split('.'), node.id)}}`
      cursor = index + token[0].length
    }
    rendered += escapeFStringLiteral(prompt.slice(cursor))
    return `f"${rendered}"`
  }

  private selectorExpression(selector: string[], nodeId: string): string {
    const sourceId = selector[0]
    if (!sourceId)
      this.fail('EMPTY_SELECTOR', 'Value selector has no source node', nodeId)
    if (sourceId === this.startId) {
      const variable = selector[1]
      if (!variable || !isPythonIdentifier(variable))
        this.fail('START_SELECTOR', `Cannot represent Start selector ${selector.join('.')}`, nodeId)
      return variable
    }

    const source = this.nodesById.get(sourceId)
    if (!source || source.data.type !== BlockEnum.LLM)
      this.fail('UNSUPPORTED_SELECTOR', `Selector source ${sourceId} is not a supported LLM or Start node`, nodeId)
    const variable = this.variableNames.get(sourceId)!
    if (selector[1] === 'structured_output' && selector[2])
      return `${variable}.get(${pythonString(selector.slice(2).join('.'))})`
    return variable
  }

  private readSkills(node: Node): string[] {
    const raw = asRecord(node.data).skills
    if (raw === undefined || raw === null)
      return []
    if (!Array.isArray(raw)) {
      this.warn('INVALID_SKILLS', 'data.skills is not an array and was ignored', node.id)
      return []
    }
    const skills: string[] = []
    for (const item of raw) {
      if (typeof item !== 'string' || !item.trim()) {
        this.warn('INVALID_SKILL', 'A non-string or empty skill entry was ignored', node.id)
        continue
      }
      const skill = item.trim()
      if (!skills.includes(skill))
        skills.push(skill)
    }
    if (skills.length < raw.length)
      this.warn('NORMALIZED_SKILLS', 'Duplicate or invalid skills were removed during export', node.id)
    return skills
  }

  private readCases(node: Node): BranchCase[] {
    const values = asArray(asRecord(node.data).cases)
    if (!values.length)
      this.fail('NO_BRANCH_CASES', 'If/Else node has no cases', node.id)
    return values.map((value, index) => {
      const item = asRecord(value)
      const caseId = typeof item.case_id === 'string' && item.case_id ? item.case_id : `case_${index + 1}`
      return {
        caseId,
        conditions: asArray(item.conditions).map(asRecord),
        logicalOperator: item.logical_operator === 'or' ? 'or' : 'and',
      }
    })
  }

  private branchTarget(node: Node, edges: Edge[], handle: string): string {
    const matches = edges.filter(edge => edge.sourceHandle === handle)
    if (matches.length !== 1) {
      this.fail(
        'BRANCH_EDGE_COUNT',
        `Branch handle ${handle} must have exactly one outgoing edge, found ${matches.length}`,
        node.id,
      )
    }
    return matches[0]!.target
  }

  private singleSuccessor(node: Node): string | null {
    const edges = this.outgoing.get(node.id) ?? []
    if (edges.length > 1)
      this.fail('MULTIPLE_OUTPUTS', `Node ${node.data.title} has multiple outputs without an If/Else node`, node.id)
    return edges[0]?.target ?? null
  }

  private findCommonJoin(starts: string[]): string | null {
    if (!starts.length)
      return null
    const distances = starts.map(start => this.distancesFrom(start))
    const common = [...distances[0]!.keys()].filter(candidate => distances.every(items => items.has(candidate)))
    if (!common.length)
      return null
    common.sort((left, right) => {
      const leftDistances = distances.map(items => items.get(left)!)
      const rightDistances = distances.map(items => items.get(right)!)
      return Math.max(...leftDistances) - Math.max(...rightDistances)
        || sum(leftDistances) - sum(rightDistances)
        || left.localeCompare(right)
    })
    return common[0] ?? null
  }

  private findTerminalMerge(starts: string[]): { endIds: string[], expression: string } | null {
    const ends = starts.map(start => this.findLinearEnd(start))
    if (ends.includes(null))
      return null
    const endNodes = ends as Node[]
    const expressions = endNodes.map((end) => {
      const outputs = asArray(asRecord(end.data).outputs)
      if (outputs.length !== 1)
        return null
      const selector = stringArray(asRecord(outputs[0]).value_selector)
      if (!selector.length)
        return null
      return this.selectorExpression(selector, end.id)
    })
    if (expressions.includes(null) || new Set(expressions).size !== 1)
      return null
    return {
      endIds: [...new Set(endNodes.map(end => end.id))],
      expression: expressions[0]!,
    }
  }

  private findLinearEnd(start: string): Node | null {
    const visited = new Set<string>()
    let currentId: string | null = start
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const node = this.nodesById.get(currentId)
      if (!node)
        return null
      if (node.data.type === BlockEnum.End)
        return node
      if (node.data.type === BlockEnum.IfElse)
        return null
      const edges: Edge[] = this.outgoing.get(currentId) ?? []
      if (edges.length !== 1)
        return null
      currentId = edges[0]!.target
    }
    return null
  }

  private distancesFrom(start: string): Map<string, number> {
    const distances = new Map<string, number>([[start, 0]])
    const queue = [start]
    while (queue.length) {
      const current = queue.shift()!
      const nextDistance = distances.get(current)! + 1
      for (const edge of this.outgoing.get(current) ?? []) {
        if (distances.has(edge.target))
          continue
        distances.set(edge.target, nextDistance)
        queue.push(edge.target)
      }
    }
    return distances
  }

  private collectReachable(start: string): Set<string> {
    return new Set(this.distancesFrom(start).keys())
  }

  private assertAcyclic(nodeId: string, visiting: Set<string>, visited: Set<string>) {
    if (visiting.has(nodeId))
      this.fail('CYCLE', `Workflow contains a cycle at node ${nodeId}`, nodeId)
    if (visited.has(nodeId))
      return
    visiting.add(nodeId)
    for (const edge of this.outgoing.get(nodeId) ?? [])
      this.assertAcyclic(edge.target, visiting, visited)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }

  private stats(): AgentNetworkReverseStats {
    const agents = this.graph.nodes.filter(node => node.data.type === BlockEnum.LLM)
    return {
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
      agents: agents.length,
      branches: this.graph.nodes.filter(node => node.data.type === BlockEnum.IfElse).length,
      skills: agents.reduce((count, node) => count + this.readSkillsWithoutDiagnostics(node).length, 0),
    }
  }

  private readSkillsWithoutDiagnostics(node: Node): string[] {
    const raw = asRecord(node.data).skills
    return Array.isArray(raw)
      ? [...new Set(raw.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()))]
      : []
  }

  private warn(code: string, message: string, nodeId?: string) {
    this.diagnostics.push({ severity: 'warning', code, message, nodeId })
  }

  private fail(code: string, message: string, nodeId?: string): never {
    this.diagnostics.push({ severity: 'error', code, message, nodeId })
    throw new ReverseAbort(message)
  }
}

export function compileDifyGraphToAgentNetworkPseudocode(
  graph: WorkflowDataUpdater,
  options: AgentNetworkReverseOptions = {},
): AgentNetworkReverseResult {
  const result = new GraphReverseCompiler(graph).compile()
  return {
    ...result,
    fileName: `${fileStem(options.workflowName ?? 'workflow')}.agentnetwork.py`,
  }
}

function fallbackGroupName(
  title: string,
  nodeId: string,
  diagnostics: AgentNetworkReverseDiagnostic[],
): string {
  if (isPythonIdentifier(title) && /Group$/i.test(title))
    return `${title.slice(0, -5)}Group`
  const base = pascalName(stripGroupSuffix(title))
  if (base) {
    diagnostics.push({
      severity: 'warning',
      code: 'NORMALIZED_FUNCTION_NAME',
      message: `Node title ${title} was normalized to ${base}Group`,
      nodeId,
    })
    return `${base}Group`
  }
  const fallback = `Agent${shortId(nodeId)}Group`
  diagnostics.push({
    severity: 'warning',
    code: 'GENERATED_FUNCTION_NAME',
    message: `Node title ${title} is not a Python identifier; generated ${fallback}`,
    nodeId,
  })
  return fallback
}

function pascalName(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .match(/[A-Z]+|\d+/gi)
  if (!words?.length)
    return ''
  const result = words.map(word => `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`).join('')
  return /^\d/.test(result) ? `Agent${result}` : result
}

function stripGroupSuffix(value: string): string {
  return value.replace(/group$/i, '')
}

function snakeName(value: string): string {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  const normalized = expanded.replace(/[^A-Z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()
  return normalized && !/^\d/.test(normalized) ? normalized : ''
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = PYTHON_RESERVED_WORDS.has(base) ? `${base}_value` : base
  let suffix = 2
  while (used.has(candidate))
    candidate = `${base}_${suffix++}`
  return candidate
}

function shortId(value: string): string {
  const compact = value.replace(/[^A-Z0-9]/gi, '')
  const shortened = (compact.slice(0, 8) || 'Node').replace(/^(\d)/, 'N$1')
  return `${shortened[0]!.toUpperCase()}${shortened.slice(1)}`
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Z_]\w*$/i.test(value) && !PYTHON_RESERVED_WORDS.has(value)
}

function fileStem(value: string): string {
  const withoutControlCharacters = [...value].filter(character => character.charCodeAt(0) >= 32).join('')
  const normalized = withoutControlCharacters.trim().replace(/[<>:"/\\|?*]+/g, '-').replace(/[. ]+$/g, '')
  return normalized || 'workflow'
}

function pythonString(value: string): string {
  return JSON.stringify(value)
}

function pythonValue(value: unknown): string {
  if (value === null || value === undefined)
    return 'None'
  if (typeof value === 'boolean')
    return value ? 'True' : 'False'
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : 'None'
  if (typeof value === 'string')
    return pythonString(value)
  if (Array.isArray(value))
    return `[${value.map(pythonValue).join(', ')}]`
  return pythonString(JSON.stringify(value))
}

function escapeFStringLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\{/g, '{{')
    .replace(/\}/g, '}}')
}

function padding(level: number): string {
  return '    '.repeat(level)
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
