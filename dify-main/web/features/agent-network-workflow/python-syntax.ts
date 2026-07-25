import { parser } from '@lezer/python'

type SyntaxNode = ReturnType<typeof parser.parse>['topNode']

export type ParsedValue
  = | { expr: 'var', name: string, raw: string, refs: string[] }
    | { expr: 'const', value: string | number | boolean | null, valueType: 'str' | 'int' | 'float' | 'bool' | 'null', raw: string, refs: string[] }
    | { expr: 'template', parts: Array<{ text: string } | { var: string } | { rawExpression: string }>, raw: string, refs: string[] }
    | { expr: 'list', items: ParsedValue[], raw: string, refs: string[] }
    | { expr: 'dict', entries: Record<string, ParsedValue>, raw: string, refs: string[] }
    | { expr: 'access', variable: string, key: string, raw: string, refs: string[] }
    | { expr: 'raw', raw: string, refs: string[] }

export type ParsedComparison = {
  variable: string
  key: string | null
  operator: string
  value: ParsedValue | null
  raw: string
}

export type ParsedCondition = {
  parsed: boolean
  logical: 'and' | 'or' | null
  comparisons: ParsedComparison[]
  raw: string
  refs: string[]
}

export type ParsedCall = {
  functionName: string
  args: ParsedValue[]
  kwargs: Record<string, ParsedValue>
}

export type ParsedStatement
  = | { kind: 'assign-call', target: string, call: ParsedCall, line: number }
    | { kind: 'assign', target: string, value: ParsedValue, line: number }
    | { kind: 'call', call: ParsedCall, line: number }
    | { kind: 'if', cases: Array<{ condition: ParsedCondition, body: ParsedStatement[], line: number }>, elseBody: ParsedStatement[], line: number }
    | { kind: 'for', targets: string[], iterator: ParsedCall, body: ParsedStatement[], line: number }
    | { kind: 'while', condition: ParsedCondition, body: ParsedStatement[], line: number }
    | { kind: 'append', target: string, value: ParsedValue, line: number }
    | { kind: 'break', line: number }
    | { kind: 'return', value: ParsedValue | null, line: number }

export class AgentNetworkSyntaxError extends Error {
  line: number | null

  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `Line ${line}: ${message}`)
    this.name = 'AgentNetworkSyntaxError'
    this.line = line
  }
}

class PythonSubsetParser {
  private readonly source: string
  private readonly lineStarts: number[]

  constructor(source: string) {
    this.source = source
    this.lineStarts = [0]
    for (let index = 0; index < source.length; index++) {
      if (source[index] === '\n')
        this.lineStarts.push(index + 1)
    }
  }

  parse(): ParsedStatement[] {
    const tree = parser.parse(this.source)
    const errorNode = this.findError(tree.topNode)
    if (errorNode)
      throw this.error(errorNode, 'Invalid Python syntax')
    const statements = this.children(tree.topNode)
      .filter(node => node.name !== 'Comment')
      .map(node => this.parseStatement(node))
    if (!statements.length)
      throw new AgentNetworkSyntaxError('Pseudocode is empty')
    return statements
  }

  private parseStatement(node: SyntaxNode): ParsedStatement {
    switch (node.name) {
      case 'AssignStatement':
        return this.parseAssignment(node)
      case 'ExpressionStatement':
        return this.parseExpressionStatement(node)
      case 'IfStatement':
        return this.parseIf(node)
      case 'ReturnStatement':
        return this.parseReturn(node)
      case 'ImportStatement':
        throw this.error(node, 'import is forbidden by the AgentNetwork pseudocode contract')
      case 'FunctionDefinition':
        throw this.error(node, 'def is forbidden by the AgentNetwork pseudocode contract')
      case 'ClassDefinition':
        throw this.error(node, 'class is forbidden by the AgentNetwork pseudocode contract')
      case 'ForStatement':
        return this.parseFor(node)
      case 'WhileStatement':
        return this.parseWhile(node)
      case 'BreakStatement':
        return { kind: 'break', line: this.line(node.from) }
      default:
        throw this.error(node, `Unsupported statement type ${node.name}`)
    }
  }

