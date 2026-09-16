import { citationLink, numberCitations, numberKey, sourceTitle, toMarkers, type Audit, type Citation } from './citations.ts'

// A research room and its thread, as data: the shapes on disk and in live values, and the pure work
// on them the runner and the view share. How a room is named and numbered, what an analyst is shown
// of the thread, where a tool chip sits, which old tool results make way, and what the orchestrator
// reads back. No files and no model here, so all of it can be read in a test.

export interface Room {
  id: string
  name: string
  tickers: string[]
  /** Analyst ids, in roster order. */
  analysts: string[]
  createdAt: string
  updatedAt: string
  /**
   * The workspace the room belongs to: the one it was started on. It is listed, opened, and posted to
   * from there only. A room made before rooms belonged to one is given one when the plugin starts.
   */
  workspace?: string
}

export interface Step {
  /** The length of the message's text when the call was made: where its chip sits. */
  at: number
  tool: string
  /** The arguments as JSON, cut at 200 characters. */
  args: string
  summary: string | null
  /** The saved result's ref, like r7, once it came back. */
  ref: string | null
  isError: boolean
}

export type MessageStatus = 'queued' | 'working' | 'done' | 'stopped' | 'error'

export interface UserMessage {
  seq: number
  role: 'user'
  text: string
  to: string[]
  at: string
  /** The workspace on screen as the user posted it, whose views the analysts read. */
  workspace?: string
}

export interface AnalystMessage {
  seq: number
  role: 'analyst'
  analyst: string
  name: string
  color: string | null
  inReplyTo: number
  status: MessageStatus
  text: string
  steps: Step[]
  files: { path: string; size: number }[]
  /** The sources the answer cites, numbered as in its text, with the server's verdict on each. */
  citations: Citation[]
  /** What the citation audit found, once the answer was done; null before. */
  audit: Audit | null
  turns: number
  error: string | null
  usage: { input: number; output: number }
  startedAt: string | null
  endedAt: string | null
}

export type Message = UserMessage | AnalystMessage

/** What the room view publishes, for the orchestrator. */
export interface RoomOutput {
  room: string
  name: string
  tickers: string[]
  analysts: { id: string; name: string; status: 'idle' | 'queued' | 'working' }[]
  last: { seq: number; from: string; status: string; excerpt: string; files: string[] }[]
  messages: number
  files: number
}

/** Whether a call may reach a room: one of its own workspace's, or any when the call names no workspace. */
export function onWorkspace(room: Room, workspace: string | null): boolean {
  return workspace === null || room.workspace === workspace
}

/**
 * The workspace for a room made before rooms belonged to one: the workspace its earliest message was
 * posted from, among those still there, else `fallback`.
 */
export function claimWorkspace(messages: Message[], known: ReadonlySet<string>, fallback: string | null): string | null {
  const first = [...messages]
    .sort((a, b) => a.seq - b.seq)
    .find((m): m is UserMessage => m.role === 'user' && typeof m.workspace === 'string' && known.has(m.workspace))
  return first?.workspace ?? fallback
}

/** A tool result as the runner keeps it in the model's turns. */
interface ToolTurn {
  role: 'tool'
  results: { callId: string; output: string; isError: boolean }[]
}

const SLUG_MAX = 40
const ARGS_MAX = 200
const EXCERPT = 300
const OUTPUT_MAX = 4096
const STUB_PREVIEW = 1200

export function roomIdFor(name: string, random: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
  return `${slug || 'room'}-${random}`
}

export function seqFile(seq: number): string {
  return `${String(seq).padStart(6, '0')}.json`
}

export function nextSeq(messages: Message[]): number {
  return messages.reduce((max, m) => Math.max(max, m.seq), 0) + 1
}

/**
 * What an analyst is shown of the thread, as the first user turn: the whole room, every message
 * numbered and labeled with who said it, then the message for this analyst. Only the answer it is
 * writing is left out. One labeled transcript keeps the analysts apart, which unlabeled history does not.
 */
export function transcript(input: {
  messages: Message[]
  names: Record<string, string>
  analyst: string
  message: UserMessage
  /** The seq of the answer this analyst is writing. */
  answer: number
}): string {
  const { messages, names, analyst, message, answer } = input
  const blocks = messages.filter((m) => m.seq !== message.seq && m.seq !== answer).map((m) => messageLine(m, names))
  const lines: string[] = []
  if (blocks.length > 0) {
    lines.push('The room so far:', '')
    for (const block of blocks) lines.push(block, '')
  }
  lines.push(`New message for you, ${names[analyst] ?? analyst}:`, messageLine(message, names))
  return lines.join('\n')
}

/** What an analyst has seen of each message, by seq, as `stateOf` puts it. */
export function shownOf(messages: Message[]): Map<number, string> {
  return new Map(messages.map((m) => [m.seq, stateOf(m)]))
}

