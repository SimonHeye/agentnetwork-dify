import type {
  AgentNetworkReverseDiagnostic,
  AgentNetworkReverseOptions,
  AgentNetworkReverseResult,
  AgentNetworkReverseStats,
} from './types'
import type { Edge, Node, WorkflowDataUpdater } from '@/app/components/workflow/types'
import { isAgentV2NodeData } from '@/app/components/workflow/nodes/agent-v2/types'
import { BlockEnum } from '@/app/components/workflow/types'
import { isAgentNetworkGroup } from './groups'

type JsonRecord = Record<string, unknown>

type BranchCase = {
  caseId: string
  conditions: JsonRecord[]
  logicalOperator: 'and' | 'or'
}

type BranchEntry = {
  condition: string
  target: string
}

type EmitBranchResult = {
  terminated: boolean
  joinId: string | null
}

export const AGENT_NETWORK_PSEUDOCODE_NODE_SUPPORT = {
  entry: [
    BlockEnum.Start,
    BlockEnum.TriggerSchedule,
    BlockEnum.TriggerWebhook,
    BlockEnum.TriggerPlugin,
    BlockEnum.DataSource,
  ],
  callable: [
    BlockEnum.LLM,
    BlockEnum.KnowledgeRetrieval,
    BlockEnum.Code,
    BlockEnum.TemplateTransform,
    BlockEnum.HttpRequest,
    BlockEnum.VariableAssigner,
    BlockEnum.VariableAggregator,
    BlockEnum.Tool,
    BlockEnum.ParameterExtractor,
    BlockEnum.DocExtractor,
    BlockEnum.ListFilter,
    BlockEnum.Agent,
    BlockEnum.AgentV2,
  ],
  control: [
    BlockEnum.QuestionClassifier,
    BlockEnum.IfElse,
    BlockEnum.HumanInput,
    BlockEnum.Iteration,
    BlockEnum.Loop,
  ],
  mutation: [
    BlockEnum.Assigner,
  ],
  terminal: [
    BlockEnum.End,
    BlockEnum.Answer,
    BlockEnum.KnowledgeBase,
  ],
  internal: [
    BlockEnum.StartPlaceholder,
    BlockEnum.DataSourceEmpty,
    BlockEnum.IterationStart,
    BlockEnum.LoopStart,
    BlockEnum.LoopEnd,
  ],
} as const

const ENTRY_NODE_TYPES = new Set<BlockEnum>(AGENT_NETWORK_PSEUDOCODE_NODE_SUPPORT.entry)

const INTERNAL_NODE_TYPES = new Set<BlockEnum>(
  AGENT_NETWORK_PSEUDOCODE_NODE_SUPPORT.internal.filter(type => type !== BlockEnum.LoopEnd),
)

const VALUE_NODE_TYPES = new Set<BlockEnum>([
  BlockEnum.LLM,
  BlockEnum.KnowledgeRetrieval,
  BlockEnum.QuestionClassifier,
  BlockEnum.Code,
  BlockEnum.TemplateTransform,
  BlockEnum.HttpRequest,
  BlockEnum.VariableAssigner,
  BlockEnum.VariableAggregator,
  BlockEnum.Tool,
  BlockEnum.ParameterExtractor,
  BlockEnum.Iteration,
  BlockEnum.DocExtractor,
  BlockEnum.ListFilter,
  BlockEnum.Agent,
  BlockEnum.AgentV2,
  BlockEnum.Loop,
  BlockEnum.HumanInput,
  BlockEnum.DataSource,
  BlockEnum.TriggerSchedule,
  BlockEnum.TriggerWebhook,
  BlockEnum.TriggerPlugin,
])

const GENERIC_CALL_NAMES = new Map<BlockEnum, string>([
  [BlockEnum.KnowledgeRetrieval, 'KnowledgeRetrieval'],
  [BlockEnum.Code, 'CodeExecution'],
  [BlockEnum.TemplateTransform, 'TemplateTransform'],
  [BlockEnum.HttpRequest, 'HTTPRequest'],
  [BlockEnum.VariableAssigner, 'VariableAggregator'],
  [BlockEnum.VariableAggregator, 'VariableAggregator'],
  [BlockEnum.Tool, 'Tool'],
  [BlockEnum.ParameterExtractor, 'ParameterExtractor'],
  [BlockEnum.DocExtractor, 'DocumentExtractor'],
  [BlockEnum.ListFilter, 'ListOperator'],
  [BlockEnum.Agent, 'Agent'],
  [BlockEnum.AgentV2, 'AgentV2'],
  [BlockEnum.DataSource, 'DataSource'],
])

const GENERIC_CONSUMED_KEYS = new Map<BlockEnum, readonly string[]>([
  [BlockEnum.KnowledgeRetrieval, ['query_variable_selector', 'dataset_ids', 'retrieval_mode']],
  [BlockEnum.Code, ['variables', 'code_language', 'code', 'outputs']],
  [BlockEnum.TemplateTransform, ['template', 'variables']],
  [BlockEnum.HttpRequest, [
    'method',
    'url',
    'headers',
    'params',
    'body',
    'authorization',
    'timeout',
    'ssl_verify',
  ]],
  [BlockEnum.VariableAssigner, ['variables', 'advanced_settings']],
  [BlockEnum.VariableAggregator, ['variables', 'advanced_settings']],
  [BlockEnum.Tool, [
    'provider_id',
    'tool_name',
    'tool_parameters',
    'tool_configurations',
    'plugin_unique_identifier',
    'plugin_id',
  ]],
  [BlockEnum.ParameterExtractor, [
    'query',
    'parameters',
    'reasoning_mode',
    'instruction',
    'model',
  ]],
  [BlockEnum.DocExtractor, ['variable_selector', 'is_array_file']],
  [BlockEnum.ListFilter, ['variable', 'filter_by', 'extract_by', 'order_by', 'limit']],
  [BlockEnum.Agent, [
    'agent_strategy_provider_name',
    'agent_strategy_name',
    'agent_parameters',
    'output_schema',
    'plugin_unique_identifier',
  ]],
  [BlockEnum.AgentV2, [
    'agent_task',
    'agent_binding',
    'agent_declared_outputs',
    'agent_node_kind',
    'version',
  ]],
  [BlockEnum.DataSource, [
    'provider_name',
    'provider_id',
    'datasource_name',
    'datasource_parameters',
    'datasource_configurations',
    'plugin_unique_identifier',
    'plugin_id',
  ]],
])

const TRIGGER_CONSUMED_KEYS = new Map<BlockEnum, readonly string[]>([
  [BlockEnum.TriggerSchedule, [
    'mode',
    'frequency',
    'cron_expression',
    'visual_config',
    'timezone',
  ]],
  [BlockEnum.TriggerWebhook, [
    'method',
    'content_type',
    'headers',
    'params',
    'body',
    'async_mode',
    'status_code',
    'response_body',
  ]],
  [BlockEnum.TriggerPlugin, [
    'provider_id',
    'event_name',
    'event_parameters',
    'event_configurations',
    'plugin_unique_identifier',
    'plugin_id',
  ]],
])

const ERROR_BRANCH_NODE_TYPES = new Set<BlockEnum>([
  BlockEnum.LLM,
  BlockEnum.Tool,
  BlockEnum.HttpRequest,
  BlockEnum.Code,
  BlockEnum.Agent,
  BlockEnum.AgentV2,
])

