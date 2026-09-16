import type { Analyst } from './analysts'
import {
  buildRepairMessage,
  citedPanel,
  claimsFor,
  numberCitations,
  readShowCitations,
  resolveCitations,
  resolveViewCitations,
  uncitedSentences,
  type Citation,
  type NumberedCitation,
  type ServerRef,
} from './citations.ts'
import { errorText } from './errors.ts'
import { evictResults, resultSummary, stepFor, type AnalystMessage } from './room.ts'

// One analyst answering one message: call the model with the thread and the analyst's tools, run
// whatever tools it asks for, keep going until it answers without asking, and write the message as
// it grows. Beside the connections' tools it may read back a stubbed result, and read what the views
// on the user's workspace show, a view's whole text included. When the answer is in, its citations
// go to the connection's show_citations tool, which finds each quote in its source and links it, and
// its quotes from views' texts are checked here against the text; a quote that is not found, or a
// sentence stating a fact with no tag, sends the draft back to the model once. The model, the
// tools, and the app's state arrive through the context, the files through `io`, so the loop is
// tested with a scripted model. What the context needs is spelled out here, in the shapes the app's
// llm, tools, and state capabilities have.

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  output: string
  isError: boolean
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw: unknown[] | null }
  | { role: 'tool'; results: ToolResult[] }

export interface Completion {
  text: string
  toolCalls: ToolCall[]
  stopReason: string
  usage: { input: number; output: number }
  raw: unknown[] | null
}

export interface ToolEntry {
  id: string
  connection: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface RunnerContext {
  llm: {
    complete(req: { system: string; turns: Turn[]; tools?: ToolDefinition[]; model?: string; maxTokens?: number; signal?: AbortSignal }): Promise<Completion>
  }
  tools: {
    list(filter?: { connections?: string[] }): Promise<ToolEntry[]>
    call(id: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<{ text: string; isError: boolean }>
  }
  state: {
    get(path: string): Promise<unknown>
  }
}

export interface RunIo {
  /** Writes the message as it stands; `final` is its last write. */
  save(message: AnalystMessage, final: boolean): Promise<void>
  saveResult(ref: string, text: string): Promise<void>
  readResult(ref: string): Promise<string>
  /** What came into the room since the analyst last looked, as a turn for the model; null when nothing did. */
  news(): Promise<string | null>
  /** Milliseconds, for spacing the writes. */
  now(): number
  /** An ISO timestamp. */
  iso(): string
}

export interface RunJob {
  message: AnalystMessage
  analyst: Analyst
  system: string
  /** The first user turn: the thread so far and the message for this analyst. */
  firstTurn: string
  /** What the room is called, for the caption the server puts on the citations. */
  title: string
  /** The workspace the user asked from, whose views read_workspace reads; null offers no read_workspace. */
  workspace: string | null
}

/** The kept tool results a model is shown before the oldest large ones become stubs. */
const RESULTS_BUDGET = 120_000
const KEEP_NEWEST = 4
const EVICT_MIN = 2000
const FETCH_PAGE = 20_000
/** What read_workspace shows of a view's text at once. */
const TEXT_PAGE = 20_000
const SAVE_EVERY_MS = 500
/** The connection tool that verifies quotes and links them. The room calls it; the analyst never sees it. */
const RESOLVER = 'show_citations'
const CLAIMS_PER_CALL = 60
/** Rounds the repair of an answer's citations may take, tool calls included. */
const REPAIR_ROUNDS = 4

const FETCH_RESULT: ToolDefinition = {
  name: 'fetch_result',
  description: 'Read back a tool result that was replaced by a stub, 20,000 characters at a time, from offset.',
  parameters: {
    type: 'object',
    properties: { ref: { type: 'string', description: 'The ref in the stub, like r7.' }, offset: { type: 'integer', minimum: 0 } },
    required: ['ref'],
  },
}

const READ_WORKSPACE: ToolDefinition = {
  name: 'read_workspace',
  description:
    "Read what the views on the user's workspace show. panels lists them: element id, view, a line on what each shows, and textLength when it has text. panels/<id>/output is what one is showing now, panels/<id>/state what it is set to, panels/<id>/summary its line; a key path after output or state reads one part, like panels/e1/output/tickers. panels/<id>/text is the whole of what a view shows as text, like a call transcript, 20,000 characters at a time from offset; quote it with <cite panel=\"<id>\" quote=\"…\">.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'panels, or panels/<id>/output, /state, /summary, or /text, like panels/e1/output.' },
      offset: { type: 'integer', minimum: 0, description: 'For panels/<id>/text: the character to read from, as the last part said.' },
    },
    required: ['path'],
  },
}