  private parseAssignment(node: SyntaxNode): ParsedStatement {
    const children = this.children(node)
    const assignmentIndexes = children
      .map((child, index) => child.name === 'AssignOp' ? index : -1)
      .filter(index => index >= 0)
    if (assignmentIndexes.length !== 1)
      throw this.error(node, 'Only one assignment target is supported')
    const assignmentIndex = assignmentIndexes[0]!
    const targetNode = children[0]
    const valueNode = children[assignmentIndex + 1]
    if (targetNode?.name !== 'VariableName' || !valueNode || children.length !== assignmentIndex + 2)
      throw this.error(node, 'Assignment target must be a single variable')
    const target = this.text(targetNode)
    const call = this.tryParseDirectCall(valueNode)
    if (call)
      return { kind: 'assign-call', target, call, line: this.line(node.from) }
    return {
      kind: 'assign',
      target,
      value: this.parseValue(valueNode),
      line: this.line(node.from),
    }
  }

  private parseExpressionStatement(node: SyntaxNode): ParsedStatement {
    const expression = this.children(node)[0]
    const call = expression && this.tryParseDirectCall(expression)
    if (call)
      return { kind: 'call', call, line: this.line(node.from) }
    const append = expression && this.tryParseAppend(expression)
    if (append)
      return { kind: 'append', ...append, line: this.line(node.from) }
    throw this.error(node, 'Only direct function calls and list append are supported as standalone expressions')
  }

  private parseFor(node: SyntaxNode): ParsedStatement {
    const children = this.children(node)
    const inIndex = children.findIndex(child => child.name === 'in')
    const bodyNode = children.at(-1)
    if (inIndex < 2 || bodyNode?.name !== 'Body')
      throw this.error(node, 'Invalid for statement structure')
    const targets = children.slice(1, inIndex)
      .filter(child => child.name !== ',')
      .map((child) => {
        if (child.name !== 'VariableName')
          throw this.error(child, 'For targets must be simple variables')
        return this.text(child)
      })
    const iteratorNode = children[inIndex + 1]
    const iterator = iteratorNode && this.tryParseDirectCall(iteratorNode)
    if (!iterator || !['enumerate', 'range'].includes(iterator.functionName))
      throw this.error(iteratorNode ?? node, 'For loops must use enumerate(...) or range(...)')
    return { kind: 'for', targets, iterator, body: this.parseBody(bodyNode), line: this.line(node.from) }
  }

  private parseWhile(node: SyntaxNode): ParsedStatement {
    const children = this.children(node)
    const conditionNode = children[1]
    const bodyNode = children[2]
    if (!conditionNode || bodyNode?.name !== 'Body')
      throw this.error(node, 'Invalid while statement structure')
    const condition = this.parseCondition(conditionNode)
    if (!condition.parsed)
      throw this.error(conditionNode, `While condition cannot be represented safely: ${condition.raw}`)
    return { kind: 'while', condition, body: this.parseBody(bodyNode), line: this.line(node.from) }
  }

  private parseIf(node: SyntaxNode): ParsedStatement {
    const children = this.children(node)
    const cases: Array<{ condition: ParsedCondition, body: ParsedStatement[], line: number }> = []
    let elseBody: ParsedStatement[] = []
    let index = 0
    while (index < children.length) {
      const keyword = children[index]
      if (keyword?.name === 'if' || keyword?.name === 'elif') {
        const conditionNode = children[index + 1]
        const bodyNode = children[index + 2]
        if (!conditionNode || bodyNode?.name !== 'Body')
          throw this.error(keyword, `Invalid ${keyword.name} branch`)
        cases.push({
          condition: this.parseCondition(conditionNode),
          body: this.parseBody(bodyNode),
          line: this.line(keyword.from),
        })
        index += 3
        continue
      }
      if (keyword?.name === 'else') {
        const bodyNode = children[index + 1]
        if (bodyNode?.name !== 'Body')
          throw this.error(keyword, 'Invalid else branch')
        elseBody = this.parseBody(bodyNode)
        index += 2
        continue
      }
      throw this.error(keyword ?? node, 'Invalid if statement structure')
    }
    return { kind: 'if', cases, elseBody, line: this.line(node.from) }
  }

  private parseBody(node: SyntaxNode): ParsedStatement[] {
    return this.children(node)
      .filter(child => child.name !== ':' && child.name !== 'Comment')
      .map(child => this.parseStatement(child))
  }

  private parseReturn(node: SyntaxNode): ParsedStatement {
    const children = this.children(node).filter(child => child.name !== 'return' && child.name !== ',')
    if (children.length > 1)
      throw this.error(node, 'Return supports at most one value')
    return {
      kind: 'return',
      value: children[0] ? this.parseValue(children[0]) : null,
      line: this.line(node.from),
    }
  }