const RETRY_NODE_TYPES = new Set<BlockEnum>([
  BlockEnum.LLM,
  BlockEnum.Tool,
  BlockEnum.HttpRequest,
  BlockEnum.Code,
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

const COMMON_CONFIG_KEYS = new Set([
  'title',
  'desc',
  'type',
  'width',
  'height',
  'position',
  'selected',
  'isInIteration',
  'iteration_id',
  'isInLoop',
  'loop_id',
  'agent_network_variable',
  'agent_network_synthetic_join',
  'agent_network_call_kwargs',
  'agent_network_call_kwarg_selectors',
  'agent_network_rendered_prompt',
  'agent_network_synthetic_expression',
])

class ReverseAbort extends Error {}

class GraphToPseudocodeCompiler {
  private readonly graph: WorkflowDataUpdater
  private readonly diagnostics: AgentNetworkReverseDiagnostic[] = []
  private readonly nodesById = new Map<string, Node>()
  private readonly outgoing = new Map<string, Edge[]>()
  private readonly incoming = new Map<string, Edge[]>()
  private readonly emitted = new Set<string>()
  private readonly variableNames = new Map<string, string>()
  private readonly functionNames = new Map<string, string>()
  private readonly entryVariables = new Set<string>()
  private readonly selectorAliases = new Map<string, Map<string, string>>()
  private entryId = ''

  constructor(graph: WorkflowDataUpdater) {
    this.graph = graph
  }

  compile(): Omit<AgentNetworkReverseResult, 'fileName'> {
    try {
      this.indexGraph()
      this.validateGraph()
      this.prepareNames()

      const body: string[] = []
      const entry = this.nodesById.get(this.entryId)!
      this.emitEntryDescription(entry, body)
      const terminated = this.emitSequence(this.entryId, 0, new Set(), body, new Set())
      if (!terminated)
        this.fail('MISSING_OUTPUT', 'Workflow does not reach End, Answer, or KnowledgeBase output')

      const reachable = this.collectReachableIncludingContainers(this.entryId)
      const unreachable = this.graph.nodes.filter(node =>
        !reachable.has(node.id)
        && !INTERNAL_NODE_TYPES.has(node.data.type),
      )
      if (unreachable.length) {
        this.fail(
          'UNREACHABLE_NODES',
          `Workflow contains unreachable nodes: ${unreachable.map(node => `${node.data.title} (${node.id})`).join(', ')}`,
        )
      }

      const header = [
        '# Generated from the current Dify workflow.graph.',
        '# AgentNetwork pseudocode schema: 2.0.',
        '# Namespace: vertex functions, workflow inputs, and final_result are provided by AgentNetwork.',
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
      return {
        source: null,
        diagnostics: this.diagnostics,
        stats: this.stats(),
      }
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

    const entries = this.graph.nodes.filter(node =>
      !node.parentId
      && ENTRY_NODE_TYPES.has(node.data.type)
      && (this.incoming.get(node.id)?.length ?? 0) === 0,
    )
    if (entries.length !== 1) {
      this.fail(
        'ENTRY_COUNT',
        `Expected exactly one workflow entry (User Input, trigger, or DataSource), found ${entries.length}`,
      )
    }
    this.entryId = entries[0]!.id

    const knownTypes = new Set<string>(Object.values(BlockEnum))
    for (const node of this.graph.nodes) {
      if (!knownTypes.has(node.data.type)) {
        this.fail(
          'UNSUPPORTED_NODE',
          `Node ${node.data.title} has unknown type ${node.data.type}`,
          node.id,
        )
      }
      if (node.id === this.entryId && (this.incoming.get(node.id)?.length ?? 0) > 0)
        this.fail('ENTRY_HAS_INPUT', 'Workflow entry cannot have incoming edges', node.id)
      if (
        (node.data.type === BlockEnum.End || node.data.type === BlockEnum.Answer || node.data.type === BlockEnum.KnowledgeBase)
        && (this.outgoing.get(node.id)?.length ?? 0) > 0
      ) {
        this.fail('TERMINAL_HAS_OUTPUT', `${node.data.type} cannot have outgoing edges`, node.id)
      }
    }

    this.assertAcyclic(this.entryId, new Set(), new Set())
  }

  private prepareNames() {
    const entry = this.nodesById.get(this.entryId)!
    if (entry.data.type === BlockEnum.Start) {
      for (const variable of this.readInputVariables(entry))
        this.entryVariables.add(variable)
    }

    const endHints = new Map<string, string[]>()
    for (const node of this.graph.nodes) {
      if (node.data.type !== BlockEnum.End)
        continue
      for (const outputValue of asArray(asRecord(node.data).outputs)) {
        const output = asRecord(outputValue)
        const selector = stringArray(output.value_selector)
        const name = output.variable === 'final_result' ? 'answer' : output.variable
        if (!selector.length || typeof name !== 'string' || !isPythonIdentifier(name))
          continue
        const names = endHints.get(selector[0]!) ?? []
        if (!names.includes(name))
          names.push(name)
        endHints.set(selector[0]!, names)
      }
    }

    const joinedVariablesByNode = new Map<string, Set<string>>()
    for (const joinNode of this.graph.nodes) {
      const joinData = asRecord(joinNode.data)
      const variable = joinData.agent_network_variable
      if (joinData.agent_network_synthetic_join !== true || typeof variable !== 'string')
        continue
      const sourceIds = asArray(joinData.variables)
        .map(item => stringArray(item)[0])
        .filter((sourceId): sourceId is string => Boolean(sourceId))
      for (const nodeId of [joinNode.id, ...sourceIds]) {
        const variables = joinedVariablesByNode.get(nodeId) ?? new Set<string>()
        variables.add(variable)
        joinedVariablesByNode.set(nodeId, variables)
      }
    }

    const usedVariables = new Set(this.entryVariables)
    usedVariables.add('final_result')
    usedVariables.add('error')

    for (const node of this.graph.nodes) {
      if (!VALUE_NODE_TYPES.has(node.data.type))
        continue

      const hints = endHints.get(node.id) ?? []
      const preservedVariable = asRecord(node.data).agent_network_variable
      let variable = typeof preservedVariable === 'string' && isPythonIdentifier(preservedVariable)
        ? preservedVariable
        : hints[0]
      if (hints.length > 1) {
        this.warn(
          'MULTIPLE_OUTPUT_NAMES',
          `Node output has multiple names (${hints.join(', ')}); using ${hints[0]}`,
          node.id,
        )
      }
      if (!variable) {
        variable = uniqueName(this.defaultVariableName(node), usedVariables)
        this.warn(
          'INFERRED_VARIABLE',
          `Graph does not retain the original assignment name for ${node.data.title}; generated ${variable}`,
          node.id,
        )
      }
      else if (usedVariables.has(variable) && !joinedVariablesByNode.get(node.id)?.has(variable)) {
        const original = variable
        variable = uniqueName(variable, usedVariables)
        this.warn(
          'DUPLICATE_VARIABLE',
          `Variable ${original} is already used outside a branch join; renamed this value to ${variable}`,
          node.id,
        )
      }
      this.variableNames.set(node.id, variable)
      usedVariables.add(variable)

      if (node.data.type === BlockEnum.LLM) {
        const configuredGroup = asRecord(node.data).agent_network_group
        if (isConfiguredAgentNetworkGroup(configuredGroup))
          this.functionNames.set(node.id, configuredGroup)
        else
          this.functionNames.set(node.id, 'LLM')
      }
      else if (node.data.type === BlockEnum.AgentV2 || isAgentV2NodeData(node.data)) {
        this.functionNames.set(node.id, 'AgentV2')
      }
      else {
        this.functionNames.set(node.id, GENERIC_CALL_NAMES.get(node.data.type) ?? '')
      }
    }
  }

  private emitEntryDescription(node: Node, lines: string[]) {
    const data = asRecord(node.data)
    if (node.data.type === BlockEnum.Start) {
      const variables = asArray(data.variables)
        .map(item => asRecord(item))
        .filter(item => typeof item.variable === 'string')
        .map(item => `${item.variable}: ${typeof item.type === 'string' ? item.type : 'any'}`)
      lines.push(`# Entry: UserInput(${variables.join(', ')})`)
      lines.push(`# Entry schema: ${pythonValue(data.variables)}`)
    }
    else if (node.data.type === BlockEnum.TriggerSchedule) {
      lines.push('# Entry: ScheduleTrigger')
    }
    else if (node.data.type === BlockEnum.TriggerWebhook) {
      lines.push('# Entry: WebhookTrigger')
    }
    else if (node.data.type === BlockEnum.TriggerPlugin) {
      lines.push('# Entry: PluginTrigger')
    }
    else if (node.data.type === BlockEnum.DataSource) {
      lines.push('# Entry: DataSource (knowledge pipeline)')
    }
    lines.push('')
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

      const failureEdge = this.failureEdge(node)
      if (failureEdge && ERROR_BRANCH_NODE_TYPES.has(node.data.type)) {
        const result = this.emitFailureBranch(node, indent, lines, activePath, failureEdge)
        activePath.delete(node.id)
        if (result.terminated)
          return true
        currentId = result.joinId
        continue
      }

      if (node.data.type === BlockEnum.Start) {
        currentId = this.singleSuccessor(node)
      }
      else if (
        node.data.type === BlockEnum.TriggerSchedule
        || node.data.type === BlockEnum.TriggerWebhook
        || node.data.type === BlockEnum.TriggerPlugin
      ) {
        this.emitTrigger(node, indent, lines)
        currentId = this.singleSuccessor(node)
      }
      else if (node.data.type === BlockEnum.IfElse) {
        const result = this.emitIfElse(node, indent, lines, activePath)
        activePath.delete(node.id)
        if (result.terminated)
          return true
        currentId = result.joinId
        continue
      }
      else if (node.data.type === BlockEnum.QuestionClassifier) {
        const result = this.emitQuestionClassifier(node, indent, lines, activePath)
        activePath.delete(node.id)
        if (result.terminated)
          return true
        currentId = result.joinId
        continue
      }
      else if (node.data.type === BlockEnum.HumanInput) {
        const result = this.emitHumanInput(node, indent, lines, activePath)
        activePath.delete(node.id)
        if (result.terminated)
          return true
        currentId = result.joinId
        continue
      }
      else if (node.data.type === BlockEnum.Iteration) {
        this.emitIteration(node, indent, lines)
        currentId = this.singleSuccessor(node)
      }
      else if (node.data.type === BlockEnum.Loop) {
        this.emitLoop(node, indent, lines)
        currentId = this.singleSuccessor(node)
      }
      else if (node.data.type === BlockEnum.LoopEnd) {
        lines.push(`${padding(indent)}break`)
        lines.push('')
        activePath.delete(node.id)
        return true
      }
      else if (node.data.type === BlockEnum.Assigner) {
        this.emitAssigner(node, indent, lines)
        currentId = this.singleSuccessor(node)
      }
      else if (node.data.type === BlockEnum.End) {
        this.emitEnd(node, indent, lines)
        activePath.delete(node.id)
        return true
      }
      else if (node.data.type === BlockEnum.Answer) {
        this.emitAnswer(node, indent, lines)
        currentId = this.singleSuccessor(node)
        if (!currentId) {
          activePath.delete(node.id)
          return true
        }
      }
      else if (node.data.type === BlockEnum.KnowledgeBase) {
        this.emitKnowledgeBase(node, indent, lines)
        activePath.delete(node.id)
        return true
      }
      else if (
        asRecord(node.data).agent_network_synthetic_join === true
        || typeof asRecord(node.data).agent_network_synthetic_expression === 'string'
      ) {
        currentId = this.singleSuccessor(node)
      }
      else if (INTERNAL_NODE_TYPES.has(node.data.type)) {
        if (node.data.type === BlockEnum.StartPlaceholder || node.data.type === BlockEnum.DataSourceEmpty) {
          this.warn(
            'IGNORED_PLACEHOLDER',
            `Internal placeholder ${node.data.type} was not emitted as executable pseudocode`,
            node.id,
          )
        }
        currentId = this.singleSuccessor(node)
      }
      else {
        this.emitValueNode(node, indent, lines)
        currentId = this.singleSuccessor(node)
      }
      activePath.delete(node.id)
    }
    return false
  }

  private emitTrigger(node: Node, indent: number, lines: string[]) {
    const data = asRecord(node.data)
    const variable = this.variableNames.get(node.id)!
    const args: [string, string][] = []

    if (node.data.type === BlockEnum.TriggerSchedule) {
      args.push(['mode', pythonValue(data.mode)])
      addDefinedArg(args, 'frequency', data.frequency)
      addDefinedArg(args, 'cron_expression', data.cron_expression)
      addDefinedArg(args, 'visual_config', data.visual_config)
      addDefinedArg(args, 'timezone', data.timezone)
    }
    else if (node.data.type === BlockEnum.TriggerWebhook) {
      args.push(['method', pythonValue(data.method)])
      args.push(['content_type', pythonValue(data.content_type)])
      args.push(['headers', pythonValue(data.headers)])
      args.push(['params', pythonValue(data.params)])
      args.push(['body', pythonValue(data.body)])
      args.push(['async_mode', pythonValue(data.async_mode)])
      args.push(['status_code', pythonValue(data.status_code)])
      args.push(['response_body', pythonValue(data.response_body)])
    }
    else {
      args.push(['provider', pythonValue(data.provider_id)])
      args.push(['event', pythonValue(data.event_name)])
      args.push(['parameters', this.renderResourceInputs(data.event_parameters, node.id)])
      args.push(['configurations', pythonValue(data.event_configurations)])
      addDefinedArg(args, 'plugin', data.plugin_unique_identifier ?? data.plugin_id)
    }

    const config = this.semanticConfig(
      node,
      new Set(TRIGGER_CONSUMED_KEYS.get(node.data.type) ?? []),
    )
    if (Object.keys(config).length)
      args.push(['config', pythonValue(config)])

    this.emitAssignedCall(
      variable,
      node.data.type === BlockEnum.TriggerSchedule
        ? 'ScheduleTrigger'
        : node.data.type === BlockEnum.TriggerWebhook
          ? 'WebhookTrigger'
          : 'PluginTrigger',
      args,
      indent,
      lines,
    )
  }

  private emitValueNode(node: Node, indent: number, lines: string[]) {
    if (node.data.type === BlockEnum.LLM) {
      this.emitLLM(node, indent, lines)
      return
    }

    const data = asRecord(node.data)
    const variable = this.variableNames.get(node.id)
    const callable = this.functionNames.get(node.id)
    if (!variable || !callable)
      this.fail('NODE_CONTRACT', `No pseudocode contract exists for ${node.data.type}`, node.id)

    if (data.skills !== undefined) {
      this.warn(
        'SKILLS_NOT_SUPPORTED',
        `Node type ${node.data.type} does not own data.skills; only LLM nodes export skills`,
        node.id,
      )
    }

    const args = this.valueNodeArguments(node)
    this.appendErrorAndRetryArguments(node, args)
    const contractType = isAgentV2NodeData(node.data) ? BlockEnum.AgentV2 : node.data.type
    const excluded = new Set([
      ...(GENERIC_CONSUMED_KEYS.get(contractType) ?? []),
      'skills',
      'error_strategy',
      'retry_config',
      'default_value',
    ])
    const config = this.semanticConfig(node, excluded)
    if (Object.keys(config).length)
      args.push(['config', pythonValue(config)])
    this.emitAssignedCall(variable, callable, args, indent, lines)
  }

  private emitLLM(node: Node, indent: number, lines: string[]) {
    const data = asRecord(node.data)
    const variable = this.variableNames.get(node.id)!
    const callable = this.functionNames.get(node.id) ?? 'LLM'
    const isGroup = isConfiguredAgentNetworkGroup(data.agent_network_group)
    const model = asRecord(data.model)
    const renderedPrompt = this.renderInterpolatedValue(data.prompt_template, node)
    const currentPromptText = this.promptText(data.prompt_template)
    const preservedKwargs = asRecord(data.agent_network_call_kwargs)
    const preservedSelectors = asRecord(data.agent_network_call_kwarg_selectors)
    const originalPrompt = data.agent_network_rendered_prompt
    const canRestoreKwargs = isGroup
      && typeof originalPrompt === 'string'
      && originalPrompt === currentPromptText
      && Object.keys(preservedKwargs).length > 0
    const args: [string, string][] = canRestoreKwargs
      ? Object.entries(preservedKwargs).flatMap(([name, raw]) => (
          isPythonIdentifier(name) && typeof raw === 'string' ? [[name, raw]] : []
        ))
      : [
          ['task', renderedPrompt],
          ...Object.entries(preservedKwargs).flatMap(([name, raw]) => {
            if (name === 'task' || !isPythonIdentifier(name) || typeof raw !== 'string')
              return []
            const selector = stringArray(preservedSelectors[name])
            const expression = selector.length ? this.selectorExpression(selector, node.id) : raw
            return [[name, expression] as [string, string]]
          }),
        ]

    if (!isGroup) {
      addDefinedArg(args, 'model', model.name)
      addDefinedArg(args, 'provider', model.provider)
      if (Object.keys(asRecord(model.completion_params)).length)
        args.push(['completion_params', pythonValue(model.completion_params)])
    }

    const skills = this.readSkills(node)
    if (skills.length)
      args.push(['skills', pythonValue(skills)])

    if (isGroup)
      this.warnForOmittedGroupExecutionControls(node)
    else
      this.appendErrorAndRetryArguments(node, args)
    if (!isGroup) {
      const config = this.semanticConfig(node, new Set([
        'agent_network_group',
        'agent_network_call_kwargs',
        'agent_network_call_kwarg_selectors',
        'agent_network_rendered_prompt',
        'model',
        'prompt_template',
        'skills',
        'error_strategy',
        'retry_config',
        'default_value',
      ]))
      if (Object.keys(config).length)
        args.push(['config', pythonValue(config)])
    }

    this.emitAssignedCall(variable, callable, args, indent, lines)
  }

  private valueNodeArguments(node: Node): [string, string][] {
    const data = asRecord(node.data)
    const args: [string, string][] = []

    switch (node.data.type) {
      case BlockEnum.KnowledgeRetrieval:
        args.push(['query', this.renderSelector(data.query_variable_selector, node.id)])
        args.push(['dataset_ids', pythonValue(data.dataset_ids)])
        args.push(['retrieval_mode', pythonValue(data.retrieval_mode)])
        break
      case BlockEnum.Code:
        args.push(['inputs', this.renderVariables(data.variables, node.id)])
        args.push(['language', pythonValue(data.code_language)])
        args.push(['code', pythonValue(data.code)])
        args.push(['outputs', pythonValue(data.outputs)])
        break
      case BlockEnum.TemplateTransform:
        args.push(['template', pythonValue(data.template)])
        args.push(['inputs', this.renderVariables(data.variables, node.id)])
        break
      case BlockEnum.HttpRequest:
        args.push(['method', pythonValue(data.method)])
        args.push(['url', this.renderTemplateText(data.url, node.id)])
        args.push(['headers', this.renderTemplateText(data.headers, node.id)])
        args.push(['params', this.renderTemplateText(data.params, node.id)])
        args.push(['body', pythonValue(data.body)])
        args.push(['authorization', pythonValue(data.authorization)])
        args.push(['timeout', pythonValue(data.timeout)])
        addDefinedArg(args, 'ssl_verify', data.ssl_verify)
        break
      case BlockEnum.VariableAssigner:
      case BlockEnum.VariableAggregator: {
        const groups = asRecord(data.advanced_settings).group_enabled
          ? asArray(asRecord(data.advanced_settings).groups)
          : []
        if (groups.length) {
          const renderedGroups = groups.map((group) => {
            const item = asRecord(group)
            return {
              name: item.group_name,
              values: asArray(item.variables).map(selector => this.selectorExpression(stringArray(selector), node.id)),
            }
          })
          args.push(['groups', pythonExpressionValue(renderedGroups)])
        }
        else {
          args.push([
            'values',
            `[${asArray(data.variables).map(selector => this.selectorExpression(stringArray(selector), node.id)).join(', ')}]`,
          ])
        }
        break
      }
      case BlockEnum.Tool:
        args.push(['provider', pythonValue(data.provider_id)])
        args.push(['tool', pythonValue(data.tool_name)])
        args.push(['arguments', this.renderResourceInputs(data.tool_parameters, node.id)])
        args.push(['configurations', pythonValue(data.tool_configurations)])
        addDefinedArg(args, 'plugin', data.plugin_unique_identifier ?? data.plugin_id)
        break
      case BlockEnum.ParameterExtractor:
        args.push(['query', this.renderSelector(data.query, node.id)])
        args.push(['parameters', pythonValue(data.parameters)])
        args.push(['reasoning_mode', pythonValue(data.reasoning_mode)])
        args.push(['instruction', pythonValue(data.instruction)])
        args.push(['model', pythonValue(data.model)])
        break
      case BlockEnum.DocExtractor:
        args.push(['document', this.renderSelector(data.variable_selector, node.id)])
        args.push(['is_array', pythonValue(data.is_array_file)])
        break
      case BlockEnum.ListFilter:
        args.push(['items', this.renderSelector(data.variable, node.id)])
        args.push(['filter_by', pythonValue(data.filter_by)])
        args.push(['extract_by', pythonValue(data.extract_by)])
        args.push(['order_by', pythonValue(data.order_by)])
        args.push(['limit', pythonValue(data.limit)])
        break
      case BlockEnum.Agent:
      case BlockEnum.AgentV2:
        if (isAgentV2NodeData(node.data)) {
          args.push(['task', this.renderTemplateText(data.agent_task, node.id)])
          args.push(['binding', pythonValue(data.agent_binding)])
          args.push(['outputs', pythonValue(data.agent_declared_outputs)])
        }
        else {
          args.push(['strategy_provider', pythonValue(data.agent_strategy_provider_name)])
          args.push(['strategy', pythonValue(data.agent_strategy_name)])
          args.push(['parameters', this.renderAgentParameters(node)])
          args.push(['outputs', pythonValue(data.output_schema)])
          addDefinedArg(args, 'plugin', data.plugin_unique_identifier)
        }
        break
      case BlockEnum.DataSource:
        args.push(['provider', pythonValue(data.provider_name ?? data.provider_id)])
        args.push(['datasource', pythonValue(data.datasource_name)])
        args.push(['parameters', this.renderResourceInputs(data.datasource_parameters, node.id)])
        args.push(['configurations', pythonValue(data.datasource_configurations)])
        addDefinedArg(args, 'plugin', data.plugin_unique_identifier ?? data.plugin_id)
        break
      default:
        this.fail('NODE_CONTRACT', `No argument contract exists for ${node.data.type}`, node.id)
    }

    return args
  }

  private emitAssigner(node: Node, indent: number, lines: string[]) {
    const items = asArray(asRecord(node.data).items)
    if (!items.length)
      this.fail('ASSIGNER_EMPTY', 'Variable Assigner has no operations', node.id)

    for (const rawItem of items) {
      const item = asRecord(rawItem)
      const target = this.selectorExpression(stringArray(item.variable_selector), node.id)
      const value = item.input_type === 'variable'
        ? this.renderSelector(item.value, node.id)
        : pythonValue(item.value)
      switch (item.operation) {
        case 'over-write':
        case 'set':
          lines.push(`${padding(indent)}${target} = ${value}`)
          break
        case 'clear':
          lines.push(`${padding(indent)}${target} = None`)
          break
        case 'append':
          lines.push(`${padding(indent)}${target}.append(${value})`)
          break
        case 'extend':
          lines.push(`${padding(indent)}${target}.extend(${value})`)
          break
        case '+=':
        case '-=':
        case '*=':
        case '/=':
          lines.push(`${padding(indent)}${target} ${item.operation} ${value}`)
          break
        case 'remove-first':
          lines.push(`${padding(indent)}${target}.pop(0)`)
          break
        case 'remove-last':
          lines.push(`${padding(indent)}${target}.pop()`)
          break
        default:
          this.fail('ASSIGNER_OPERATION', `Unsupported assignment operation ${String(item.operation)}`, node.id)
      }
    }
    lines.push('')
  }

  private emitEnd(node: Node, indent: number, lines: string[]) {
    const outputs = asArray(asRecord(node.data).outputs)
    if (!outputs.length)
      this.fail('END_OUTPUT_COUNT', 'End node must have at least one output', node.id)

    if (outputs.length === 1) {
      const selector = stringArray(asRecord(outputs[0]).value_selector)
      if (!selector.length)
        this.fail('END_OUTPUT_SELECTOR', 'End output is missing a value selector', node.id)
      lines.push(`${padding(indent)}final_result = ${this.selectorExpression(selector, node.id)}`)
      lines.push('')
      return
    }

    lines.push(`${padding(indent)}final_result = {`)
    outputs.forEach((rawOutput, index) => {
      const output = asRecord(rawOutput)
      const selector = stringArray(output.value_selector)
      if (!selector.length)
        this.fail('END_OUTPUT_SELECTOR', `End output ${index + 1} is missing a value selector`, node.id)
      const name = typeof output.variable === 'string' && output.variable
        ? output.variable
        : `output_${index + 1}`
      lines.push(
        `${padding(indent + 1)}${pythonString(name)}: ${this.selectorExpression(selector, node.id)},`,
      )
    })
    lines.push(`${padding(indent)}}`)
    lines.push('')
  }

  private emitAnswer(node: Node, indent: number, lines: string[]) {
    const answer = asRecord(node.data).answer
    lines.push(`${padding(indent)}reply(${this.renderTemplateText(answer, node.id)})`)
    lines.push('')
  }

  private emitKnowledgeBase(node: Node, indent: number, lines: string[]) {
    const data = asRecord(node.data)
    const selector = stringArray(data.index_chunk_variable_selector)
    if (!selector.length)
      this.fail('KNOWLEDGE_BASE_INPUT', 'KnowledgeBase is missing index_chunk_variable_selector', node.id)
    const config = this.semanticConfig(node, new Set(['index_chunk_variable_selector']))
    lines.push(`${padding(indent)}final_result = KnowledgeBase(`)
    lines.push(`${padding(indent + 1)}chunks=${this.selectorExpression(selector, node.id)},`)
    if (Object.keys(config).length)
      lines.push(`${padding(indent + 1)}config=${pythonValue(config)},`)
    lines.push(`${padding(indent)})`)
    lines.push('')
  }

  private emitIfElse(
    node: Node,
    indent: number,
    lines: string[],
    activePath: Set<string>,
  ): EmitBranchResult {
    const cases = this.readCases(node)
    const outgoing = this.outgoing.get(node.id) ?? []
    const entries = cases.map(branchCase => ({
      condition: this.renderCase(branchCase, node.id),
      target: this.branchTarget(node, outgoing, branchCase.caseId),
    }))
    const elseTarget = this.branchTarget(node, outgoing, 'false')
    return this.emitConditionalBranches(node, entries, elseTarget, indent, lines, activePath)
  }

  private emitQuestionClassifier(
    node: Node,
    indent: number,
    lines: string[],
    activePath: Set<string>,
  ): EmitBranchResult {
    const data = asRecord(node.data)
    const variable = this.variableNames.get(node.id)!
    const args: [string, string][] = [
      ['query', this.renderSelector(data.query_variable_selector, node.id)],
      ['classes', pythonValue(asArray(data.classes).map(value => asRecord(value).name))],
      ['instruction', pythonValue(data.instruction)],
      ['model', pythonValue(data.model)],
    ]
    const config = this.semanticConfig(node, new Set([
      'query_variable_selector',
      'classes',
      'instruction',
      'model',
    ]))
    if (Object.keys(config).length)
      args.push(['config', pythonValue(config)])
    this.emitAssignedCall(variable, 'QuestionClassifier', args, indent, lines)

    const outgoing = this.outgoing.get(node.id) ?? []
    const entries = asArray(data.classes).map((rawClass) => {
      const classItem = asRecord(rawClass)
      const classId = typeof classItem.id === 'string' ? classItem.id : ''
      const className = typeof classItem.name === 'string' ? classItem.name : classId
      if (!classId)
        this.fail('CLASSIFIER_CLASS_ID', 'Question Classifier class is missing id', node.id)
      return {
        condition: `${variable}.get("class_name") == ${pythonString(className)}`,
        target: this.branchTarget(node, outgoing, classId),
      }
    })
    return this.emitConditionalBranches(node, entries, null, indent, lines, activePath)
  }

  private emitHumanInput(
    node: Node,
    indent: number,
    lines: string[],
    activePath: Set<string>,
  ): EmitBranchResult {
    const data = asRecord(node.data)
    const variable = this.variableNames.get(node.id)!
    const actions = asArray(data.user_actions)
    const args: [string, string][] = [
      ['form', this.renderTemplateText(data.form_content, node.id)],
      ['inputs', pythonValue(data.inputs)],
      ['actions', pythonValue(actions.map(action => asRecord(action).title))],
      ['delivery_methods', pythonValue(data.delivery_methods)],
      ['timeout', pythonValue({ value: data.timeout, unit: data.timeout_unit })],
    ]
    this.emitAssignedCall(variable, 'HumanInput', args, indent, lines)

    const outgoing = this.outgoing.get(node.id) ?? []
    const entries: BranchEntry[] = actions.map((rawAction) => {
      const action = asRecord(rawAction)
      const id = typeof action.id === 'string' ? action.id : ''
      if (!id)
        this.fail('HUMAN_ACTION_ID', 'Human Input action is missing id', node.id)
      return {
        condition: `${variable}.get("action") == ${pythonString(id)}`,
        target: this.branchTarget(node, outgoing, id),
      }
    })
    const timeoutEdges = outgoing.filter(edge => edge.sourceHandle === '__timeout')
    if (timeoutEdges.length === 1) {
      entries.push({
        condition: `${variable}.get("timed_out") is True`,
        target: timeoutEdges[0]!.target,
      })
    }
    else if (timeoutEdges.length > 1) {
      this.fail('HUMAN_TIMEOUT_EDGE', 'Human Input has multiple timeout branches', node.id)
    }
    return this.emitConditionalBranches(node, entries, null, indent, lines, activePath)
  }

  private emitConditionalBranches(
    node: Node,
    entries: BranchEntry[],
    elseTarget: string | null,
    indent: number,
    lines: string[],
    activePath: Set<string>,
  ): EmitBranchResult {
    if (!entries.length)
      this.fail('EMPTY_BRANCH', `${node.data.title} has no configured branches`, node.id)

    const targets = [...entries.map(entry => entry.target), ...(elseTarget ? [elseTarget] : [])]
    const joinId = this.findCommonJoin(targets)
    const terminalMerge = joinId ? null : this.findTerminalMerge(targets)
    const stopIds = joinId
      ? new Set([joinId])
      : new Set(terminalMerge?.endIds ?? [])
    let everyBranchTerminates = true

    entries.forEach((entry, index) => {
      lines.push(`${padding(indent)}${index === 0 ? 'if' : 'elif'} ${entry.condition}:`)
      if (stopIds.has(entry.target)) {
        lines.push(`${padding(indent + 1)}pass`)
      }
      else {
        const terminated = this.emitSequence(
          entry.target,
          indent + 1,
          stopIds,
          lines,
          new Set(activePath),
        )
        everyBranchTerminates &&= terminated
      }
    })

    if (elseTarget) {
      lines.push(`${padding(indent)}else:`)
      if (stopIds.has(elseTarget)) {
        lines.push(`${padding(indent + 1)}pass`)
      }
      else {
        const terminated = this.emitSequence(
          elseTarget,
          indent + 1,
          stopIds,
          lines,
          new Set(activePath),
        )
        everyBranchTerminates &&= terminated
      }
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
    if (!everyBranchTerminates) {
      this.fail(
        'OPEN_BRANCH',
        `Every branch of ${node.data.title} must reach a terminal or a common join`,
        node.id,
      )
    }
    return { terminated: true, joinId: null }
  }

  private emitFailureBranch(
    node: Node,
    indent: number,
    lines: string[],
    activePath: Set<string>,
    failureEdge: Edge,
  ): EmitBranchResult {
    const normalEdges = (this.outgoing.get(node.id) ?? []).filter(edge => edge !== failureEdge)
    if (normalEdges.length !== 1) {
      this.fail(
        'FAILURE_NORMAL_EDGE',
        `Node ${node.data.title} with fail branch must have exactly one normal edge`,
        node.id,
      )
    }
    const normalTarget = normalEdges[0]!.target
    const failureTarget = failureEdge.target
    const joinId = this.findCommonJoin([normalTarget, failureTarget])
    const terminalMerge = joinId ? null : this.findTerminalMerge([normalTarget, failureTarget])
    const stopIds = joinId
      ? new Set([joinId])
      : new Set(terminalMerge?.endIds ?? [])

    lines.push(`${padding(indent)}try:`)
    this.emitValueNode(node, indent + 1, lines)
    const normalTerminated = stopIds.has(normalTarget)
      ? false
      : this.emitSequence(normalTarget, indent + 1, stopIds, lines, new Set(activePath))

    lines.push(`${padding(indent)}except Exception as error:`)
    const failureTerminated = stopIds.has(failureTarget)
      ? false
      : this.emitSequence(failureTarget, indent + 1, stopIds, lines, new Set(activePath))
    lines.push('')

    if (joinId)
      return { terminated: false, joinId }
    if (terminalMerge) {
      terminalMerge.endIds.forEach(endId => this.emitted.add(endId))
      lines.push(`${padding(indent)}final_result = ${terminalMerge.expression}`)
      lines.push('')
      return { terminated: true, joinId: null }
    }
    if (!normalTerminated || !failureTerminated) {
      this.fail(
        'OPEN_FAILURE_BRANCH',
        `Normal and failure paths of ${node.data.title} must reach a terminal or common join`,
        node.id,
      )
    }
    return { terminated: true, joinId: null }
  }

  private emitIteration(node: Node, indent: number, lines: string[]) {
    const data = asRecord(node.data)
    const iterator = this.renderSelector(data.iterator_selector, node.id)
    const outputVariable = this.variableNames.get(node.id)!
    const startNodeId = typeof data.start_node_id === 'string' ? data.start_node_id : ''
    const startNode = this.nodesById.get(startNodeId)
    if (!startNode || startNode.data.type !== BlockEnum.IterationStart)
      this.fail('ITERATION_START', 'Iteration is missing its internal start node', node.id)

    const itemName = uniqueScopedName(`${snakeName(node.data.title) || 'iteration'}_item`, this.variableNames)
    const indexName = uniqueScopedName(`${snakeName(node.data.title) || 'iteration'}_index`, this.variableNames)
    const iterationAliases = new Map([
      ['item', itemName],
      ['index', indexName],
    ])
    this.selectorAliases.set(startNodeId, iterationAliases)
    this.selectorAliases.set(node.id, new Map([
      ...iterationAliases,
      ['output', outputVariable],
    ]))

    const parallel = data.is_parallel === true
    const errorMode = typeof data.error_handle_mode === 'string'
      ? data.error_handle_mode
      : 'terminated'
    if (parallel) {
      this.warn(
        'PARALLEL_ITERATION_SERIALIZED',
        `Parallel iteration ${node.data.title} was exported as a sequential for loop because AgentNetwork forbids function definitions`,
        node.id,
      )
    }

    lines.push(`${padding(indent)}${outputVariable} = []`)
    lines.push(`${padding(indent)}for ${indexName}, ${itemName} in enumerate(${iterator}):`)
    this.emitted.add(startNodeId)
    const childTarget = this.singleSuccessor(startNode)
    if (!childTarget) {
      lines.push(`${padding(indent + 1)}pass`)
    }
    else {
      this.emitSequence(childTarget, indent + 1, new Set(), lines, new Set([node.id, startNodeId]))
      lines.push(
        `${padding(indent + 1)}${outputVariable}.append(${this.renderSelector(data.output_selector, node.id)})`,
      )
    }
    lines.push(`${padding(indent)}# iteration_error_mode=${pythonString(errorMode)}, flatten=${pythonValue(data.flatten_output)}`)
    lines.push('')
  }

  private emitLoop(node: Node, indent: number, lines: string[]) {
    const data = asRecord(node.data)
    let outputVariable = this.variableNames.get(node.id)!
    const startNodeId = typeof data.start_node_id === 'string' ? data.start_node_id : ''
    const startNode = this.nodesById.get(startNodeId)
    if (!startNode || startNode.data.type !== BlockEnum.LoopStart)
      this.fail('LOOP_START', 'Loop is missing its internal start node', node.id)

    const loopIndex = uniqueScopedName(`${snakeName(node.data.title) || 'loop'}_index`, this.variableNames)
    const aliases = new Map<string, string>([['index', loopIndex]])
    const resultEntries: [string, string][] = [['index', loopIndex]]
    const loopVariables = asArray(data.loop_variables)
    for (const rawVariable of loopVariables) {
      const variable = asRecord(rawVariable)
      const id = typeof variable.id === 'string' ? variable.id : ''
      const label = typeof variable.label === 'string' ? variable.label : id
      const name = safeVariableName(label || `loop_variable_${aliases.size}`, new Set(aliases.values()))
      if (id)
        aliases.set(id, name)
      if (label)
        aliases.set(label, name)
      resultEntries.push([label || id || name, name])
      lines.push(`${padding(indent)}${name} = ${this.loopVariableValue(variable, node.id)}`)
    }
    if ([...aliases.values()].includes(outputVariable)) {
      outputVariable = uniqueScopedName(
        `${snakeName(node.data.title) || 'loop'}_result`,
        this.variableNames,
      )
      this.variableNames.set(node.id, outputVariable)
    }
    aliases.set('output', outputVariable)
    this.selectorAliases.set(node.id, aliases)
    this.selectorAliases.set(startNodeId, aliases)

    const errorMode = typeof data.error_handle_mode === 'string'
      ? data.error_handle_mode
      : 'terminated'
    lines.push(`${padding(indent)}${loopIndex} = -1`)
    lines.push(`${padding(indent)}for ${loopIndex} in range(${pythonValue(data.loop_count)}):`)
    this.emitted.add(startNodeId)
    const childTarget = this.singleSuccessor(startNode)
    let bodyTerminated = false
    if (!childTarget) {
      lines.push(`${padding(indent + 1)}pass`)
    }
    else {
      bodyTerminated = this.emitSequence(
        childTarget,
        indent + 1,
        new Set(),
        lines,
        new Set([node.id, startNodeId]),
      )
    }

    const breakConditions = asArray(data.break_conditions).map(asRecord)
    if (breakConditions.length && !bodyTerminated) {
      const logicalOperator = data.logical_operator === 'or' ? 'or' : 'and'
      const rendered = breakConditions.map(condition => this.renderCondition(condition, node.id))
      lines.push(`${padding(indent + 1)}if ${rendered.join(` ${logicalOperator} `)}:`)
      lines.push(`${padding(indent + 2)}break`)
    }
    lines.push(`${padding(indent)}# loop_error_mode=${pythonString(errorMode)}`)
    lines.push(`${padding(indent)}${outputVariable} = {`)
    for (const [name, value] of resultEntries)
      lines.push(`${padding(indent + 1)}${pythonString(name)}: ${value},`)
    lines.push(`${padding(indent)}}`)
    lines.push('')
  }

  private loopVariableValue(variable: JsonRecord, nodeId: string): string {
    if (variable.value_type === 'variable')
      return this.renderSelector(variable.value, nodeId)
    if (
      typeof variable.value === 'string'
      && ['number', 'integer', 'float'].includes(String(variable.var_type).toLowerCase())
      && variable.value.trim() !== ''
      && Number.isFinite(Number(variable.value))
    ) {
      return String(Number(variable.value))
    }
    if (
      typeof variable.value === 'string'
      && String(variable.var_type).toLowerCase() === 'boolean'
      && ['true', 'false'].includes(variable.value.toLowerCase())
    ) {
      return variable.value.toLowerCase() === 'true' ? 'True' : 'False'
    }
    return pythonValue(variable.value)
  }

  private renderCase(branchCase: BranchCase, nodeId: string): string {
    if (!branchCase.conditions.length)
      this.fail('EMPTY_CONDITION', `Branch case ${branchCase.caseId} has no conditions`, nodeId)
    return branchCase.conditions
      .map(condition => this.renderCondition(condition, nodeId))
      .join(` ${branchCase.logicalOperator} `)
  }

  private renderCondition(condition: JsonRecord, nodeId: string): string {
    const selector = stringArray(condition.variable_selector)
    if (!selector.length)
      this.fail('CONDITION_SELECTOR', 'Condition is missing variable_selector', nodeId)
    let left = this.selectorExpression(selector, nodeId)
    if (typeof condition.key === 'string' && condition.key && !this.isScalarizedGroupSelector(selector))
      left = `${left}.get(${pythonString(condition.key)})`

    const operator = typeof condition.comparison_operator === 'string'
      ? condition.comparison_operator
      : ''
    const value = pythonValue(condition.value)
    const binary: Record<string, string> = {
      'is': '==',
      'is not': '!=',
      '=': '==',
      '==': '==',
      '\u2260': '!=',
      '!=': '!=',
      '>': '>',
      '\u2265': '>=',
      '>=': '>=',
      '<': '<',
      '\u2264': '<=',
      '<=': '<=',
      'in': 'in',
      'not in': 'not in',
      'before': '<',
      'after': '>',
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
    if (operator === 'all of')
      return `all(item in ${left} for item in ${value})`
    if (operator === 'exists' || operator === 'not exists') {
      const expression = `dify_exists(${left}, ${pythonValue(condition.sub_variable_condition)})`
      return operator === 'not exists' ? `not ${expression}` : expression
    }
    return `dify_compare(${left}, ${pythonString(operator)}, ${value})`
  }

  private promptText(value: unknown): string | null {
    if (Array.isArray(value)) {
      return value
        .map(item => asRecord(item).text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n')
    }
    const record = asRecord(value)
    if (typeof record.text === 'string')
      return record.text
    return typeof value === 'string' ? value : null
  }

  private renderInterpolatedValue(value: unknown, node: Node): string {
    if (Array.isArray(value)) {
      const texts = value
        .map(item => asRecord(item).text)
        .filter((text): text is string => typeof text === 'string')
      return this.renderTemplateText(texts.join('\n'), node.id, node)
    }
    const record = asRecord(value)
    if (typeof record.text === 'string')
      return this.renderTemplateText(record.text, node.id, node)
    if (typeof value === 'string')
      return this.renderTemplateText(value, node.id, node)

    const fallback = this.entryVariables.has('task') ? 'task' : pythonString('')
    this.warn('EMPTY_PROMPT', `Node ${node.data.title} has no prompt; using ${fallback}`, node.id)
    return fallback
  }

  private renderTemplateText(value: unknown, nodeId: string, node?: Node): string {
    const text = typeof value === 'string' ? value : ''
    if (!text) {
      if (node)
        this.warn('EMPTY_TEXT', `Node ${node.data.title} has empty text`, node.id)
      return pythonString('')
    }

    const tokens = [...text.matchAll(/\{\{#([^#]+)#\}\}/g)]
    if (tokens.length === 1 && tokens[0]![0] === text)
      return this.selectorExpression(tokens[0]![1]!.split('.'), nodeId)
    if (!tokens.length)
      return pythonString(text)

    let cursor = 0
    let rendered = ''
    for (const token of tokens) {
      const index = token.index ?? 0
      rendered += escapeFStringLiteral(text.slice(cursor, index))
      rendered += `{${this.selectorExpression(token[1]!.split('.'), nodeId)}}`
      cursor = index + token[0].length
    }
    rendered += escapeFStringLiteral(text.slice(cursor))
    return `f"${rendered}"`
  }

  private renderVariables(value: unknown, nodeId: string): string {
    const entries = asArray(value).map((rawVariable, index) => {
      const variable = asRecord(rawVariable)
      const name = typeof variable.variable === 'string' && variable.variable
        ? variable.variable
        : `input_${index + 1}`
      const selector = stringArray(variable.value_selector)
      return `${pythonString(name)}: ${selector.length
        ? this.selectorExpression(selector, nodeId)
        : pythonValue(variable.value)}`
    })
    return `{${entries.join(', ')}}`
  }

  private renderResourceInputs(value: unknown, nodeId: string): string {
    const entries = Object.entries(asRecord(value)).map(([name, rawInput]) => {
      const input = asRecord(rawInput)
      let rendered: string
      if (input.type === 'variable') {
        rendered = this.renderSelector(input.value, nodeId)
      }
      else if (
        input.type === 'mixed'
        || (typeof input.value === 'string' && input.value.includes('{{#'))
      ) {
        rendered = this.renderTemplateText(input.value, nodeId)
      }
      else {
        rendered = pythonValue(input.value)
      }
      return `${pythonString(name)}: ${rendered}`
    })
    return `{${entries.join(', ')}}`
  }

  private renderAgentParameters(node: Node): string {
    const data = asRecord(node.data)
    const parameters = { ...asRecord(data.agent_parameters) }
    const iterationAliases = ['maximum_iterations', 'max_iterations', 'max_iteration']
    const iterationEntry = iterationAliases
      .map(name => [name, parameters[name] ?? data[name]] as const)
      .find(([, value]) => value !== undefined)

    for (const name of iterationAliases)
      delete parameters[name]
    if (iterationEntry)
      parameters.maximum_iterations = iterationEntry[1]

    return this.renderResourceInputs(parameters, node.id)
  }

  private renderSelector(value: unknown, nodeId: string): string {
    const selector = stringArray(value)
    if (!selector.length)
      return 'None'
    return this.selectorExpression(selector, nodeId)
  }

  private isScalarizedGroupSelector(selector: string[]): boolean {
    const source = this.nodesById.get(selector[0] ?? '')
    if (source?.data.type !== BlockEnum.LLM)
      return false
    if (!isConfiguredAgentNetworkGroup(asRecord(source.data).agent_network_group))
      return false
    return selector.length === 1
      || selector[1] === 'text'
      || selector[1] === 'structured_output'
  }

  private selectorExpression(selector: string[], nodeId: string): string {
    const sourceId = selector[0]
    if (!sourceId)
      this.fail('EMPTY_SELECTOR', 'Value selector has no source node', nodeId)

    const systemVariable = this.systemVariableExpression(selector)
    if (systemVariable)
      return systemVariable

    const aliases = this.selectorAliases.get(sourceId)
    const alias = selector[1] ? aliases?.get(selector[1]) : undefined
    if (alias)
      return appendSelectorPath(alias, selector.slice(2))

    if (sourceId === this.entryId && this.entryVariables.has(selector[1] ?? '')) {
      const variable = selector[1]!
      return appendSelectorPath(variable, selector.slice(2))
    }

    const source = this.nodesById.get(sourceId)
    if (!source)
      this.fail('MISSING_SELECTOR_SOURCE', `Selector source ${sourceId} does not exist`, nodeId)

    if (source.data.type === BlockEnum.IterationStart || source.data.type === BlockEnum.LoopStart) {
      this.fail(
        'INTERNAL_SELECTOR',
        `Selector ${selector.join('.')} cannot be resolved outside its container`,
        nodeId,
      )
    }

    if (source.data.type === BlockEnum.End || source.data.type === BlockEnum.Answer)
      this.fail('TERMINAL_SELECTOR', `Cannot read output from terminal node ${sourceId}`, nodeId)

    const variable = this.variableNames.get(sourceId)
    if (!variable)
      this.fail('UNSUPPORTED_SELECTOR', `Node ${sourceId} does not produce a pseudocode value`, nodeId)

    const sourceData = asRecord(source.data)
    if (sourceData.agent_network_synthetic_join === true && selector[1] === 'output')
      return appendSelectorPath(variable, selector.slice(2))
    if (typeof sourceData.agent_network_synthetic_expression === 'string' && selector[1] === 'result')
      return sourceData.agent_network_synthetic_expression

    const path = selector.slice(1)
    if (source.data.type === BlockEnum.LLM) {
      const isGroup = isConfiguredAgentNetworkGroup(asRecord(source.data).agent_network_group)
      if (isGroup)
        return variable
      return appendSelectorPath(variable, path)
    }
    return appendSelectorPath(variable, path)
  }

  private systemVariableExpression(selector: string[]): string | null {
    let name = ''
    let remainingPath: string[] = []

    // Prompt templates store system references as {{#sys.query#}}, while
    // value selectors elsewhere in Dify commonly use [startId, "sys.query"].
    if (selector[0] === 'sys') {
      name = selector[1] ?? ''
      remainingPath = selector.slice(2)
    }
    else if (selector[0] === this.entryId && selector[1]?.startsWith('sys.')) {
      name = selector[1].slice('sys.'.length)
      remainingPath = selector.slice(2)
    }

    if (!name)
      return null

    const expression = isPythonIdentifier(name)
      ? name
      : `system_values[${pythonString(name)}]`
    return appendSelectorPath(expression, remainingPath)
  }

  private appendErrorAndRetryArguments(node: Node, args: [string, string][]) {
    const data = asRecord(node.data)
    if (RETRY_NODE_TYPES.has(node.data.type)) {
      const retry = asRecord(data.retry_config)
      if (retry.retry_enabled) {
        args.push(['retry', pythonValue({
          max_retries: retry.max_retries,
          interval_ms: retry.retry_interval,
        })])
      }
    }
    if (typeof data.error_strategy === 'string' && data.error_strategy !== 'fail-branch') {
      args.push(['on_error', pythonString(data.error_strategy)])
      if (data.error_strategy === 'default-value')
        args.push(['default', pythonValue(data.default_value)])
    }
  }

  private warnForOmittedGroupExecutionControls(node: Node) {
    const data = asRecord(node.data)
    const retry = asRecord(data.retry_config)
    const omitted: string[] = []
    if (retry.retry_enabled)
      omitted.push('retry')
    if (typeof data.error_strategy === 'string' && data.error_strategy !== 'fail-branch')
      omitted.push('error strategy')
    if (!omitted.length)
      return
    this.warn(
      'GROUP_EXECUTION_CONTROL_OMITTED',
      `${omitted.join(' and ')} are Dify runtime controls and were not sent as AgentNetwork node arguments`,
      node.id,
    )
  }

  private semanticConfig(node: Node, excluded: Set<string>): JsonRecord {
    const config: JsonRecord = {}
    for (const [key, value] of Object.entries(asRecord(node.data))) {
      if (
        excluded.has(key)
        || COMMON_CONFIG_KEYS.has(key)
        || key.startsWith('_')
        || value === undefined
      ) {
        continue
      }
      config[key] = value
    }
    return config
  }

  private emitAssignedCall(
    variable: string,
    callable: string,
    args: [string, string][],
    indent: number,
    lines: string[],
  ) {
    lines.push(`${padding(indent)}${variable} = ${callable}(`)
    for (const [name, value] of args)
      lines.push(`${padding(indent + 1)}${name}=${value},`)
    lines.push(`${padding(indent)})`)
    lines.push('')
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

  private readInputVariables(node: Node): string[] {
    const data = asRecord(node.data)
    const values = [
      ...asArray(data.variables),
      ...asArray(data.params),
      ...asArray(data.body),
    ]
    const names = values
      .map(item => asRecord(item))
      .map(item => item.variable ?? item.name)
      .filter((value): value is string => typeof value === 'string' && isPythonIdentifier(value))
    return [...new Set(names)]
  }

  private readCases(node: Node): BranchCase[] {
    const values = asArray(asRecord(node.data).cases)
    if (!values.length)
      this.fail('NO_BRANCH_CASES', 'If/Else node has no cases', node.id)
    return values.map((value, index) => {
      const item = asRecord(value)
      const caseId = typeof item.case_id === 'string' && item.case_id
        ? item.case_id
        : `case_${index + 1}`
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

  private failureEdge(node: Node): Edge | null {
    const data = asRecord(node.data)
    if (data.error_strategy !== 'fail-branch')
      return null
    const matches = (this.outgoing.get(node.id) ?? [])
      .filter(edge => edge.sourceHandle === 'fail-branch')
    if (matches.length !== 1) {
      this.fail(
        'FAILURE_EDGE_COUNT',
        `Node ${node.data.title} uses fail-branch but has ${matches.length} failure edges`,
        node.id,
      )
    }
    return matches[0]!
  }

  private singleSuccessor(node: Node): string | null {
    const edges = (this.outgoing.get(node.id) ?? [])
      .filter(edge => edge.sourceHandle !== 'fail-branch')
    if (edges.length > 1) {
      this.fail(
        'MULTIPLE_OUTPUTS',
        `Node ${node.data.title} has multiple outputs without a supported branch contract`,
        node.id,
      )
    }
    return edges[0]?.target ?? null
  }

  private findCommonJoin(starts: string[]): string | null {
    if (!starts.length)
      return null
    const distances = starts.map(start => this.distancesFrom(start))
    const common = [...distances[0]!.keys()]
      .filter(candidate => distances.every(items => items.has(candidate)))
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
    const expressions = endNodes.map(end => this.inlineEndExpression(end))
    if (expressions.includes(null) || new Set(expressions).size !== 1)
      return null
    return {
      endIds: [...new Set(endNodes.map(end => end.id))],
      expression: expressions[0]!,
    }
  }

  private inlineEndExpression(node: Node): string | null {
    const outputs = asArray(asRecord(node.data).outputs)
    if (!outputs.length)
      return null
    if (outputs.length === 1) {
      const selector = stringArray(asRecord(outputs[0]).value_selector)
      return selector.length ? this.selectorExpression(selector, node.id) : null
    }
    const entries = outputs.map((rawOutput, index) => {
      const output = asRecord(rawOutput)
      const selector = stringArray(output.value_selector)
      if (!selector.length)
        return null
      const name = typeof output.variable === 'string' && output.variable
        ? output.variable
        : `output_${index + 1}`
      return `${pythonString(name)}: ${this.selectorExpression(selector, node.id)}`
    })
    return entries.includes(null) ? null : `{${entries.join(', ')}}`
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
      if (
        node.data.type === BlockEnum.IfElse
        || node.data.type === BlockEnum.QuestionClassifier
        || node.data.type === BlockEnum.HumanInput
      ) {
        return null
      }
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

  private collectReachableIncludingContainers(start: string): Set<string> {
    const reachable = new Set(this.distancesFrom(start).keys())
    let changed = true
    while (changed) {
      changed = false
      for (const node of this.graph.nodes) {
        if (!node.parentId || !reachable.has(node.parentId) || reachable.has(node.id))
          continue
        reachable.add(node.id)
        for (const childReachable of this.distancesFrom(node.id).keys())
          reachable.add(childReachable)
        changed = true
      }
    }
    return reachable
  }

  private assertAcyclic(nodeId: string, visiting: Set<string>, visited: Set<string>) {
    if (visiting.has(nodeId))
      this.fail('CYCLE', `Workflow contains an unsupported graph cycle at node ${nodeId}`, nodeId)
    if (visited.has(nodeId))
      return
    visiting.add(nodeId)
    for (const edge of this.outgoing.get(nodeId) ?? [])
      this.assertAcyclic(edge.target, visiting, visited)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }

  private defaultVariableName(node: Node): string {
    if (
      node.data.type === BlockEnum.TriggerSchedule
      || node.data.type === BlockEnum.TriggerWebhook
      || node.data.type === BlockEnum.TriggerPlugin
    ) {
      return 'trigger_event'
    }
    if (node.data.type === BlockEnum.DataSource)
      return 'documents'
    if (node.data.type === BlockEnum.QuestionClassifier)
      return 'classification_result'
    if (node.data.type === BlockEnum.HumanInput)
      return 'human_input_result'
    const title = snakeName(stripGroupSuffix(node.data.title))
    return `${title || `${node.data.type.replace(/-/g, '_')}_${shortId(node.id).toLowerCase()}`}_result`
  }

  private stats(): AgentNetworkReverseStats {
    const agentNodes = this.graph.nodes.filter(node =>
      node.data.type === BlockEnum.LLM
      || node.data.type === BlockEnum.Agent
      || node.data.type === BlockEnum.AgentV2,
    )
    const llmNodes = this.graph.nodes.filter(node => node.data.type === BlockEnum.LLM)
    return {
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
      agents: agentNodes.length,
      branches: this.graph.nodes.filter(node =>
        node.data.type === BlockEnum.IfElse
        || node.data.type === BlockEnum.QuestionClassifier
        || node.data.type === BlockEnum.HumanInput,
      ).length,
      skills: llmNodes.reduce(
        (count, node) => count + this.readSkillsWithoutDiagnostics(node).length,
        0,
      ),
    }
  }

  private readSkillsWithoutDiagnostics(node: Node): string[] {
    const raw = asRecord(node.data).skills
    return Array.isArray(raw)
      ? [...new Set(
          raw
            .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
            .map(item => item.trim()),
        )]
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

export function compileAllDifyNodesToAgentNetworkPseudocode(
  graph: WorkflowDataUpdater,
  options: AgentNetworkReverseOptions = {},
): AgentNetworkReverseResult {
  const result = new GraphToPseudocodeCompiler(graph).compile()
  return {
    ...result,
    fileName: `${fileStem(options.workflowName ?? 'workflow')}.agentnetwork.py`,
  }
}

function addDefinedArg(args: [string, string][], name: string, value: unknown) {
  if (value !== undefined && value !== null && value !== '')
    args.push([name, pythonValue(value)])
}

function appendSelectorPath(base: string, path: string[]): string {
  return path.reduce(
    (expression, key) => `${expression}.get(${pythonString(key)})`,
    base,
  )
}

function pythonExpressionValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => pythonExpressionValue(item)).join(', ')}]`
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, item]) => {
      if (key === 'values' && Array.isArray(item))
        return `${pythonString(key)}: [${item.join(', ')}]`
      return `${pythonString(key)}: ${pythonExpressionValue(item)}`
    })
    return `{${entries.join(', ')}}`
  }
  return pythonValue(value)
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
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${pythonString(key)}: ${pythonValue(item)}`)
    return `{${entries.join(', ')}}`
  }
  return pythonString(String(value))
}

function pythonString(value: string): string {
  return JSON.stringify(value)
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
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : []
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = PYTHON_RESERVED_WORDS.has(base) ? `${base}_value` : base
  let suffix = 2
  while (used.has(candidate))
    candidate = `${base}_${suffix++}`
  return candidate
}

function uniqueScopedName(base: string, variables: Map<string, string>): string {
  return uniqueName(base, new Set(variables.values()))
}

function safeVariableName(value: string, used: Set<string>): string {
  const normalized = snakeName(value) || 'loop_variable'
  return uniqueName(normalized, used)
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Z_]\w*$/i.test(value) && !PYTHON_RESERVED_WORDS.has(value)
}

function snakeName(value: string): string {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  const normalized = expanded
    .replace(/[^A-Z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return normalized && !/^\d/.test(normalized) ? normalized : ''
}

function stripGroupSuffix(value: string): string {
  return value.replace(/group$/i, '')
}

function isConfiguredAgentNetworkGroup(value: unknown): value is string {
  return isAgentNetworkGroup(value)
    || (
      typeof value === 'string'
      && isPythonIdentifier(value)
      && value.endsWith('Group')
    )
}

function shortId(value: string): string {
  const compact = value.replace(/[^A-Z0-9]/gi, '')
  const shortened = (compact.slice(0, 8) || 'Node').replace(/^(\d)/, 'N$1')
  return `${shortened[0]!.toUpperCase()}${shortened.slice(1)}`
}

function fileStem(value: string): string {
  const withoutControlCharacters = [...value]
    .filter(character => character.charCodeAt(0) >= 32)
    .join('')
  const normalized = withoutControlCharacters
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/[. ]+$/g, '')
  return normalized || 'workflow'
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
