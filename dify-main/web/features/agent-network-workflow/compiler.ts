import type { Position } from 'reactflow'
import type {
  ParsedCall,
  ParsedComparison,
  ParsedCondition,
  ParsedStatement,
  ParsedValue,
} from './python-syntax'
import type {
  AgentNetworkCompileOptions,
  AgentNetworkCompileResult,
  AgentNetworkModelConfig,
} from './types'
import type { Edge, Node, WorkflowDataUpdater } from '@/app/components/workflow/types'
import { BlockEnum } from '@/app/components/workflow/types'
import {
  cloneProducerMap,
  cloneRecord,
  conditionValue,
  difyVariableType,
  inputType,
  intersectSets,
  isRecord,
  mergeProducerMaps,
  schemaTypeForComparison,
  schemaTypeForInput,
  selectorTemplate,
} from './compiler-helpers'
import {
  AgentNetworkSyntaxError,
  parseAgentNetworkPseudocode,
} from './python-syntax'
import {
  AgentNetworkCompileError,
} from './types'

const START_NODE_ID = 'start'
const SOURCE_HANDLE = 'source'
const TARGET_HANDLE = 'target'
const FALSE_HANDLE = 'false'
const NODE_WIDTH = 244
const NODE_HEIGHT = 90
const BRANCH_HEIGHT = 126
const BASE_X = 80
const BASE_Y = 280
const HORIZONTAL_GAP = 320
const VERTICAL_GAP = 180
const LEFT_POSITION = 'left' as Position
const RIGHT_POSITION = 'right' as Position

type CallStep = {
  id: string
  kind: 'call'
  functionName: string
  assignTo: string | null
  args: ParsedValue[]
  kwargs: Record<string, ParsedValue>
  line: number
}

type BranchStep = {
  id: string
  kind: 'branch'
  cases: Array<{ caseId: string, condition: ParsedCondition, body: string[] }>
  elseCase: { caseId: 'else', body: string[] }
  line: number
}

type SemanticStep = CallStep | BranchStep

type Binding = {
  id: string
  target: string
  value: ParsedValue
  sources: Record<string, string[]>
  line: number
}

type Terminal = {
  id: string
  via: 'reply' | 'return' | 'last-assign' | 'last-call'
  assignedName: string | null
  output: ParsedValue | null
  outputStep: string | null
  line: number
}

type FlowSemantics = {
  body: string[]
  inputs: Array<{ name: string, type: string }>
  steps: SemanticStep[]
  bindings: Binding[]
  terminals: Terminal[]
  variables: Record<string, string[]>
  warnings: string[]
}

type Incoming = { nodeId: string, sourceHandle: string }

class SemanticCompiler {
  private readonly terminalFunctions: Set<string>
  private readonly inputTypes: Record<string, string>
  private readonly steps: SemanticStep[] = []
  private producers: Record<string, string[]> = {}
  private assigned = new Set<string>()
  private readonly consumed = new Set<string>()
  private readonly inputs = new Map<string, null>()
  private readonly terminals: Terminal[] = []
  private readonly bindings: Binding[] = []
  private readonly warnings: string[] = []
  private readonly everAssigned = new Set<string>()
  private readonly idCounts = new Map<string, number>()
  private branchCount = 0
  private terminalCount = 0
  private bindingCount = 0

  constructor(options: AgentNetworkCompileOptions) {
    this.terminalFunctions = new Set(options.terminalFunctions ?? ['reply'])
    this.inputTypes = options.inputTypes ?? {}
  }

  compile(statements: ParsedStatement[]): FlowSemantics {
    const body = this.walk(statements, true)
    if (!this.terminals.length)
      throw new AgentNetworkCompileError('Unable to infer a workflow output')
    this.checkDeadVariables()
    return {
      body,
      inputs: [...this.inputs.keys()].map(name => ({
        name,
        type: this.inputTypes[name] ?? (name.toLowerCase().includes('file') ? 'file' : 'paragraph'),
      })),
      steps: this.steps,
      bindings: this.bindings,
      terminals: this.terminals,
      variables: this.producers,
      warnings: this.warnings,
    }
  }