  private tryParseDirectCall(node: SyntaxNode): ParsedCall | null {
    if (node.name !== 'CallExpression')
      return null
    const children = this.children(node)
    const callee = children[0]
    const argumentList = children[1]
    if (callee?.name !== 'VariableName' || argumentList?.name !== 'ArgList')
      return null
    const args: ParsedValue[] = []
    const kwargs: Record<string, ParsedValue> = {}
    for (const segment of this.argumentSegments(argumentList)) {
      if (segment.length === 3 && segment[0]?.name === 'VariableName' && segment[1]?.name === 'AssignOp') {
        const name = this.text(segment[0])
        if (name in kwargs)
          throw this.error(segment[0], `Duplicate keyword argument ${name}`)
        kwargs[name] = this.parseValue(segment[2]!)
        continue
      }
      const argument = segment[0]
      if (segment.length !== 1 || !argument || argument.name === '*' || argument.name === '**')
        throw this.error(argument ?? argumentList, 'Argument unpacking and assignment expressions are unsupported')
      args.push(this.parseValue(argument))
    }
    return { functionName: this.text(callee), args, kwargs }
  }

  private tryParseAppend(node: SyntaxNode): { target: string, value: ParsedValue } | null {
    if (node.name !== 'CallExpression')
      return null
    const [callee, argumentList] = this.children(node)
    if (callee?.name !== 'MemberExpression' || argumentList?.name !== 'ArgList')
      return null
    const memberChildren = this.children(callee)
    if (
      memberChildren[0]?.name !== 'VariableName'
      || memberChildren[2]?.name !== 'PropertyName'
      || this.text(memberChildren[2]) !== 'append'
    ) {
      return null
    }
    const segments = this.argumentSegments(argumentList)
    if (segments.length !== 1 || segments[0]?.length !== 1)
      throw this.error(argumentList, 'append requires exactly one value')
    return {
      target: this.text(memberChildren[0]),
      value: this.parseValue(segments[0][0]!),
    }
  }

  private argumentSegments(node: SyntaxNode): SyntaxNode[][] {
    const segments: SyntaxNode[][] = []
    let segment: SyntaxNode[] = []
    for (const child of this.children(node)) {
      if (child.name === '(' || child.name === ')')
        continue
      if (child.name === ',') {
        if (segment.length)
          segments.push(segment)
        segment = []
        continue
      }
      segment.push(child)
    }
    if (segment.length)
      segments.push(segment)
    return segments
  }

  private parseValue(node: SyntaxNode): ParsedValue {
    const raw = this.text(node)
    switch (node.name) {
      case 'VariableName':
        return { expr: 'var', name: raw, raw, refs: [raw] }
      case 'String': {
        const value = this.decodeString(node)
        return value === null
          ? { expr: 'raw', raw, refs: [] }
          : { expr: 'const', value, valueType: 'str', raw, refs: [] }
      }
      case 'FormatString':
        return this.parseFormatString(node)
      case 'ContinuedString':
        return this.parseContinuedString(node)
      case 'ArrayExpression': {
        const items = this.children(node)
          .filter(child => child.name !== '[' && child.name !== ']' && child.name !== ',')
          .map(child => this.parseValue(child))
        return { expr: 'list', items, raw, refs: unique(items.flatMap(item => item.refs)) }
      }
      case 'DictionaryExpression':
        return this.parseDictionary(node)
      case 'CallExpression':
        return this.parseAccess(node) ?? { expr: 'raw', raw, refs: this.collectReferences(node) }
      case 'UnaryExpression':
        return this.parseUnaryNumber(node)
      case 'Number':
        return this.parseNumber(node)
      case 'Boolean':
        return { expr: 'const', value: raw === 'True', valueType: 'bool', raw, refs: [] }
      case 'None':
        return { expr: 'const', value: null, valueType: 'null', raw, refs: [] }
      default:
        return { expr: 'raw', raw, refs: this.collectReferences(node) }
    }
  }