/**
 * What came into the room since the analyst last saw it, as a turn for its model: a message it has
 * not seen, or an answer that has finished since it saw it being written. An answer still being
 * written waits until it is done. What comes back is noted in `shown`, so each arrives once.
 */
export function roomNews(input: {
  messages: Message[]
  names: Record<string, string>
  message: UserMessage
  answer: number
  shown: Map<number, string>
}): string | null {
  const { messages, names, message, answer, shown } = input
  const fresh = messages.filter((m) => m.seq !== answer && stateOf(m) !== 'open' && shown.get(m.seq) !== stateOf(m))
  if (fresh.length === 0) return null
  for (const m of fresh) shown.set(m.seq, stateOf(m))
  return [`Room update: these came in while you were working. You are still answering #${message.seq}.`, ...fresh.map((m) => messageLine(m, names))].join('\n\n')
}

/** A step for a call made when the message's text had this much in it. */
export function stepFor(text: string, tool: string, input: Record<string, unknown>): Step {
  return { at: text.length, tool, args: JSON.stringify(input).slice(0, ARGS_MAX), summary: null, ref: null, isError: false }
}

/** One line saying what a tool gave back, for its chip. */
export function resultSummary(text: string, isError: boolean): string {
  if (isError) return `Error: ${(text.split('\n')[0] ?? '').slice(0, 120)}`
  const count = rowCount(text)
  return count === null ? `${text.length.toLocaleString('en-US')} characters` : `${count} result${count === 1 ? '' : 's'}`
}

/**
 * The turns with old, large tool results swapped for stubs until what is kept fits the budget. The
 * newest `keepNewest` results and anything under `minSize` stay whole; a stub names its ref, so the
 * model reads the rest with fetch_result instead of running the search again.
 */
export function evictResults<T extends { role: string }>(
  turns: T[],
  refs: Map<string, { ref: string; tool: string; args: string }>,
  options: { budget: number; keepNewest: number; minSize: number },
): T[] {
  const results = turns.flatMap((turn) => (turn.role === 'tool' ? (turn as unknown as ToolTurn).results : []))
  let kept = results.reduce((sum, r) => sum + (isStub(r.output) ? 0 : r.output.length), 0)
  const protectedIds = new Set(results.slice(-options.keepNewest).map((r) => r.callId))
  const evicted = new Map<string, string>()
  for (const result of results) {
    if (kept <= options.budget) break
    if (protectedIds.has(result.callId) || isStub(result.output) || result.output.length < options.minSize) continue
    const about = refs.get(result.callId)
    if (!about) continue
    evicted.set(
      result.callId,
      `[${about.ref} evicted: ${about.tool} ${about.args}. First ${STUB_PREVIEW} characters: ${result.output.slice(0, STUB_PREVIEW)} … Read the rest with fetch_result("${about.ref}", offset).]`,
    )
    kept -= result.output.length
  }
  if (evicted.size === 0) return turns
  return turns.map((turn) => {
    if (turn.role !== 'tool') return turn
    const tool = turn as unknown as ToolTurn
    if (!tool.results.some((r) => evicted.has(r.callId))) return turn
    return { ...turn, results: tool.results.map((r) => (evicted.has(r.callId) ? { ...r, output: evicted.get(r.callId)! } : r)) }
  })
}

/** What the orchestrator reads: who is in the room and busy, and the last three messages. Within 4 KB. */
export function outputOf(room: Room, messages: Message[], roster: { id: string; name: string }[]): RoomOutput {
  const analysts = roster.map(({ id, name }) => {
    const theirs = messages.filter((m): m is AnalystMessage => m.role === 'analyst' && m.analyst === id)
    const status = theirs.some((m) => m.status === 'working') ? 'working' : theirs.some((m) => m.status === 'queued') ? 'queued' : 'idle'
    return { id, name, status: status as RoomOutput['analysts'][number]['status'] }
  })
  const files = messages.reduce((sum, m) => sum + (m.role === 'analyst' ? m.files.length : 0), 0)
  for (const excerpt of [EXCERPT, 150, 60]) {
    const output: RoomOutput = {
      room: room.id,
      name: room.name,
      tickers: room.tickers,
      analysts,
      last: messages.slice(-3).map((m) => ({
        seq: m.seq,
        from: m.role === 'user' ? 'you' : m.name,
        status: m.role === 'user' ? 'sent' : m.status,
        excerpt: toMarkers(m.text).slice(0, excerpt),
        files: m.role === 'user' ? [] : m.files.map((f) => f.path.slice(f.path.lastIndexOf('/') + 1)),
      })),
      messages: messages.length,
      files,
    }
    if (JSON.stringify(output).length <= OUTPUT_MAX) return output
  }
  return { room: room.id, name: room.name, tickers: room.tickers, analysts, last: [], messages: messages.length, files }
}