  private walk(statements: ParsedStatement[], tail: boolean): string[] {
    const ids: string[] = []
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index]!
      const last = tail && index === statements.length - 1
      if (statement.kind === 'call' && this.terminalFunctions.has(statement.call.functionName)) {
        this.registerCallReferences(statement.call, statement.line)
        const values = [...statement.call.args, ...Object.values(statement.call.kwargs)]
        ids.push(this.addTerminal('reply', values[0] ?? null, null, null, statement.line))
        if (index < statements.length - 1)
          this.warnings.push(`Line ${statement.line}: code after ${statement.call.functionName} is unreachable`)
        break
      }
      if (statement.kind === 'assign-call') {
        const stepId = this.addCall(statement.call, statement.target, statement.line)
        ids.push(stepId)
        if (last) {
          ids.push(this.addTerminal(
            'last-assign',
            { expr: 'var', name: statement.target, raw: statement.target, refs: [statement.target] },
            statement.target,
            null,
            statement.line,
          ))
        }
        continue
      }
      if (statement.kind === 'call') {
        const stepId = this.addCall(statement.call, null, statement.line)
        ids.push(stepId)
        if (last)
          ids.push(this.addTerminal('last-call', null, null, stepId, statement.line))
        continue
      }
      if (statement.kind === 'assign') {
        ids.push(this.addBinding(statement))
        if (last)
          ids.push(this.addTerminal('last-assign', statement.value, statement.target, null, statement.line))
        continue
      }
      if (statement.kind === 'if') {
        ids.push(this.addBranch(statement, last))
        continue
      }
      if (statement.kind === 'return') {
        if (statement.value)
          this.registerValue(statement.value, statement.line)
        ids.push(this.addTerminal('return', statement.value, null, null, statement.line))
        if (index < statements.length - 1)
          this.warnings.push(`Line ${statement.line}: code after return is unreachable`)
        break
      }
    }
    return ids
  }

  private addCall(call: ParsedCall, target: string | null, line: number): string {
    this.registerCallReferences(call, line)
    if (target)
      this.validateAssignment(target, line)
    for (const value of [...call.args, ...Object.values(call.kwargs)]) {
      if (value.expr === 'raw')
        throw new AgentNetworkCompileError(`Unsupported argument expression: ${value.raw}`, line)
    }
    const id = this.newStepId(call.functionName)
    this.steps.push({
      id,
      kind: 'call',
      functionName: call.functionName,
      assignTo: target,
      args: call.args,
      kwargs: call.kwargs,
      line,
    })
    if (target) {
      this.producers[target] = [id]
      this.assigned.add(target)
      this.everAssigned.add(target)
    }
    return id
  }

  private addBinding(statement: Extract<ParsedStatement, { kind: 'assign' }>): string {
    this.registerValue(statement.value, statement.line)
    this.validateAssignment(statement.target, statement.line)
    if (statement.value.expr === 'raw')
      throw new AgentNetworkCompileError(`Unsupported assignment expression: ${statement.value.raw}`, statement.line)
    const sources = Object.fromEntries(
      statement.value.refs.map(name => [name, [...(this.producers[name] ?? [])]]),
    )
    const inherited = [...new Set(Object.values(sources).flat())]
    const id = `binding_${++this.bindingCount}`
    this.bindings.push({ id, target: statement.target, value: statement.value, sources, line: statement.line })
    this.producers[statement.target] = inherited
    this.assigned.add(statement.target)
    this.everAssigned.add(statement.target)
    return id
  }

  private addBranch(statement: Extract<ParsedStatement, { kind: 'if' }>, tail: boolean): string {
    const id = `branch_${++this.branchCount}`
    const step: BranchStep = { id, kind: 'branch', cases: [], elseCase: { caseId: 'else', body: [] }, line: statement.line }
    this.steps.push(step)
    const assignedSnapshot = new Set(this.assigned)
    const producerSnapshot = cloneProducerMap(this.producers)
    const pathAssigned: Set<string>[] = []
    const pathProducers: Array<Record<string, string[]>> = []
    for (let index = 0; index < statement.cases.length; index++) {
      const branchCase = statement.cases[index]!
      if (!branchCase.condition.parsed)
        throw new AgentNetworkCompileError(`Condition cannot be represented safely: ${branchCase.condition.raw}`, branchCase.line)
      this.assigned = new Set(assignedSnapshot)
      this.producers = cloneProducerMap(producerSnapshot)
      this.registerCondition(branchCase.condition, branchCase.line)
      const body = this.walk(branchCase.body, tail)
      pathAssigned.push(new Set(this.assigned))
      pathProducers.push(cloneProducerMap(this.producers))
      step.cases.push({ caseId: `case_${index + 1}`, condition: branchCase.condition, body })
    }
    this.assigned = new Set(assignedSnapshot)
    this.producers = cloneProducerMap(producerSnapshot)
    step.elseCase.body = this.walk(statement.elseBody, tail)
    pathAssigned.push(new Set(this.assigned))
    pathProducers.push(cloneProducerMap(this.producers))
    if (tail && !statement.elseBody.length)
      throw new AgentNetworkCompileError('A terminal branch must include else', statement.line)
    this.assigned = intersectSets(pathAssigned)
    this.producers = mergeProducerMaps(pathProducers)
    return id
  }

  private addTerminal(
    via: Terminal['via'],
    output: ParsedValue | null,
    assignedName: string | null,
    outputStep: string | null,
    line: number,
  ): string {
    if (output)
      this.registerValue(output, line)
    const id = `terminal_${++this.terminalCount}`
    this.terminals.push({ id, via, assignedName, output, outputStep, line })
    return id
  }

  private registerCallReferences(call: ParsedCall, line: number) {
    for (const value of [...call.args, ...Object.values(call.kwargs)])
      this.registerValue(value, line)
  }

  private registerValue(value: ParsedValue, line: number) {
    this.registerReferences(value.refs, line)
  }

  private registerCondition(condition: ParsedCondition, line: number) {
    this.registerReferences(condition.refs, line)
    for (const comparison of condition.comparisons) {
      if (comparison.value)
        this.registerValue(comparison.value, line)
    }
  }

  private registerReferences(references: string[], line: number) {
    for (const name of references) {
      this.consumed.add(name)
      if (this.assigned.has(name))
        continue
      if (name in this.producers || this.everAssigned.has(name)) {
        throw new AgentNetworkCompileError(`Variable ${name} is not defined on every path`, line)
      }
      this.inputs.set(name, null)
    }
  }

  private validateAssignment(target: string, line: number) {
    if (this.assigned.has(target))
      throw new AgentNetworkCompileError(`Variable ${target} is assigned more than once on the same path`, line)
    if (this.inputs.has(target))
      throw new AgentNetworkCompileError(`Input variable ${target} cannot be overwritten`, line)
  }

  private checkDeadVariables() {
    const protectedVariables = new Set<string>()
    for (const terminal of this.terminals) {
      if (terminal.assignedName)
        protectedVariables.add(terminal.assignedName)
      if (terminal.output?.expr === 'var')
        protectedVariables.add(terminal.output.name)
    }
    for (const variable of Object.keys(this.producers)) {
      if (!this.consumed.has(variable) && !protectedVariables.has(variable))
        this.warnings.push(`Variable ${variable} is assigned but never used`)
    }
  }

  private newStepId(functionName: string): string {
    const base = functionName.toLowerCase()
    const count = (this.idCounts.get(base) ?? 0) + 1
    this.idCounts.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  }
}