  private parseDictionary(node: SyntaxNode): ParsedValue {
    const children = this.children(node).filter(child => !['{', '}', ','].includes(child.name))
    const entries: Record<string, ParsedValue> = {}
    for (let index = 0; index < children.length;) {
      const keyNode = children[index]
      const separator = children[index + 1]
      const valueNode = children[index + 2]
      if (!keyNode || separator?.name !== ':' || !valueNode)
        throw this.error(node, 'Dictionary entries must be key/value pairs')
      if (keyNode.name !== 'String')
        throw this.error(keyNode, 'Dictionary keys must be strings')
      const key = this.decodeString(keyNode)
      if (key === null)
        throw this.error(keyNode, 'Dictionary key must be a plain string')
      entries[key] = this.parseValue(valueNode)
      index += 3
    }
    return {
      expr: 'dict',
      entries,
      raw: this.text(node),
      refs: unique(Object.values(entries).flatMap(value => value.refs)),
    }
  }

  private parseAccess(node: SyntaxNode): ParsedValue | null {
    const [callee, argumentList] = this.children(node)
    if (callee?.name !== 'MemberExpression' || argumentList?.name !== 'ArgList')
      return null
    const memberChildren = this.children(callee)
    if (
      memberChildren[0]?.name !== 'VariableName'
      || memberChildren[2]?.name !== 'PropertyName'
      || this.text(memberChildren[2]) !== 'get'
    ) {
      return null
    }
    const segments = this.argumentSegments(argumentList)
    if (segments.length !== 1 || segments[0]?.length !== 1 || segments[0][0]?.name !== 'String')
      return null
    const key = this.decodeString(segments[0][0])
    if (key === null)
      return null
    const variable = this.text(memberChildren[0])
    return { expr: 'access', variable, key, raw: this.text(node), refs: [variable] }
  }

  private parseUnaryNumber(node: SyntaxNode): ParsedValue {
    const [operator, number] = this.children(node)
    if (operator?.name !== 'ArithOp' || !['+', '-'].includes(this.text(operator)) || number?.name !== 'Number')
      return { expr: 'raw', raw: this.text(node), refs: this.collectReferences(node) }
    const parsed = this.parseNumber(number)
    if (parsed.expr !== 'const' || typeof parsed.value !== 'number')
      return { expr: 'raw', raw: this.text(node), refs: [] }
    return {
      ...parsed,
      value: this.text(operator) === '-' ? -parsed.value : parsed.value,
      raw: this.text(node),
    }
  }

  private parseNumber(node: SyntaxNode): ParsedValue {
    const raw = this.text(node)
    const normalized = raw.replaceAll('_', '')
    const value = Number(normalized)
    if (!Number.isFinite(value) || (/^[+-]?\d+$/.test(normalized) && !Number.isSafeInteger(value)))
      return { expr: 'raw', raw, refs: [] }
    return {
      expr: 'const',
      value,
      valueType: /[.e]/i.test(normalized) ? 'float' : 'int',
      raw,
      refs: [],
    }
  }

  private parseContinuedString(node: SyntaxNode): ParsedValue {
    const values = this.children(node).map(child => this.parseValue(child))
    const raw = this.text(node)
    if (values.some(value => value.expr === 'raw'))
      return { expr: 'raw', raw, refs: this.collectReferences(node) }
    if (values.every(value => value.expr === 'const' && typeof value.value === 'string')) {
      return {
        expr: 'const',
        value: values.map(value => value.expr === 'const' ? value.value : '').join(''),
        valueType: 'str',
        raw,
        refs: [],
      }
    }
    const parts: Array<{ text: string } | { var: string } | { rawExpression: string }> = []
    const refs = new Set<string>()
    for (const value of values) {
      if (value.expr === 'const') {
        parts.push({ text: String(value.value ?? '') })
      }
      else if (value.expr === 'template') {
        parts.push(...value.parts)
        value.refs.forEach(reference => refs.add(reference))
      }
    }
    return { expr: 'template', parts: this.mergeTextParts(parts), raw, refs: [...refs].sort() }
  }

