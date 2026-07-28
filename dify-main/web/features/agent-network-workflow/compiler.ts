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
import { ITERATION_CHILDREN_Z_INDEX, LOOP_CHILDREN_Z_INDEX } from '@/app/components/workflow/constants'
import { CUSTOM_ITERATION_START_NODE } from '@/app/components/workflow/nodes/iteration-start/constants'
import { CUSTOM_LOOP_START_NODE } from '@/app/components/workflow/nodes/loop-start/constants'
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

type IterationStep = {
  id: string
  kind: 'iteration'
  iterator: ParsedValue
  indexName: string | null
  itemName: string
  body: string[]
  outputVariable: string
  output: ParsedValue
  outputSource: string
  outputKey: string | null
  line: number
}

type LoopStep = {
  id: string
  kind: 'loop'
  count: number
  indexName: string
  body: string[]
  loopVariables: Array<{ name: string, value: ParsedValue }>
  breakCondition: ParsedCondition | null
  source: 'range' | 'while'
  line: number
}

type SemanticStep = CallStep | BranchStep | IterationStep | LoopStep

type LocalSelector = { nodeId: string, key: string, type: string }

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
  localSelectors: Record<string, LocalSelector>
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
  private readonly localSelectors: Record<string, LocalSelector> = {}
  private readonly everAssigned = new Set<string>()
  private readonly idCounts = new Map<string, number>()
  private branchCount = 0
  private terminalCount = 0
  private bindingCount = 0
  private containerCount = 0

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
      localSelectors: this.localSelectors,
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
      if (statement.kind === 'for') {
        ids.push(this.addFor(statement))
        continue
      }
      if (statement.kind === 'while') {
        ids.push(this.addWhile(statement))
        continue
      }
      if (statement.kind === 'append')
        throw new AgentNetworkCompileError('list.append is only supported as the final statement of an Iteration', statement.line)
      if (statement.kind === 'break')
        throw new AgentNetworkCompileError('break is only supported as the final conditional in a Loop', statement.line)
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

  private addFor(statement: Extract<ParsedStatement, { kind: 'for' }>): string {
    return statement.iterator.functionName === 'enumerate'
      ? this.addIteration(statement)
      : this.addRangeLoop(statement)
  }

  private addIteration(statement: Extract<ParsedStatement, { kind: 'for' }>): string {
    if (statement.targets.length !== 2 || statement.iterator.args.length !== 1 || Object.keys(statement.iterator.kwargs).length)
      throw new AgentNetworkCompileError('Iteration requires: for index, item in enumerate(iterator)', statement.line)
    const append = statement.body.at(-1)
    if (append?.kind !== 'append')
      throw new AgentNetworkCompileError('Iteration body must finish by appending its output', statement.line)
    const initializer = [...this.bindings].reverse().find(binding => binding.target === append.target)
    if (initializer?.value.expr !== 'list' || initializer.value.items.length)
      throw new AgentNetworkCompileError(`Iteration output ${append.target} must be initialized to []`, statement.line)

    const iterator = statement.iterator.args[0]!
    this.registerValue(iterator, statement.line)
    const id = `iteration_${++this.containerCount}`
    const step: IterationStep = {
      id,
      kind: 'iteration',
      iterator,
      indexName: statement.targets[0]!,
      itemName: statement.targets[1]!,
      body: [],
      outputVariable: append.target,
      output: append.value,
      outputSource: '',
      outputKey: null,
      line: statement.line,
    }
    this.steps.push(step)
    const assignedSnapshot = new Set(this.assigned)
    const producerSnapshot = cloneProducerMap(this.producers)
    this.assigned.add(step.indexName!)
    this.assigned.add(step.itemName)
    this.localSelectors[step.indexName!] = { nodeId: id, key: 'index', type: 'number' }
    this.localSelectors[step.itemName] = { nodeId: id, key: 'item', type: 'string' }
    step.body = this.walk(statement.body.slice(0, -1), false)
    this.registerValue(step.output, append.line)
    const outputName = step.output.expr === 'access' ? step.output.variable : step.output.expr === 'var' ? step.output.name : null
    const outputSources = outputName ? this.producers[outputName] ?? [] : []
    if (outputSources.length !== 1)
      throw new AgentNetworkCompileError('Iteration append output must come from exactly one node call', append.line)
    step.outputSource = outputSources[0]!
    step.outputKey = step.output.expr === 'access' ? step.output.key : null
    this.assigned = assignedSnapshot
    this.producers = producerSnapshot
    this.producers[step.outputVariable] = [id]
    this.assigned.add(step.outputVariable)
    this.everAssigned.add(step.outputVariable)
    return id
  }

  private addRangeLoop(statement: Extract<ParsedStatement, { kind: 'for' }>): string {
    if (statement.targets.length !== 1 || statement.iterator.args.length !== 1 || Object.keys(statement.iterator.kwargs).length)
      throw new AgentNetworkCompileError('Loop requires: for index in range(count)', statement.line)
    const count = statement.iterator.args[0]
    if (count?.expr !== 'const' || typeof count.value !== 'number' || !Number.isInteger(count.value) || count.value < 1)
      throw new AgentNetworkCompileError('Loop range count must be a positive integer', statement.line)
    const { body, breakCondition } = this.extractBreak(statement.body)
    return this.addLoop({ count: count.value, indexName: statement.targets[0]!, body, breakCondition, source: 'range', line: statement.line })
  }

  private addWhile(statement: Extract<ParsedStatement, { kind: 'while' }>): string {
    const terminalBreak = statement.body.at(-1)?.kind === 'break'
    const count = terminalBreak ? 1 : 100
    this.warnings.push(terminalBreak
      ? `Line ${statement.line}: while with terminal break was mapped to a one-iteration Dify Loop`
      : `Line ${statement.line}: while was mapped to a Dify Loop with a safety limit of 100 iterations`)
    return this.addLoop({
      count,
      indexName: `while_index_${this.containerCount + 1}`,
      body: terminalBreak ? statement.body.slice(0, -1) : statement.body,
      breakCondition: statement.condition,
      source: 'while',
      line: statement.line,
    })
  }

  private addLoop(config: {
    count: number
    indexName: string
    body: ParsedStatement[]
    breakCondition: ParsedCondition | null
    source: 'range' | 'while'
    line: number
  }): string {
    const id = `loop_${++this.containerCount}`
    const refs = new Set([...this.statementReferences(config.body), ...(config.breakCondition?.refs ?? [])])
    const loopVariables = [...refs].flatMap((name) => {
      const binding = [...this.bindings].reverse().find(candidate => candidate.target === name)
      return binding && binding.value.expr !== 'raw' ? [{ name, value: binding.value }] : []
    })
    const step: LoopStep = {
      id,
      kind: 'loop',
      count: config.count,
      indexName: config.indexName,
      body: [],
      loopVariables,
      breakCondition: config.breakCondition,
      source: config.source,
      line: config.line,
    }
    this.steps.push(step)
    const assignedSnapshot = new Set(this.assigned)
    const producerSnapshot = cloneProducerMap(this.producers)
    this.assigned.add(step.indexName)
    this.localSelectors[step.indexName] = { nodeId: id, key: 'index', type: 'number' }
    for (const variable of loopVariables)
      this.localSelectors[variable.name] = { nodeId: id, key: variable.name, type: parsedValueType(variable.value) }
    step.body = this.walk(config.body, false)
    if (config.breakCondition)
      this.registerCondition(config.breakCondition, config.line)
    this.assigned = assignedSnapshot
    this.producers = producerSnapshot
    for (const variable of loopVariables) {
      this.producers[variable.name] = [id]
      this.assigned.add(variable.name)
    }
    return id
  }

  private extractBreak(body: ParsedStatement[]): { body: ParsedStatement[], breakCondition: ParsedCondition | null } {
    const last = body.at(-1)
    if (
      last?.kind !== 'if'
      || last.cases.length !== 1
      || last.elseBody.length
      || last.cases[0]?.body.length !== 1
      || last.cases[0].body[0]?.kind !== 'break'
    ) {
      return { body, breakCondition: null }
    }
    return { body: body.slice(0, -1), breakCondition: last.cases[0].condition }
  }

  private statementReferences(statements: ParsedStatement[]): string[] {
    const refs = new Set<string>()
    const visit = (statement: ParsedStatement) => {
      if (statement.kind === 'assign-call' || statement.kind === 'call') {
        [...statement.call.args, ...Object.values(statement.call.kwargs)].forEach(value => value.refs.forEach(ref => refs.add(ref)))
      }
      else if (statement.kind === 'assign' || statement.kind === 'append') {
        statement.value.refs.forEach(ref => refs.add(ref))
      }
      else if (statement.kind === 'if') {
        statement.cases.forEach((item) => {
          item.condition.refs.forEach(ref => refs.add(ref))
          item.body.forEach(visit)
        })
        statement.elseBody.forEach(visit)
      }
    }
    statements.forEach(visit)
    return [...refs]
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
      statement.value.refs.map(name => [
        name,
        [...(this.producers[name] ?? (this.localSelectors[name] ? [this.localSelectors[name].nodeId] : []))],
      ]),
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
      if (this.assigned.has(name) || this.localSelectors[name])
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
  private readonly localSelectors: Record<string, LocalSelector>
  private readonly structuredFields = new Map<string, Record<string, 'string' | 'number' | 'boolean'>>()
  private readonly nodes: Node[] = []
  private readonly edges: Edge[] = []
  private readonly nodeTypes = new Map<string, BlockEnum>()
  private readonly parentByNode = new Map<string, string>()
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
    this.localSelectors = semantics.localSelectors
    this.inputTypes = Object.fromEntries(semantics.inputs.map(input => [input.name, input.type]))
  }

  compile(semantics: FlowSemantics): WorkflowDataUpdater {
    this.inferStructuredOutputs()
    this.appendNode(this.buildStartNode(semantics.inputs))
    for (const step of this.steps.values()) {
      if (step.kind === 'call') {
        this.appendNode(this.buildCallNode(step))
      }
      else if (step.kind === 'branch') {
        this.appendNode(this.buildBranchNode(step))
      }
      else if (step.kind === 'iteration') {
        this.appendNode(this.buildIterationNode(step))
        this.appendNode(this.buildContainerStartNode(step.id, BlockEnum.IterationStart))
      }
      else {
        this.appendNode(this.buildLoopNode(step))
        this.appendNode(this.buildContainerStartNode(step.id, BlockEnum.LoopStart))
      }
    }
    this.attachContainerChildren()
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
          const access = this.comparisonAccess(comparison)
          if (!access)
            continue
          const sourceId = this.singleVariableSource(access.variable)
          const sourceStep = this.steps.get(sourceId)
          if (sourceStep?.kind !== 'call')
            throw new AgentNetworkCompileError(`${access.variable}.${access.key} must come from a Group call`)
          const fieldType = schemaTypeForComparison(comparison)
          const fields = this.structuredFields.get(sourceId) ?? {}
          if (fields[access.key] && fields[access.key] !== fieldType)
            throw new AgentNetworkCompileError(`${access.variable}.${access.key} is compared with incompatible types`)
          fields[access.key] = fieldType
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
    if (step.functionName === 'CodeExecution')
      return this.buildCodeNode(step)

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
      agent_network_variable: step.assignTo ?? undefined,
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

  private buildCodeNode(step: CallStep): Node {
    const inputs = this.requireDictArgument(step, 'inputs')
    const outputs = this.requireDictArgument(step, 'outputs')
    const language = this.requireStringArgument(step, 'language')
    const code = this.requireStringArgument(step, 'code')
    const variables = Object.entries(inputs.entries).map(([variable, value]) => ({
      variable,
      value_selector: this.valueOutput(value)[0],
    }))
    const outputSchema = Object.fromEntries(Object.entries(outputs.entries).map(([name, value]) => {
      if (value.expr !== 'dict')
        throw new AgentNetworkCompileError(`CodeExecution output ${name} must be an object`, step.line)
      const type = value.entries.type
      if (type?.expr !== 'const' || typeof type.value !== 'string')
        throw new AgentNetworkCompileError(`CodeExecution output ${name} requires a string type`, step.line)
      return [name, { type: type.value, children: null }]
    }))
    const config = step.kwargs.config ? this.literalValue(step.kwargs.config, step.line) : {}
    if (!isRecord(config))
      throw new AgentNetworkCompileError('CodeExecution config must be an object', step.line)
    return this.buildNode(step.id, BlockEnum.Code, {
      ...config,
      type: BlockEnum.Code,
      title: 'Code',
      agent_network_variable: step.assignTo ?? undefined,
      desc: '',
      selected: false,
      variables,
      code_language: language,
      code,
      outputs: outputSchema,
    })
  }

  private requireDictArgument(step: CallStep, name: string): Extract<ParsedValue, { expr: 'dict' }> {
    const value = step.kwargs[name]
    if (value?.expr !== 'dict')
      throw new AgentNetworkCompileError(`${step.functionName} requires ${name}={...}`, step.line)
    return value
  }

  private requireStringArgument(step: CallStep, name: string): string {
    const value = step.kwargs[name]
    if (value?.expr !== 'const' || typeof value.value !== 'string')
      throw new AgentNetworkCompileError(`${step.functionName} requires a string ${name}`, step.line)
    return value.value
  }

  private buildIterationNode(step: IterationStep): Node {
    const [iteratorSelector] = this.valueOutput(step.iterator)
    const [outputSelector, outputType] = this.sourceOutput(step.outputSource, step.outputKey ?? undefined)
    return this.buildNode(step.id, BlockEnum.Iteration, {
      type: BlockEnum.Iteration,
      title: 'Iteration',
      desc: '',
      selected: false,
      iterator_selector: iteratorSelector,
      iterator_input_type: 'array[string]',
      output_selector: outputSelector,
      output_type: `array[${outputType}]`,
      start_node_id: `${step.id}_start`,
      is_parallel: false,
      parallel_nums: 1,
      error_handle_mode: 'terminated',
      flatten_output: false,
      _isShowTips: false,
      _children: [],
    }, 320)
  }

  private buildLoopNode(step: LoopStep): Node {
    const condition = step.breakCondition
      ? (step.source === 'while' ? invertCondition(step.breakCondition) : step.breakCondition)
      : null
    const breakConditions = condition?.comparisons.map((comparison, index) => (
      this.buildCondition(step.id, 'break', index, comparison)
    )) ?? []
    return this.buildNode(step.id, BlockEnum.Loop, {
      type: BlockEnum.Loop,
      title: 'Loop',
      desc: '',
      selected: false,
      start_node_id: `${step.id}_start`,
      loop_count: step.count,
      loop_variables: step.loopVariables.map(variable => ({
        id: variable.name,
        label: variable.name,
        var_type: difyVariableType(parsedValueType(variable.value)),
        value_type: 'constant',
        value: this.literalValue(variable.value, step.line),
      })),
      logical_operator: condition?.logical ?? 'and',
      break_conditions: breakConditions,
      error_handle_mode: 'terminated',
      _children: [],
    }, 320)
  }

  private buildContainerStartNode(parentId: string, type: BlockEnum.IterationStart | BlockEnum.LoopStart): Node {
    const node = this.buildNode(`${parentId}_start`, type, {
      type,
      title: '',
      desc: '',
      selected: false,
      ...(type === BlockEnum.IterationStart ? { isInIteration: true } : { isInLoop: true }),
    })
    node.parentId = parentId
    node.type = type === BlockEnum.IterationStart
      ? CUSTOM_ITERATION_START_NODE
      : CUSTOM_LOOP_START_NODE
    node.zIndex = type === BlockEnum.IterationStart
      ? ITERATION_CHILDREN_Z_INDEX
      : LOOP_CHILDREN_Z_INDEX
    node.position = { x: 24, y: 68 }
    node.positionAbsolute = { x: 24, y: 68 }
    node.selectable = false
    node.draggable = false
    this.parentByNode.set(node.id, parentId)
    return node
  }

  private attachContainerChildren() {
    for (const step of this.steps.values()) {
      if (step.kind !== 'iteration' && step.kind !== 'loop')
        continue
      this.attachSequence(step.body, step.id, step.kind)
      const parent = this.nodes.find(node => node.id === step.id)
      if (!parent)
        continue
      const children = this.nodes.filter(node => node.parentId === step.id)
      ;(parent.data as Record<string, unknown>)._children = children.map(node => ({
        nodeId: node.id,
        nodeType: node.data.type,
      }))
    }
  }

  private attachSequence(sequence: string[], parentId: string, kind: 'iteration' | 'loop') {
    for (const id of sequence) {
      const step = this.steps.get(id)
      if (!step)
        continue
      const node = this.nodes.find(candidate => candidate.id === id)
      if (node) {
        node.parentId = parentId
        node.position = { x: 320 + this.parentByNode.size * 280, y: 90 }
        node.positionAbsolute = { ...node.position }
        node.data = {
          ...node.data,
          ...(kind === 'iteration'
            ? { isInIteration: true, iteration_id: parentId }
            : { isInLoop: true, loop_id: parentId }),
        }
        this.parentByNode.set(id, parentId)
      }
      if (step.kind === 'branch') {
        step.cases.forEach(branchCase => this.attachSequence(branchCase.body, parentId, kind))
        this.attachSequence(step.elseCase.body, parentId, kind)
      }
    }
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
    const access = this.comparisonAccess(comparison)
    if (access) {
      const sourceId = this.singleVariableSource(access.variable)
      selector = [sourceId, 'structured_output', access.key]
      variableType = this.structuredFields.get(sourceId)?.[access.key] ?? 'string'
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

  private comparisonAccess(comparison: ParsedComparison): { variable: string, key: string } | null {
    if (comparison.key)
      return { variable: comparison.variable, key: comparison.key }
    const binding = this.bindingsByTarget.get(comparison.variable)
    return binding?.value.expr === 'access'
      ? { variable: binding.value.variable, key: binding.value.key }
      : null
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
      if (step.kind === 'call') {
        exits = [{ nodeId: objectId, sourceHandle: SOURCE_HANDLE }]
      }
      else if (step.kind === 'branch') {
        exits = this.walkBranch(step)
      }
      else {
        const startId = `${step.id}_start`
        if (step.body.length)
          this.walkSequence(step.body, [{ nodeId: startId, sourceHandle: SOURCE_HANDLE }])
        this.visitedSteps.add(startId)
        exits = [{ nodeId: objectId, sourceHandle: SOURCE_HANDLE }]
      }
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
      const count = (this.terminalCounts.get(terminal.id) ?? 0) + 1
      this.terminalCounts.set(terminal.id, count)
      let nodeId = incoming.length === 1 ? terminal.id : `${terminal.id}_${edge.nodeId}`
      if (count > 1 && nodeId === terminal.id)
        nodeId = `${terminal.id}_${count}`
      if (terminal.via === 'reply') {
        this.appendNode(this.buildNode(nodeId, BlockEnum.Answer, {
          type: BlockEnum.Answer,
          title: 'Answer',
          desc: '',
          selected: false,
          answer: this.renderValue(terminal.output!),
        }))
        this.appendEdge(edge.nodeId, nodeId, edge.sourceHandle)
        continue
      }
      const [selector, valueType] = this.terminalOutput(terminal, edge.nodeId)
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
    if (terminal.output?.expr === 'access')
      return this.valueOutput(terminal.output)
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
    if (value.expr === 'access')
      return selectorTemplate(this.valueOutput(value)[0])
    if (value.expr === 'list' || value.expr === 'dict')
      return JSON.stringify(this.literalValue(value, null))
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

  private valueOutput(value: ParsedValue): [string[], string] {
    if (value.expr === 'var')
      return this.variableOutput(value.name)
    if (value.expr === 'access') {
      const sources = this.variables[value.variable] ?? []
      if (sources.length !== 1)
        throw new AgentNetworkCompileError(`Variable ${value.variable} must have exactly one producer`)
      return this.sourceOutput(sources[0]!, value.key)
    }
    throw new AgentNetworkCompileError(`Expression ${value.raw} cannot be represented as a Dify selector`)
  }

  private variableOutput(variable: string, resolving = new Set<string>()): [string[], string] {
    const sources = this.variables[variable] ?? []
    if (sources.length === 1)
      return this.sourceOutput(sources[0]!)
    if (sources.length > 1)
      throw new AgentNetworkCompileError(`Variable ${variable} has multiple producers outside an output join`)
    const local = this.localSelectors[variable]
    if (local)
      return [[local.nodeId, local.key], local.type]
    if (variable in this.inputTypes)
      return [[START_NODE_ID, variable], schemaTypeForInput(this.inputTypes[variable])]

    const binding = this.bindingsByTarget.get(variable)
    if (binding?.value.expr === 'var') {
      if (resolving.has(variable))
        throw new AgentNetworkCompileError(`Variable binding cycle includes ${variable}`)
      return this.variableOutput(binding.value.name, new Set([...resolving, variable]))
    }
    if (binding?.value.expr === 'access')
      return this.valueOutput(binding.value)
    throw new AgentNetworkCompileError(`Variable ${variable} cannot be represented as a Dify value selector`)
  }

  private sourceOutput(sourceId: string, key?: string): [string[], string] {
    const step = this.steps.get(sourceId)
    if (step?.kind === 'iteration')
      return [[sourceId, key ?? 'output'], 'array[string]']
    if (step?.kind === 'loop') {
      const outputKey = key ?? step.loopVariables[0]?.name ?? 'index'
      const variable = step.loopVariables.find(item => item.name === outputKey)
      return [[sourceId, outputKey], variable ? parsedValueType(variable.value) : 'number']
    }
    if (step?.kind !== 'call')
      throw new AgentNetworkCompileError(`Source ${sourceId} is not a workflow call`)
    if (step.functionName === 'CodeExecution') {
      const outputs = this.requireDictArgument(step, 'outputs')
      const outputName = key ?? Object.keys(outputs.entries)[0]
      if (!outputName || !outputs.entries[outputName])
        throw new AgentNetworkCompileError(`CodeExecution ${sourceId} has no output ${key ?? ''}`.trim())
      const output = outputs.entries[outputName]
      const typeValue = output.expr === 'dict' ? output.entries.type : null
      const type = typeValue?.expr === 'const' && typeof typeValue.value === 'string' ? typeValue.value : 'string'
      return [[sourceId, outputName], type]
    }
    if (!step.functionName.endsWith('Group'))
      throw new AgentNetworkCompileError(`Source ${sourceId} is unsupported`)
    if (key) {
      return this.structuredFields.has(sourceId)
        ? [[sourceId, 'structured_output', key], this.structuredFields.get(sourceId)?.[key] ?? 'string']
        : [[sourceId, 'text'], 'string']
    }
    return this.structuredFields.has(sourceId)
      ? [[sourceId, 'structured_output'], 'object']
      : [[sourceId, 'text'], 'string']
  }

  private literalValue(value: ParsedValue, line: number | null): unknown {
    if (value.expr === 'const')
      return value.value
    if (value.expr === 'list')
      return value.items.map(item => this.literalValue(item, line))
    if (value.expr === 'dict')
      return Object.fromEntries(Object.entries(value.entries).map(([key, item]) => [key, this.literalValue(item, line)]))
    throw new AgentNetworkCompileError(`Expected a literal value, received ${value.raw}`, line)
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
    const parentId = this.parentByNode.get(source)
    const sameContainer = parentId && parentId === this.parentByNode.get(target)
    const container = sameContainer ? this.steps.get(parentId) : null
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
        isInIteration: container?.kind === 'iteration',
        isInLoop: container?.kind === 'loop',
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
    const nodeIds = this.nodes.filter(node => !node.parentId).map(node => node.id)
    const successors = new Map(nodeIds.map(id => [id, [] as string[]]))
    const indegrees = new Map(nodeIds.map(id => [id, 0]))
    for (const edge of this.edges) {
      if (!successors.has(edge.source) || !successors.has(edge.target))
        continue
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
    for (const parent of this.nodes.filter(node => node.data.type === BlockEnum.Iteration || node.data.type === BlockEnum.Loop)) {
      const children = this.nodes.filter(node => node.parentId === parent.id)
      children.forEach((child, index) => {
        const position = { x: 24 + index * 280, y: 86 }
        child.position = position
        child.positionAbsolute = {
          x: parent.position.x + position.x,
          y: parent.position.y + position.y,
        }
      })
      parent.width = Math.max(560, 80 + children.length * 280)
      parent.height = 300
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

function parsedValueType(value: ParsedValue): string {
  if (value.expr === 'const') {
    if (value.valueType === 'int' || value.valueType === 'float')
      return 'number'
    if (value.valueType === 'bool')
      return 'boolean'
    return 'string'
  }
  if (value.expr === 'list')
    return 'array[string]'
  if (value.expr === 'dict')
    return 'object'
  return 'string'
}

function invertCondition(condition: ParsedCondition): ParsedCondition {
  const inverse: Record<string, string> = {
    '==': '!=',
    '!=': '==',
    '>': '<=',
    '>=': '<',
    '<': '>=',
    '<=': '>',
    'in': 'not in',
    'not in': 'in',
    'is': 'is not',
    'is not': 'is',
    'truthy': 'falsy',
    'falsy': 'truthy',
  }
  return {
    ...condition,
    logical: condition.logical === 'and' ? 'or' : condition.logical === 'or' ? 'and' : null,
    comparisons: condition.comparisons.map(comparison => ({
      ...comparison,
      operator: inverse[comparison.operator] ?? comparison.operator,
    })),
  }
}