class DifyGraphCompiler {
  private readonly options: AgentNetworkCompileOptions
  private readonly steps: Map<string, SemanticStep>
  private readonly bindings: Map<string, Binding>
  private readonly bindingsByTarget: Map<string, Binding>
  private readonly terminals: Map<string, Terminal>
  private readonly variables: Record<string, string[]>
  private readonly inputTypes: Record<string, string>
  private readonly structuredFields = new Map<string, Record<string, 'string' | 'number' | 'boolean'>>()
  private readonly nodes: Node[] = []
  private readonly edges: Edge[] = []
  private readonly nodeTypes = new Map<string, BlockEnum>()
  private readonly seenEdges = new Set<string>()
  private readonly visitedSteps = new Set<string>()
  private readonly terminalCounts = new Map<string, number>()

  constructor(semantics: FlowSemantics, options: AgentNetworkCompileOptions) {
    this.options = options
    this.steps = new Map(semantics.steps.map(step => [step.id, step]))
    this.bindings = new Map(semantics.bindings.map(binding => [binding.id, binding]))
    this.bindingsByTarget = new Map(semantics.bindings.map(binding => [binding.target, binding]))
    this.terminals = new Map(semantics.terminals.map(terminal => [terminal.id, terminal]))
    this.variables = semantics.variables
    this.inputTypes = Object.fromEntries(semantics.inputs.map(input => [input.name, input.type]))
  }