  private parseFormatString(node: SyntaxNode): ParsedValue {
    if (this.hasDescendant(node, new Set(['FormatConversion', 'FormatSpec'])))
      return { expr: 'raw', raw: this.text(node), refs: this.collectReferences(node) }
    const raw = this.text(node)
    const bounds = this.stringBounds(raw)
    if (!bounds)
      return { expr: 'raw', raw, refs: this.collectReferences(node) }
    const parts: Array<{ text: string } | { var: string } | { rawExpression: string }> = []
    const refs = new Set<string>()
    let cursor = node.from + bounds.contentStart
    const replacements = this.children(node).filter(child => child.name === 'FormatReplacement')
    for (const replacement of replacements) {
      const text = this.source.slice(cursor, replacement.from)
      if (text)
        parts.push({ text: this.decodeFormatText(text, bounds.raw) })
      const expression = this.children(replacement).find(child => !['{', '}', 'FormatSelfDoc'].includes(child.name))
      if (!expression)
        return { expr: 'raw', raw, refs: this.collectReferences(node) }
      if (expression.name === 'VariableName') {
        const name = this.text(expression)
        parts.push({ var: name })
        refs.add(name)
      }
      else {
        parts.push({ rawExpression: this.text(expression) })
        this.collectReferences(expression).forEach(reference => refs.add(reference))
      }
      cursor = replacement.to
    }
    const contentEnd = node.to - bounds.quoteLength
    const trailingText = this.source.slice(cursor, contentEnd)
    if (trailingText)
      parts.push({ text: this.decodeFormatText(trailingText, bounds.raw) })
    return { expr: 'template', parts: this.mergeTextParts(parts), raw, refs: [...refs].sort() }
  }

  private parseCondition(node: SyntaxNode): ParsedCondition {
    const raw = this.text(node)
    const refs = this.collectReferences(node)
    const logical = this.logicalOperator(node)
    if (logical) {
      const atoms: SyntaxNode[] = []
      if (!this.flattenLogical(node, logical, atoms))
        return { parsed: false, logical: null, comparisons: [], raw, refs }
      const comparisons = atoms.map(atom => this.parseComparison(atom))
      if (comparisons.includes(null))
        return { parsed: false, logical: null, comparisons: [], raw, refs }
      return { parsed: true, logical, comparisons: comparisons as ParsedComparison[], raw, refs }
    }
    const comparison = this.parseComparison(node)
    return comparison
      ? { parsed: true, logical: 'and', comparisons: [comparison], raw, refs }
      : { parsed: false, logical: null, comparisons: [], raw, refs }
  }

  private parseComparison(node: SyntaxNode): ParsedComparison | null {
    const raw = this.text(node)
    if (node.name === 'UnaryExpression') {
      const children = this.children(node)
      const getter = children[0]?.name === 'not' && children[1] ? this.parseGetter(children[1]) : null
      return getter
        ? { variable: getter.variable, key: getter.key, operator: 'falsy', value: null, raw }
        : null
    }
    if (node.name === 'BinaryExpression') {
      const children = this.children(node)
      const left = children[0]
      const right = children.at(-1)
      if (!left || !right || left === right)
        return null
      const operator = this.source.slice(left.to, right.from).trim().replace(/\s+/g, ' ')
      if (!['==', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'is', 'is not'].includes(operator))
        return null
      const getter = this.parseGetter(left)
      return getter
        ? { variable: getter.variable, key: getter.key, operator, value: this.parseValue(right), raw }
        : null
    }
    const getter = this.parseGetter(node)
    return getter
      ? { variable: getter.variable, key: getter.key, operator: 'truthy', value: null, raw }
      : null
  }

  private parseGetter(node: SyntaxNode): { variable: string, key: string | null } | null {
    if (node.name === 'VariableName')
      return { variable: this.text(node), key: null }
    if (node.name !== 'CallExpression')
      return null
    const children = this.children(node)
    const member = children[0]
    const args = children[1]
    if (member?.name !== 'MemberExpression' || args?.name !== 'ArgList')
      return null
    const memberChildren = this.children(member)
    if (memberChildren[0]?.name !== 'VariableName' || this.text(memberChildren.at(-1)!) !== 'get')
      return null
    const segments = this.argumentSegments(args)
    if (segments.length !== 1 || segments[0]?.length !== 1 || segments[0][0]?.name !== 'String')
      return null
    const key = this.decodeString(segments[0][0])
    return key === null ? null : { variable: this.text(memberChildren[0]), key }
  }

  private logicalOperator(node: SyntaxNode): 'and' | 'or' | null {
    if (node.name !== 'BinaryExpression')
      return null
    const names = this.children(node).map(child => child.name)
    if (names.includes('and'))
      return 'and'
    if (names.includes('or'))
      return 'or'
    return null
  }

  private flattenLogical(node: SyntaxNode, logical: 'and' | 'or', result: SyntaxNode[]): boolean {
    const current = this.logicalOperator(node)
    if (!current) {
      result.push(node)
      return true
    }
    if (current !== logical)
      return false
    const children = this.children(node)
    const left = children[0]
    const right = children.at(-1)
    return Boolean(left && right && this.flattenLogical(left, logical, result) && this.flattenLogical(right, logical, result))
  }