/** The one line the model's map carries for a room. */
export function roomSummary(output: RoomOutput): string {
  const busy = output.analysts.filter((a) => a.status !== 'idle').map((a) => `${a.name} ${a.status}`)
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  return [output.name, busy.length > 0 ? busy.join(', ') : 'idle', plural(output.messages, 'msg'), plural(output.files, 'file')].join(' · ')
}

/**
 * The room's messages as text, for "what did they find?": every one, or the last few or one analyst's
 * when asked, each whole, its citation tags shown as [n] markers and every source listed under it
 * with the sec.gov link.
 */
export function threadText(messages: Message[], names: Record<string, string>, options: { last?: number; analyst?: string }): string {
  const chosen = options.analyst ? messages.filter((m) => m.role === 'analyst' && m.analyst === options.analyst) : messages
  return (options.last === undefined ? chosen : chosen.slice(-options.last))
    .map((m) => {
      if (m.role === 'user') return `#${m.seq} ${userLine(m, names)}`
      const text = toMarkers(m.text).trim() || (m.error ? `(error: ${m.error})` : '(nothing yet)')
      const sources = (m.citations ?? []).map((c) => `[${c.n}] ${sourceLine(c)}`)
      return [`#${m.seq} [${m.name}]${statusMark(m)}: ${text}`, ...(sources.length > 0 ? [`Sources: ${sources.join(' ')}`] : [])].join('\n')
    })
    .join('\n\n')
}

/**
 * An answer as the user copies it: what the analyst wrote after its last tool call, since the text
 * before that narrates the research, with its tags as the [n] markers the view shows and the sources
 * those markers point to listed under it. Empty until the answer is in: a draft still being checked
 * may be repaired.
 */
export function answerText(message: AnalystMessage): string {
  if (message.status === 'queued' || message.status === 'working') return ''
  const at = message.steps.reduce((last, step) => Math.max(last, step.at), 0)
  const answer = message.text.slice(at)
  const numbered = numberCitations(message.text)
  const text = toMarkers(answer, numbered).trim()
  if (!text) return ''
  const cited = new Set(numberCitations(answer).map((c) => numberKey(c.attrs)))
  const sources = numbered
    .filter((c) => cited.has(numberKey(c.attrs)))
    .map((c) => {
      const citation = (message.citations ?? []).find((r) => r.n === c.n)
      const link = citation ? citationLink(citation) : null
      return `- [${c.n}] ${sourceTitle(c, citation)}${citation?.verified === false ? ' (quote not found)' : ''}${link ? `: ${link}` : ''}`
    })
  return sources.length > 0 ? `${text}\n\n## Sources\n\n${sources.join('\n')}` : text
}

/** One source in a line: what it is, whether its quote was found, and where it opens. */
function sourceLine(c: Citation): string {
  const state = c.verified === true ? 'verified' : c.verified === false ? 'unverified' : 'unchecked'
  return [c.title ?? `document ${c.documentId}`, state, citationLink(c) ?? ''].filter(Boolean).join(' · ')
}

function userLine(message: UserMessage, names: Record<string, string>): string {
  return `[You → ${message.to.map((id) => names[id] ?? id).join(', ')}]: ${message.text}`
}

/** One message as an analyst reads it: its number, who, and what it says, or where it stands when it says nothing. */
function messageLine(message: Message, names: Record<string, string>): string {
  if (message.role === 'user') return `#${message.seq} ${userLine(message, names)}`
  const text = message.text.trim()
  if (!text) return `#${message.seq} [${message.name}] (${message.status}${message.error ? `: ${message.error}` : ''})`
  return `#${message.seq} [${message.name}]${statusMark(message)}: ${text}`
}

/** Sent for the user's words; for an answer, open while it is queued or being written, final after. */
function stateOf(message: Message): 'sent' | 'open' | 'final' {
  if (message.role === 'user') return 'sent'
  return message.status === 'queued' || message.status === 'working' ? 'open' : 'final'
}

function statusMark(message: AnalystMessage): string {
  return message.status === 'done' ? '' : ` (${message.status})`
}

function isStub(output: string): boolean {
  return /^\[r\d+ evicted: /.test(output)
}

function rowCount(text: string): number | null {
  try {
    const value: unknown = JSON.parse(text)
    if (Array.isArray(value)) return value.length
    if (typeof value === 'object' && value !== null) {
      for (const key of ['rows', 'results', 'items', 'data', 'companies', 'filings']) {
        const rows = (value as Record<string, unknown>)[key]
        if (Array.isArray(rows)) return rows.length
      }
    }
  } catch {
    // Prose, not JSON.
  }
  return null
}