  compile(semantics: FlowSemantics): WorkflowDataUpdater {
    this.inferStructuredOutputs()
    this.appendNode(this.buildStartNode(semantics.inputs))
    for (const step of this.steps.values())
      this.appendNode(step.kind === 'call' ? this.buildCallNode(step) : this.buildBranchNode(step))
    const exits = this.walkSequence(semantics.body, [{ nodeId: START_NODE_ID, sourceHandle: SOURCE_HANDLE }])
    if (exits.length)
      throw new AgentNetworkCompileError('Workflow finishes without reaching an output')
    const missing = [...this.steps.keys()].filter(stepId => !this.visitedSteps.has(stepId))
    if (missing.length)
      throw new AgentNetworkCompileError(`Workflow contains unreachable steps: ${missing.join(', ')}`)
    this.fillEdgeTypes()
    this.applyLayout()
    return { nodes: this.nodes, edges: this.edges, viewport: { x: 0, y: 0, zoom: 0.7 } }
  }

  private inferStructuredOutputs() {
    for (const step of this.steps.values()) {
      if (step.kind !== 'branch')
        continue
      for (const branchCase of step.cases) {
        for (const comparison of branchCase.condition.comparisons) {
          if (!comparison.key)
            continue
          const sourceId = this.singleVariableSource(comparison.variable)
          const sourceStep = this.steps.get(sourceId)
          if (sourceStep?.kind !== 'call')
            throw new AgentNetworkCompileError(`${comparison.variable}.${comparison.key} must come from a Group call`)
          const fieldType = schemaTypeForComparison(comparison)
          const fields = this.structuredFields.get(sourceId) ?? {}
          if (fields[comparison.key] && fields[comparison.key] !== fieldType)
            throw new AgentNetworkCompileError(`${comparison.variable}.${comparison.key} is compared with incompatible types`)
          fields[comparison.key] = fieldType
          this.structuredFields.set(sourceId, fields)
        }
      }
    }
  }

  private buildStartNode(inputs: FlowSemantics['inputs']): Node {
    const variables = inputs.map(input => ({
      variable: input.name,
      label: input.name,
      type: inputType(input.type),
      required: true,
      ...(inputType(input.type) === 'text-input' ? { max_length: null, options: [] } : {}),
    }))
    return this.buildNode(START_NODE_ID, BlockEnum.Start, {
      type: BlockEnum.Start,
      title: 'Start',
      desc: '',
      selected: false,
      variables,
    })
  }