  private decodeString(node: SyntaxNode): string | null {
    const raw = this.text(node)
    const bounds = this.stringBounds(raw)
    if (!bounds || bounds.prefix.toLowerCase().includes('b') || bounds.prefix.toLowerCase().includes('f'))
      return null
    const content = raw.slice(bounds.contentStart, raw.length - bounds.quoteLength)
    return bounds.raw ? content : this.decodeEscapes(content)
  }

  private stringBounds(raw: string): { contentStart: number, quoteLength: number, prefix: string, raw: boolean } | null {
    const match = /^([a-z]*)("""|'''|"|')/i.exec(raw)
    if (!match)
      return null
    const prefix = match[1] ?? ''
    const quote = match[2] ?? ''
    if (!raw.endsWith(quote))
      return null
    return {
      contentStart: prefix.length + quote.length,
      quoteLength: quote.length,
      prefix,
      raw: prefix.toLowerCase().includes('r'),
    }
  }

  private decodeFormatText(value: string, raw: boolean): string {
    const decoded = raw ? value : this.decodeEscapes(value)
    return decoded.replaceAll('{{', '{').replaceAll('}}', '}')
  }

  private decodeEscapes(value: string): string {
    return value.replace(/\\(?:U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|\n|.)/g, (escape) => {
      const code = escape.slice(1)
      const simple: Record<string, string> = {
        'n': '\n',
        'r': '\r',
        't': '\t',
        'b': '\b',
        'f': '\f',
        'v': '\v',
        'a': '\u0007',
        '\\': '\\',
        '"': '"',
        '\'': '\'',
        '\n': '',
        '\r\n': '',
      }
      if (code in simple)
        return simple[code]!
      if (code.startsWith('x'))
        return String.fromCodePoint(Number.parseInt(code.slice(1), 16))
      if (code.startsWith('u'))
        return String.fromCodePoint(Number.parseInt(code.slice(1), 16))
      if (code.startsWith('U'))
        return String.fromCodePoint(Number.parseInt(code.slice(1), 16))
      return escape
    })
  }

  private collectReferences(node: SyntaxNode): string[] {
    const references = new Set<string>()
    const visit = (current: SyntaxNode) => {
      if (current.name === 'VariableName') {
        const parent = current.parent
        const firstChild = parent?.firstChild
        const nextSibling = current.nextSibling
        const isCallTarget = parent?.name === 'CallExpression' && firstChild?.from === current.from
        const isKeywordName = parent?.name === 'ArgList' && nextSibling?.name === 'AssignOp'
        if (!isCallTarget && !isKeywordName)
          references.add(this.text(current))
      }
      for (const child of this.children(current))
        visit(child)
    }
    visit(node)
    return [...references].sort()
  }

  private mergeTextParts(parts: Array<{ text: string } | { var: string } | { rawExpression: string }>) {
    const merged: Array<{ text: string } | { var: string } | { rawExpression: string }> = []
    for (const part of parts) {
      const previous = merged.at(-1)
      if ('text' in part && previous && 'text' in previous)
        previous.text += part.text
      else if (!('text' in part) || part.text)
        merged.push(part)
    }
    return merged
  }

  private hasDescendant(node: SyntaxNode, names: Set<string>): boolean {
    for (const child of this.children(node)) {
      if (names.has(child.name) || this.hasDescendant(child, names))
        return true
    }
    return false
  }

  private findError(node: SyntaxNode): SyntaxNode | null {
    if (node.type.isError)
      return node
    for (const child of this.children(node)) {
      const error = this.findError(child)
      if (error)
        return error
    }
    return null
  }

  private children(node: SyntaxNode): SyntaxNode[] {
    const result: SyntaxNode[] = []
    for (let child = node.firstChild; child; child = child.nextSibling)
      result.push(child)
    return result
  }

  private text(node: SyntaxNode): string {
    return this.source.slice(node.from, node.to)
  }

  private line(position: number): number {
    let low = 0
    let high = this.lineStarts.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.lineStarts[middle]! <= position)
        low = middle + 1
      else
        high = middle
    }
    return low
  }

  private error(node: SyntaxNode, message: string): AgentNetworkSyntaxError {
    return new AgentNetworkSyntaxError(message, this.line(node.from))
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function parseAgentNetworkPseudocode(source: string): ParsedStatement[] {
  return new PythonSubsetParser(source).parse()
}