export async function runAnalyst(ctx: RunnerContext, job: RunJob, io: RunIo, signal: AbortSignal): Promise<AnalystMessage> {
  const { analyst } = job
  const message: AnalystMessage = { ...job.message, status: 'working', startedAt: io.iso(), error: null, citations: [], audit: null }
  let lastSave = Number.NEGATIVE_INFINITY
  const save = async (final: boolean): Promise<void> => {
    const now = io.now()
    if (!final && now - lastSave < SAVE_EVERY_MS) return
    lastSave = now
    await io.save(message, final)
  }
  const end = async (status: AnalystMessage['status'], error: string | null = null): Promise<AnalystMessage> => {
    message.status = status
    message.error = error
    message.endedAt = io.iso()
    await save(true)
    return message
  }

  let tools = new Map<string, { name: string; entry: ToolEntry }>()
  let resolverId: string | null = null
  let turns: Turn[] = [{ role: 'user', text: job.firstTurn }]
  const refs = new Map<string, { ref: string; tool: string; args: string }>()
  /** Views' texts as the analyst read them, by the id it named the panel by: what its quotes are checked against. */
  const read = new Map<string, string>()
  let nextRef = 1
  /** Where the answer proper starts in the message's text: what the audit reads and a repair replaces. */
  let draftStart = 0

  /** One model call over the turns as they stand, results past the budget stubbed first. */
  async function complete(definitions: ToolDefinition[]): Promise<Completion> {
    turns = evictResults(turns, refs, { budget: RESULTS_BUDGET, keepNewest: KEEP_NEWEST, minSize: EVICT_MIN })
    const reply = await ctx.llm.complete({ system: job.system, turns, tools: definitions, model: analyst.model ?? undefined, signal })
    message.usage = { input: message.usage.input + reply.usage.input, output: message.usage.output + reply.usage.output }
    message.turns += 1
    turns.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw })
    return reply
  }

  /** The calls of one reply, run together; each becomes a step at `at` and a saved result. */
  async function runCalls(calls: ToolCall[], at: number): Promise<void> {
    const steps = calls.map((call) => {
      const step = { ...stepFor(message.text, call.name, call.input), at }
      message.steps.push(step)
      return step
    })
    await save(false)
    const results = await Promise.all(
      calls.map(async (call, i): Promise<ToolResult> => {
        const step = steps[i]!
        const { text, isError } = await runCall(call)
        step.isError = isError
        step.summary = resultSummary(text, isError)
        if (call.name !== FETCH_RESULT.name && !isError) {
          const ref = `r${nextRef++}`
          step.ref = ref
          refs.set(call.id, { ref, tool: call.name, args: step.args })
          await io.saveResult(ref, text)
        }
        return { callId: call.id, output: text, isError }
      }),
    )
    turns.push({ role: 'tool', results })
  }

  /** Every citation in the text, a view's checked here and a filing's by the server. */
  async function resolve(numbered: NumberedCitation[]): Promise<Citation[]> {
    const views = numbered.filter((c) => citedPanel(c.attrs) !== null)
    const filings = numbered.filter((c) => citedPanel(c.attrs) === null)
    return [...(await resolveViews(views)), ...(await resolveFilings(filings))].sort((a, b) => a.n - b.n)
  }

  /**
   * Quotes from views' texts, found in the text as the analyst read it, which stands even if the user
   * has since opened something else there; a panel it never read is checked against its text now.
   */
  async function resolveViews(numbered: NumberedCitation[]): Promise<Citation[]> {
    const texts = new Map(read)
    for (const panel of new Set(numbered.map((c) => citedPanel(c.attrs)!))) {
      if (texts.has(panel) || job.workspace === null) continue
      try {
        const value = await ctx.state.get(`workspaces/${job.workspace}/panels/${panel}/text`)
        if (typeof value === 'string') texts.set(panel, value)
      } catch {
        // A panel that is gone, or never was, has no text to find the quote in.
      }
    }
    return resolveViewCitations(numbered, texts)
  }

  /**
   * Citations of filings, with the server's verdict on each when a server can give one. The server
   * answers once per source, so two quotes from one chunk go in separate calls.
   */
  async function resolveFilings(numbered: NumberedCitation[]): Promise<Citation[]> {
    if (numbered.length === 0) return []
    if (!resolverId) return resolveCitations(numbered, [])
    const batches: NumberedCitation[][] = []
    for (const citation of numbered) {
      let batch = batches.find((b) => b.length < CLAIMS_PER_CALL && !b.some((c) => c.key === citation.key))
      if (!batch) batches.push((batch = []))
      batch.push(citation)
    }
    const resolved: Citation[] = []
    for (const batch of batches) {
      let found: ServerRef[] = []
      try {
        const result = await ctx.tools.call(resolverId, { claims: claimsFor(batch), title: job.title }, { signal })
        if (!result.isError) found = readShowCitations(result.text)
      } catch {
        // A server that cannot answer now leaves these unchecked rather than losing the answer.
      }
      resolved.push(...resolveCitations(batch, found))
    }
    return resolved
  }

  /** The citations checked and the uncited sentences counted, as the message carries them. */
  async function audit(): Promise<{ uncited: string[]; unverified: Citation[] }> {
    message.citations = await resolve(numberCitations(message.text))
    const uncited = uncitedSentences(message.text.slice(draftStart))
    const unverified = message.citations.filter((c) => c.verified === false)
    message.audit = { uncited: uncited.length, unverified: unverified.length, repaired: message.audit?.repaired ?? false }
    return { uncited, unverified }
  }

  /**
   * The answer's citations checked and its uncited sentences found; when either turns something
   * up and a repair is allowed, the draft goes back to the model once and is checked again.
   */
  async function finalize(definitions: ToolDefinition[], allowRepair: boolean): Promise<void> {
    const first = await audit()
    const repair = buildRepairMessage({
      uncited: first.uncited,
      unverified: first.unverified.map((c) => ({
        n: c.n,
        tag: c.panel
          ? `<cite panel="${c.panel}">`
          : c.sectionKey !== null
            ? `<dbcitation document_id="${c.documentId}" section_key="${c.sectionKey}">`
            : `<cite document_id="${c.documentId}" chunk_id="${c.chunkId ?? 'N/A'}">`,
        quote: c.quote,
        reason: c.panel ? `quote not found in the text of ${c.panel}` : 'quote not found in the source',
      })),
    })
    if (!allowRepair || repair === null || signal.aborted) return
    await save(false)
    message.audit = { ...message.audit!, repaired: true }
    turns.push({ role: 'user', text: repair })
    let replaced = false
    for (let round = 1; round <= REPAIR_ROUNDS && !signal.aborted; round++) {
      let reply: Completion
      try {
        reply = await complete(definitions)
      } catch {
        break // the draft stands as it was
      }
      if (reply.toolCalls.length === 0) {
        if (reply.text.trim()) {
          message.text = message.text.slice(0, draftStart) + reply.text.trim()
          replaced = true
        }
        break
      }
      // A source re-read while repairing sits with the answer, not after it.
      await runCalls(reply.toolCalls, draftStart)
    }
    if (replaced) await audit()
  }

  try {
    const entries = await ctx.tools.list(analyst.connections.length > 0 ? { connections: analyst.connections } : undefined)
    tools = named(entries, analyst)
    resolverId = entries.find((e) => e.name === RESOLVER && (analyst.connections.length === 0 || analyst.connections.includes(e.connection)))?.id ?? null
    const definitions = [
      ...[...tools.values()].map(({ name, entry }) => ({ name, description: entry.description, parameters: entry.parameters })),
      FETCH_RESULT,
      ...(job.workspace !== null ? [READ_WORKSPACE] : []),
    ]
    await save(true)

    for (let round = 1; round <= analyst.maxTurns; round++) {
      if (signal.aborted) return end('stopped', reasonOf(signal))
      // What the other analysts finished and the user said since the last call, before this one.
      const news = await io.news()
      if (news) turns.push({ role: 'user', text: news })
      let reply: Completion
      try {
        reply = await complete(definitions)
      } catch (err) {
        if (signal.aborted) return end('stopped', reasonOf(signal))
        return end('error', messageOf(err))
      }
      if (reply.text.trim()) {
        draftStart = message.text ? message.text.length + 2 : 0
        message.text = message.text ? `${message.text}\n\n${reply.text.trim()}` : reply.text.trim()
      }
      if (reply.toolCalls.length === 0) {
        await finalize(definitions, true)
        return end('done')
      }
      await runCalls(reply.toolCalls, message.text.length)
      if (signal.aborted) return end('stopped', reasonOf(signal))
      await save(false)
    }
    // The last text the model wrote is what there is to check; no repair, the turns are spent.
    await finalize(definitions, false)
    message.text = `${message.text ? `${message.text}\n\n` : ''}Stopped at the ${analyst.maxTurns}-turn limit. Ask a follow-up to carry on.`
    return end('done')
  } catch (err) {
    if (signal.aborted) return end('stopped', reasonOf(signal))
    return end('error', messageOf(err))
  }

  /** One call: a connection tool, a stubbed result read back, or a read of the workspace. Failures go to the model as errors. */
  async function runCall(call: ToolCall): Promise<{ text: string; isError: boolean }> {
    try {
      if (call.name === READ_WORKSPACE.name && job.workspace !== null) return await readWorkspace(job.workspace, call.input)
      if (call.name === FETCH_RESULT.name) {
        const ref = typeof call.input['ref'] === 'string' ? call.input['ref'] : ''
        const offset = typeof call.input['offset'] === 'number' && call.input['offset'] > 0 ? Math.floor(call.input['offset']) : 0
        const saved = await io.readResult(ref)
        if (!saved) return { text: `No saved result ${ref}.`, isError: true }
        return { text: saved.slice(offset, offset + FETCH_PAGE) || `Nothing past offset ${offset}; the result is ${saved.length} characters.`, isError: false }
      }
      const tool = tools.get(call.name)
      if (!tool) return { text: `Unknown tool ${call.name}.`, isError: true }
      return await ctx.tools.call(tool.entry.id, call.input, { signal })
    } catch (err) {
      return { text: messageOf(err), isError: true }
    }
  }

  /**
   * One read on the workspace the user asked from, kept to its panels. A key with nothing in it is an
   * answer, not an error. A view's text comes a part at a time, as it reads rather than as JSON, so a
   * quote copies out of it as written; the whole of it is kept for checking those quotes.
   */
  async function readWorkspace(workspace: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const path = typeof input['path'] === 'string' ? input['path'].trim().replace(/^\/+|\/+$/g, '') : ''
    if (path !== 'panels' && !path.startsWith('panels/')) {
      return { text: `read_workspace reads panels, or panels/<id>/output, /state, /summary, or /text, like panels/e1/output; ${path ? `not ${path}` : 'give it a path'}.`, isError: true }
    }
    const value = await ctx.state.get(`workspaces/${workspace}/${path}`)
    const panel = /^panels\/([^/]+)\/text$/.exec(path)?.[1]
    if (panel && typeof value === 'string') {
      read.set(panel, value)
      const offset = Number(input['offset'] ?? 0)
      return { text: textPart(path, value, Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0), isError: false }
    }
    return { text: value === null || value === undefined ? `Nothing at ${path}.` : JSON.stringify(value), isError: false }
  }
}