  private buildCallNode(step: CallStep): Node {
    if (!step.functionName.endsWith('Group'))
      throw new AgentNetworkCompileError(`Function ${step.functionName} is unsupported; workflow calls must end with Group`, step.line)
    const override = this.options.groupOverrides?.[step.functionName]
    const defaultConfig = cloneRecord(override?.defaultConfig ?? this.options.llmDefaultConfig ?? {})
    const normalized = defaultConfig.type === BlockEnum.LLM && isRecord(defaultConfig.config)
      ? cloneRecord(defaultConfig.config)
      : defaultConfig
    const model = validateModel(override?.model ?? this.options.model ?? (isRecord(normalized.model) ? normalized.model : null))
    const data: Record<string, unknown> = {
      ...normalized,
      type: BlockEnum.LLM,
      title: override?.title ?? step.functionName,
      agent_network_group: step.functionName,
      desc: typeof normalized.desc === 'string' ? normalized.desc : '',
      selected: false,
      model,
      prompt_template: [{ role: 'user', text: this.renderCallPrompt(step) }],
      context: isRecord(normalized.context) ? normalized.context : { enabled: false, variable_selector: [] },
      vision: isRecord(normalized.vision) ? normalized.vision : { enabled: false, configs: { variable_selector: [] } },
      memory: isRecord(normalized.memory) ? normalized.memory : { enabled: false, window: { enabled: false, size: 50 } },
      retry_config: isRecord(normalized.retry_config)
        ? normalized.retry_config
        : {
            enabled: false,
            max_retries: 1,
            retry_interval: 1000,
            exponential_backoff: { enabled: false, multiplier: 2, max_interval: 10000 },
          },
    }
    const fields = this.structuredFields.get(step.id)
    if (fields && Object.keys(fields).length) {
      data.structured_output_enabled = true
      data.structured_output = {
        schema: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, { type }])),
          required: Object.keys(fields),
          additionalProperties: false,
        },
      }
    }
    else {
      data.structured_output_enabled = false
      delete data.structured_output
    }
    return this.buildNode(step.id, BlockEnum.LLM, data)
  }

  private buildBranchNode(step: BranchStep): Node {
    const cases = step.cases.map(branchCase => ({
      case_id: branchCase.caseId,
      logical_operator: branchCase.condition.logical,
      conditions: branchCase.condition.comparisons.map((comparison, index) => (
        this.buildCondition(step.id, branchCase.caseId, index, comparison)
      )),
    }))
    return this.buildNode(step.id, BlockEnum.IfElse, {
      type: BlockEnum.IfElse,
      title: 'IF/ELSE',
      desc: '',
      selected: false,
      cases,
      isInIteration: false,
      isInLoop: false,
    }, BRANCH_HEIGHT)
  }

  private buildCondition(branchId: string, caseId: string, index: number, comparison: ParsedComparison) {
    let selector: string[]
    let variableType: string
    if (comparison.key) {
      const sourceId = this.singleVariableSource(comparison.variable)
      selector = [sourceId, 'structured_output', comparison.key]
      variableType = this.structuredFields.get(sourceId)?.[comparison.key] ?? 'string'
    }
    else {
      const sources = this.variables[comparison.variable] ?? []
      if (!sources.length) {
        [selector, variableType] = this.variableOutput(comparison.variable)
      }
      else if (sources.length === 1) {
        [selector, variableType] = this.sourceOutput(sources[0]!)
      }
      else {
        throw new AgentNetworkCompileError(`Condition variable ${comparison.variable} has multiple producers`)
      }
    }
    const value = conditionValue(comparison.operator, comparison.value)
    if (value === null)
      throw new AgentNetworkCompileError('Branch comparisons require a constant right-hand value')
    return {
      id: `${branchId}_${caseId}_${index}`,
      varType: difyVariableType(variableType),
      variable_selector: selector,
      comparison_operator: comparisonOperator(comparison.operator, variableType),
      value,
    }
  }

  private walkSequence(sequence: string[], incoming: Incoming[]): Incoming[] {
    let exits = incoming
    for (const objectId of sequence) {
      if (this.bindings.has(objectId))
        continue
      const terminal = this.terminals.get(objectId)
      if (terminal) {
        this.appendTerminalNodes(terminal, exits)
        exits = []
        continue
      }
      const step = this.steps.get(objectId)
      if (!step)
        throw new AgentNetworkCompileError(`Workflow body references unknown object ${objectId}`)
      this.visitedSteps.add(objectId)
      for (const edge of exits)
        this.appendEdge(edge.nodeId, objectId, edge.sourceHandle)
      exits = step.kind === 'call'
        ? [{ nodeId: objectId, sourceHandle: SOURCE_HANDLE }]
        : this.walkBranch(step)
    }
    return exits
  }

  private walkBranch(step: BranchStep): Incoming[] {
    const exits: Incoming[] = []
    for (const branchCase of step.cases) {
      const entry = [{ nodeId: step.id, sourceHandle: branchCase.caseId }]
      exits.push(...(branchCase.body.length ? this.walkSequence(branchCase.body, entry) : entry))
    }
    const elseEntry = [{ nodeId: step.id, sourceHandle: FALSE_HANDLE }]
    exits.push(...(step.elseCase.body.length ? this.walkSequence(step.elseCase.body, elseEntry) : elseEntry))
    return exits
  }

  private appendTerminalNodes(terminal: Terminal, incoming: Incoming[]) {
    for (const edge of incoming) {
      const [selector, valueType] = this.terminalOutput(terminal, edge.nodeId)
      const count = (this.terminalCounts.get(terminal.id) ?? 0) + 1
      this.terminalCounts.set(terminal.id, count)
      let nodeId = incoming.length === 1 ? terminal.id : `${terminal.id}_${edge.nodeId}`
      if (count > 1 && nodeId === terminal.id)
        nodeId = `${terminal.id}_${count}`
      this.appendNode(this.buildNode(nodeId, BlockEnum.End, {
        type: BlockEnum.End,
        title: 'End',
        desc: '',
        selected: false,
        outputs: [{
          variable: terminal.assignedName || 'result',
          value_selector: selector,
          value_type: difyVariableType(valueType),
        }],
      }))
      this.appendEdge(edge.nodeId, nodeId, edge.sourceHandle)
    }
  }

  private terminalOutput(terminal: Terminal, incomingSource: string): [string[], string] {
    if (terminal.outputStep) {
      if (terminal.outputStep !== incomingSource)
        throw new AgentNetworkCompileError(`Output ${terminal.id} does not match its control-flow source`, terminal.line)
      return this.sourceOutput(terminal.outputStep)
    }
    if (!terminal.output || terminal.output.refs.length !== 1)
      throw new AgentNetworkCompileError('Workflow outputs must reference exactly one variable', terminal.line)
    const variable = terminal.output.refs[0]!
    const sources = this.variables[variable] ?? []
    if (sources.length <= 1)
      return this.variableOutput(variable)
    if (!sources.includes(incomingSource))
      throw new AgentNetworkCompileError(`Output variable ${variable} cannot be matched to ${incomingSource}`, terminal.line)
    return this.sourceOutput(incomingSource)
  }

  private renderCallPrompt(step: CallStep): string {
    const args = step.args.map(value => this.renderValue(value)).filter(Boolean)
    const kwargs = Object.entries(step.kwargs)
    if (!args.length && kwargs.length === 1 && kwargs[0]?.[0] === 'task')
      return this.renderValue(kwargs[0][1])
    return [...args, ...kwargs.map(([name, value]) => `${name}: ${this.renderValue(value)}`)].join('\n')
  }

  private renderValue(value: ParsedValue, resolving = new Set<string>()): string {
    if (value.expr === 'var') {
      const sources = this.variables[value.name] ?? []
      const binding = this.bindingsByTarget.get(value.name)
      if (!sources.length && !(value.name in this.inputTypes) && binding) {
        if (resolving.has(value.name))
          throw new AgentNetworkCompileError(`Variable binding cycle includes ${value.name}`)
        return this.renderValue(binding.value, new Set([...resolving, value.name]))
      }
      return selectorTemplate(this.variableOutput(value.name)[0])
    }
    if (value.expr === 'const')
      return value.value === null ? '' : typeof value.value === 'boolean' ? String(value.value) : `${value.value}`
    if (value.expr === 'raw')
      throw new AgentNetworkCompileError(`Unsupported expression ${value.raw}`)
    return value.parts.map((part) => {
      if ('text' in part)
        return part.text
      if ('var' in part) {
        return this.renderValue(
          { expr: 'var', name: part.var, raw: part.var, refs: [part.var] },
          resolving,
        )
      }
      throw new AgentNetworkCompileError(`Unsupported template expression ${part.rawExpression}`)
    }).join('')
  }

  private variableOutput(variable: string, resolving = new Set<string>()): [string[], string] {
    const sources = this.variables[variable] ?? []
    if (sources.length === 1)
      return this.sourceOutput(sources[0]!)
    if (sources.length > 1)
      throw new AgentNetworkCompileError(`Variable ${variable} has multiple producers outside an output join`)
    if (variable in this.inputTypes)
      return [[START_NODE_ID, variable], schemaTypeForInput(this.inputTypes[variable])]

    const binding = this.bindingsByTarget.get(variable)
    if (binding?.value.expr === 'var') {
      if (resolving.has(variable))
        throw new AgentNetworkCompileError(`Variable binding cycle includes ${variable}`)
      return this.variableOutput(binding.value.name, new Set([...resolving, variable]))
    }
    throw new AgentNetworkCompileError(`Variable ${variable} cannot be represented as a Dify value selector`)
  }

  private sourceOutput(sourceId: string): [string[], string] {
    const step = this.steps.get(sourceId)
    if (step?.kind !== 'call')
      throw new AgentNetworkCompileError(`Source ${sourceId} is not a Group call`)
    return this.structuredFields.has(sourceId)
      ? [[sourceId, 'structured_output'], 'object']
      : [[sourceId, 'text'], 'string']
  }

  private singleVariableSource(variable: string): string {
    const sources = this.variables[variable] ?? []
    if (sources.length !== 1)
      throw new AgentNetworkCompileError(`Variable ${variable} must have exactly one producer`)
    return sources[0]!
  }

  private buildNode(id: string, nodeType: BlockEnum, data: Record<string, unknown>, height = NODE_HEIGHT): Node {
    const position = { x: BASE_X, y: BASE_Y }
    return {
      id,
      type: 'custom',
      position,
      data: data as Node['data'],
      width: NODE_WIDTH,
      height,
      positionAbsolute: { ...position },
      sourcePosition: RIGHT_POSITION,
      targetPosition: LEFT_POSITION,
      selected: false,
    }
  }

  private appendNode(node: Node) {
    if (this.nodeTypes.has(node.id))
      throw new AgentNetworkCompileError(`Duplicate generated node ${node.id}`)
    this.nodeTypes.set(node.id, node.data.type)
    this.nodes.push(node)
  }

  private appendEdge(source: string, target: string, sourceHandle = SOURCE_HANDLE, targetHandle = TARGET_HANDLE) {
    if (!this.nodeTypes.has(source) || !this.nodeTypes.has(target))
      throw new AgentNetworkCompileError(`Edge references an unknown node: ${source} -> ${target}`)
    const key = `${source}\u0000${sourceHandle}\u0000${target}\u0000${targetHandle}`
    if (this.seenEdges.has(key))
      return
    this.seenEdges.add(key)
    this.edges.push({
      id: `${source}-${sourceHandle}-${target}-${targetHandle}`,
      source,
      target,
      type: 'custom',
      sourceHandle,
      targetHandle,
      data: {
        sourceType: this.nodeTypes.get(source)!,
        targetType: this.nodeTypes.get(target)!,
        isInIteration: false,
        isInLoop: false,
      },
      zIndex: 0,
    })
  }

  private fillEdgeTypes() {
    for (const edge of this.edges) {
      if (!edge.data)
        continue
      edge.data.sourceType = this.nodeTypes.get(edge.source)!
      edge.data.targetType = this.nodeTypes.get(edge.target)!
    }
  }

  private applyLayout() {
    const nodeIds = this.nodes.map(node => node.id)
    const successors = new Map(nodeIds.map(id => [id, [] as string[]]))
    const indegrees = new Map(nodeIds.map(id => [id, 0]))
    for (const edge of this.edges) {
      const targets = successors.get(edge.source)!
      if (!targets.includes(edge.target)) {
        targets.push(edge.target)
        indegrees.set(edge.target, (indegrees.get(edge.target) ?? 0) + 1)
      }
    }
    const depths = new Map([[START_NODE_ID, 0]])
    const queue = nodeIds.filter(id => indegrees.get(id) === 0)
    const visited: string[] = []
    while (queue.length) {
      const nodeId = queue.shift()!
      visited.push(nodeId)
      for (const target of successors.get(nodeId) ?? []) {
        depths.set(target, Math.max(depths.get(target) ?? 0, (depths.get(nodeId) ?? 0) + 1))
        indegrees.set(target, (indegrees.get(target) ?? 0) - 1)
        if (indegrees.get(target) === 0)
          queue.push(target)
      }
    }
    if (visited.length !== nodeIds.length)
      throw new AgentNetworkCompileError('Generated graph contains a cycle')
    const lanes = new Map<number, string[]>()
    for (const nodeId of nodeIds) {
      const depth = depths.get(nodeId) ?? 0
      lanes.set(depth, [...(lanes.get(depth) ?? []), nodeId])
    }
    const nodes = new Map(this.nodes.map(node => [node.id, node]))
    for (const [depth, ids] of lanes) {
      const center = (ids.length - 1) / 2
      ids.forEach((nodeId, lane) => {
        const position = { x: BASE_X + depth * HORIZONTAL_GAP, y: BASE_Y + (lane - center) * VERTICAL_GAP }
        const node = nodes.get(nodeId)!
        node.position = position
        node.positionAbsolute = { ...position }
      })
    }
  }
}

export function compileAgentNetworkPseudocode(
  source: string,
  options: AgentNetworkCompileOptions = {},
): AgentNetworkCompileResult {
  try {
    const statements = parseAgentNetworkPseudocode(source)
    const semantics = new SemanticCompiler(options).compile(statements)
    const graph = new DifyGraphCompiler(semantics, options).compile(semantics)
    return { graph, warnings: semantics.warnings }
  }
  catch (error) {
    if (error instanceof AgentNetworkCompileError)
      throw error
    if (error instanceof AgentNetworkSyntaxError)
      throw new AgentNetworkCompileError(error.message, null)
    throw error
  }
}

function validateModel(value: Record<string, unknown> | AgentNetworkModelConfig | null): AgentNetworkModelConfig {
  if (!value || typeof value.provider !== 'string' || !value.provider || typeof value.name !== 'string' || !value.name || typeof value.mode !== 'string' || !value.mode)
    throw new AgentNetworkCompileError('A Dify model with provider, name, and mode is required')
  if (value.completion_params !== undefined && !isRecord(value.completion_params))
    throw new AgentNetworkCompileError('Model completion_params must be an object')
  return {
    provider: value.provider,
    name: value.name,
    mode: value.mode,
    completion_params: value.completion_params ?? {},
  }
}

function comparisonOperator(operator: string, variableType: string): string {
  if (operator === 'truthy')
    return 'not empty'
  if (operator === 'falsy')
    return 'empty'
  if (variableType === 'number') {
    const numeric: Record<string, string> = { '==': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤' }
    if (numeric[operator])
      return numeric[operator]
  }
  const operators: Record<string, string> = {
    '==': 'is',
    '!=': 'is not',
    'in': 'in',
    'not in': 'not in',
    'is': 'is',
    'is not': 'is not',
  }
  if (!operators[operator])
    throw new AgentNetworkCompileError(`Operator ${operator} is unsupported for ${variableType}`)
  return operators[operator]
}