/** One part of a view's text, under a line saying where it sits in the whole and how to read on. */
function textPart(path: string, text: string, offset: number): string {
  const from = Math.min(offset, text.length)
  const to = Math.min(from + TEXT_PAGE, text.length)
  const count = (n: number): string => n.toLocaleString('en-US')
  const where = `${path}, characters ${count(from)} to ${count(to)} of ${count(text.length)}`
  return `${where}${to < text.length ? `; read on with offset ${to}.` : ', the end.'}\n\n${text.slice(from, to)}`
}

/**
 * The analyst's tools by the name the model calls them: the tool's own name, or the connection and
 * the name when two connections offer the same one, the connection's slash written as `__` too.
 * Limited to its connections and its tool list. The citation resolver is not among them: the room
 * calls that one.
 */
function named(entries: ToolEntry[], analyst: Analyst): Map<string, { name: string; entry: ToolEntry }> {
  const allowed = entries.filter(
    (e) =>
      e.name !== RESOLVER &&
      (analyst.connections.length === 0 || analyst.connections.includes(e.connection)) &&
      (analyst.tools.length === 0 || analyst.tools.includes(e.name)),
  )
  const count = new Map<string, number>()
  for (const e of allowed) count.set(e.name, (count.get(e.name) ?? 0) + 1)
  const tools = new Map<string, { name: string; entry: ToolEntry }>()
  for (const entry of allowed) {
    const name = (count.get(entry.name) ?? 0) > 1 ? `${entry.connection.replace(/\//g, '__')}__${entry.name}` : entry.name
    tools.set(name, { name, entry })
  }
  return tools
}

function reasonOf(signal: AbortSignal): string {
  return errorText(signal.reason, 'stopped')
}

function messageOf(err: unknown): string {
  return errorText(err, 'failed')
}
