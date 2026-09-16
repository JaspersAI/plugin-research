import type { BackendContext } from '@jaspers-ai/sdk'
import { loadAnalysts } from './analyst-files'
import { resolveAnalysts, type Analyst } from './analysts'
import { systemPrompt, type PromptInput } from './prompt'
import {
  claimWorkspace,
  nextSeq,
  onWorkspace,
  outputOf,
  roomIdFor,
  roomNews,
  seqFile,
  shownOf,
  threadText,
  transcript,
  type AnalystMessage,
  type Message,
  type Room,
  type RoomOutput,
  type UserMessage,
} from './room'
import { runAnalyst } from './runner'

// Rooms on disk, and the analysts' work on them. A room is rooms/<id>/room.json and one file per
// message; this host keeps the rooms it has touched in memory, publishes each as live values (the
// room with its message numbers and its output, and every message under its own key), and runs one
// job per analyst per message. An analyst already at work on a room takes its next message after.
// A room belongs to the workspace it was started on: a call from another workspace does not see it,
// and its analysts read the views on its own workspace.

/** What the view reads for a room: the room, its message numbers in order, and what it publishes. */
export interface RoomLive {
  room: Room
  seqs: number[]
  output: RoomOutput
}

const ROOM_ID = /^[a-z0-9][a-z0-9-]*$/

const rooms = new Map<string, { room: Room; messages: Map<number, Message> }>()
/** Messages waiting for their analyst to finish the one before, by room and analyst. */
const queues = new Map<string, number[]>()
/** For each message the user posted, the answers still out, so one notice goes out when all are in. */
const outstanding = new Map<string, Set<number>>()
/** Analyst names as last read, for rosters of analysts that have not answered yet. */
const names = new Map<string, string>()

/** Every analyst, noting their names on the way. */
async function analystsNow(ctx: BackendContext): Promise<Analyst[]> {
  const all = await loadAnalysts(ctx)
  for (const analyst of all) names.set(analyst.id, analyst.name)
  return all
}

/** The rooms of the workspace the call came from, most recently used first. */
export async function listRooms(ctx: BackendContext): Promise<{ id: string; name: string; tickers: string[]; analysts: string[]; working: string[]; updatedAt: string }[]> {
  const entries = await ctx.files.list('rooms')
  const found: Room[] = []
  for (const entry of entries) {
    if (!entry.dir) continue
    const room = await readJson<Room>(ctx, `${entry.path}/room.json`)
    if (room && onWorkspace(room, ctx.workspace)) found.push(room)
  }
  return found
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((room) => ({
      id: room.id,
      name: room.name,
      tickers: room.tickers,
      analysts: room.analysts,
      working: [...(rooms.get(room.id)?.messages.values() ?? [])].filter(isBusy).map((m) => (m as AnalystMessage).analyst),
      updatedAt: room.updatedAt,
    }))
}

/** A new room. Analysts named loosely are found; any that match no analyst are left out and listed. */
export async function createRoom(
  ctx: BackendContext,
  input: { name: string; analysts: string[]; tickers?: string[] },
): Promise<{ room: Room; unmatched: string[] }> {
  const name = input.name.trim()
  if (!name) throw new Error('A room needs a name.')
  const { ids: analysts, unmatched } = usable(await analystsNow(ctx), input.analysts)
  const now = new Date().toISOString()
  const room: Room = {
    id: roomIdFor(name, Math.random().toString(36).slice(2, 6).padEnd(4, '0')),
    name,
    tickers: tickers(input.tickers),
    analysts,
    createdAt: now,
    updatedAt: now,
    ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
  }
  rooms.set(room.id, { room, messages: new Map() })
  await writeRoom(ctx, room)
  return { room, unmatched }
}

export async function updateRoom(ctx: BackendContext, input: { room: string; name?: string; analysts?: string[]; tickers?: string[] }): Promise<Room> {
  const loaded = await here(ctx, input.room)
  const room: Room = { ...loaded.room, updatedAt: new Date().toISOString() }
  if (input.name !== undefined && input.name.trim()) room.name = input.name.trim()
  if (input.analysts !== undefined) room.analysts = usable(await analystsNow(ctx), input.analysts).ids
  if (input.tickers !== undefined) room.tickers = tickers(input.tickers)
  loaded.room = room
  await writeRoom(ctx, room)
  return room
}

/** Reads a room into this host and publishes it. The view asks for this when it opens one. */
export async function openRoom(ctx: BackendContext, id: string): Promise<RoomLive> {
  await analystsNow(ctx)
  await here(ctx, id)
  return publishRoom(ctx, id)
}

/**
 * The user's message into the room, and a job for each analyst it is for. Analysts the room does not
 * have yet join it. Returns at once with who is working; the answers arrive in the room.
 */
export async function post(ctx: BackendContext, input: { room: string; text: string; to: string[] }): Promise<string> {
  const loaded = await here(ctx, input.room)
  const text = input.text.trim()
  if (!text) throw new Error('Nothing to post.')
  const all = await analystsNow(ctx)
  const { ids: known, unmatched: unknown } = resolveAnalysts(all, input.to)
  if (known.length === 0) {
    throw new Error(`No analyst to post to. The room has ${loaded.room.analysts.join(', ') || 'none'}; every analyst: ${all.filter((a) => !a.error).map((a) => a.id).join(', ')}.`)
  }
  const joining = known.filter((id) => !loaded.room.analysts.includes(id))
  if (joining.length > 0) {
    loaded.room = { ...loaded.room, analysts: [...loaded.room.analysts, ...joining] }
  }
  loaded.room = { ...loaded.room, updatedAt: new Date().toISOString() }
  await writeRoom(ctx, loaded.room)

  const seq = nextSeq([...loaded.messages.values()])
  // The analysts read the views on the room's own workspace, which is the one the call came from.
  const workspace = loaded.room.workspace ?? (await callerWorkspace(ctx))
  const message: UserMessage = { seq, role: 'user', text, to: known, at: new Date().toISOString(), ...(workspace ? { workspace } : {}) }
  await saveMessage(ctx, loaded.room.id, message)
  const answers = new Set<number>()
  const queued: string[] = []
  for (const [i, id] of known.entries()) {
    const analyst = all.find((a) => a.id === id)!
    const answer: AnalystMessage = {
      seq: seq + 1 + i,
      role: 'analyst',
      analyst: id,
      name: analyst.name,
      color: analyst.color,
      inReplyTo: seq,
      status: 'queued',
      text: '',
      steps: [],
      files: [],
      citations: [],
      audit: null,
      turns: 0,
      error: null,
      usage: { input: 0, output: 0 },
      startedAt: null,
      endedAt: null,
    }
    answers.add(answer.seq)
    await saveMessage(ctx, loaded.room.id, answer)
    if (!schedule(ctx, loaded.room.id, answer)) queued.push(analyst.name)
  }
  outstanding.set(`${loaded.room.id}/${seq}`, answers)
  const addressed = known.map((id) => all.find((a) => a.id === id)!.name)
  return [
    `Posted to ${loaded.room.name}. Working: ${addressed.join(', ')}.`,
    queued.length > 0 ? `${queued.join(', ')} ${queued.length === 1 ? 'is' : 'are'} finishing an earlier message first.` : '',
    joining.length > 0 ? `Added to the room: ${joining.join(', ')}.` : '',
    unknown.length > 0 ? `Not analysts: ${unknown.join(', ')}.` : '',
    'The answers arrive in the room.',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Stops the room's work, or one analyst's: running answers keep what they have, queued ones end. */
export async function stop(ctx: BackendContext, input: { room: string; analyst?: string }): Promise<string> {
  const loaded = await here(ctx, input.room)
  const reason = 'stopped by the user'
  let stopped = 0
  for (const message of loaded.messages.values()) {
    if (message.role !== 'analyst' || (input.analyst && message.analyst !== input.analyst)) continue
    if (message.status === 'queued') {
      queues.delete(`${loaded.room.id}/${message.analyst}`)
      await finish(ctx, loaded.room.id, { ...message, status: 'stopped', error: reason, endedAt: new Date().toISOString() })
      stopped++
    } else if (message.status === 'working') {
      ctx.jobs.abort(`${loaded.room.id}/${message.analyst}`, reason)
      stopped++
    }
  }
  return stopped === 0 ? 'Nothing was running.' : `Stopped ${stopped} answer${stopped === 1 ? '' : 's'}.`
}

export async function readThread(ctx: BackendContext, input: { room: string; last?: number; analyst?: string }): Promise<string> {
  const loaded = await here(ctx, input.room)
  const byId = Object.fromEntries((await analystsNow(ctx)).map((a) => [a.id, a.name]))
  return threadText(sorted(loaded.messages), byId, { last: input.last, analyst: input.analyst }) || 'The room has no messages yet.'
}

/** At start: answers a dead host left working or queued are over. */
export async function markInterrupted(ctx: BackendContext): Promise<void> {
  for (const entry of await ctx.files.list('rooms')) {
    if (!entry.dir) continue
    for (const file of await ctx.files.list(`${entry.path}/messages`)) {
      const message = await readJson<Message>(ctx, file.path)
      if (message?.role === 'analyst' && (message.status === 'working' || message.status === 'queued')) {
        const ended: AnalystMessage = { ...message, status: 'stopped', error: 'interrupted: the app closed or the plugin restarted', endedAt: new Date().toISOString() }
        await ctx.files.write(file.path, JSON.stringify(ended, null, 2))
      }
    }
  }
}

/**
 * At start: a room made before rooms belonged to a workspace is given the workspace its first message
 * came from, while that workspace is still there, else the one on screen. It only adds the field.
 */
export async function claimRooms(ctx: BackendContext): Promise<void> {
  const exists = new Map<string, boolean>()
  let onScreen: string | null | undefined
  for (const entry of await ctx.files.list('rooms')) {
    if (!entry.dir) continue
    const room = await readJson<Room>(ctx, `${entry.path}/room.json`)
    if (!room || typeof room.workspace === 'string') continue
    const messages: Message[] = []
    for (const file of await ctx.files.list(`${entry.path}/messages`)) {
      const message = await readJson<Message>(ctx, file.path)
      if (message) messages.push(message)
    }
    for (const message of messages) {
      if (message.role !== 'user' || !message.workspace || exists.has(message.workspace)) continue
      exists.set(message.workspace, await workspaceExists(ctx, message.workspace))
    }
    const known = new Set([...exists].filter(([, found]) => found).map(([id]) => id))
    onScreen ??= (await callerWorkspace(ctx)) ?? null
    const workspace = claimWorkspace(messages, known, onScreen)
    if (workspace) await ctx.files.write(`${entry.path}/room.json`, JSON.stringify({ ...room, workspace }, null, 2))
  }
}

/** A room a call may reach: its workspace's own. Another's reads as no room, which the view takes as the list. */
async function here(ctx: BackendContext, id: string): Promise<{ room: Room; messages: Map<number, Message> }> {
  const loaded = await load(ctx, id)
  if (!onWorkspace(loaded.room, ctx.workspace)) throw new Error(`No room ${id} on this workspace. Call research__rooms for the rooms here.`)
  return loaded
}

/** Throws unless the call may reach the room, for a source that works on its folder rather than its thread. */
export async function checkRoomHere(ctx: BackendContext, id: string): Promise<void> {
  await here(ctx, id)
}

/** Starts an answer's job now, or queues it behind the analyst's current one. True when it started. */
function schedule(ctx: BackendContext, roomId: string, message: AnalystMessage): boolean {
  const key = `${roomId}/${message.analyst}`
  if (ctx.jobs.running().includes(key)) {
    queues.set(key, [...(queues.get(key) ?? []), message.seq])
    return false
  }
  ctx.jobs.start(key, async (signal) => {
    try {
      await answer(ctx, roomId, message.seq, signal)
    } finally {
      // The job's key is released after this returns, so the next message starts a turn later.
      setTimeout(() => {
        const queue = queues.get(key) ?? []
        const next = queue.shift()
        if (queue.length === 0) queues.delete(key)
        const waiting = next === undefined ? undefined : rooms.get(roomId)?.messages.get(next)
        if (waiting?.role === 'analyst' && waiting.status === 'queued') schedule(ctx, roomId, waiting)
      }, 0)
    }
  })
  return true
}

/** One analyst answering one message, from the files as they are now. */
async function answer(ctx: BackendContext, roomId: string, seq: number, signal: AbortSignal): Promise<void> {
  const loaded = await load(ctx, roomId)
  const message = loaded.messages.get(seq)
  if (message?.role !== 'analyst' || message.status !== 'queued') return
  const all = await analystsNow(ctx)
  const analyst = all.find((a) => a.id === message.analyst)
  const asked = loaded.messages.get(message.inReplyTo)
  if (!analyst || analyst.error || asked?.role !== 'user') {
    await finish(ctx, roomId, { ...message, status: 'error', error: analyst?.error ?? `No analyst ${message.analyst}.`, endedAt: new Date().toISOString() })
    return
  }
  const connections = await ctx.tools.connections(analyst.connections.length > 0 ? { connections: analyst.connections } : undefined)
  const roster = loaded.room.analysts.map((id) => all.find((a) => a.id === id)).filter((a): a is Analyst => a !== undefined)
  const workspaceId = asked.workspace ?? null
  const workspace = workspaceId ? await workspaceOf(ctx, workspaceId) : null
  const system = systemPrompt({
    analyst,
    room: loaded.room,
    roster: roster.map((a) => ({ id: a.id, name: a.name, description: a.description })),
    connections,
    workspace,
    today: new Date().toISOString().slice(0, 10),
  })
  // The whole room now, and after that whatever lands in it while this analyst works.
  const labels = Object.fromEntries(all.map((a) => [a.id, a.name]))
  const thread = sorted(loaded.messages)
  const firstTurn = transcript({ messages: thread, names: labels, analyst: analyst.id, message: asked, answer: seq })
  const shown = shownOf(thread)
  const results = `rooms/${roomId}/sandbox/data`
  const ended = await runAnalyst(
    ctx,
    { message, analyst, system, firstTurn, title: loaded.room.name, workspace: workspace ? workspaceId : null },
    {
      save: (m) => saveMessage(ctx, roomId, m),
      saveResult: (ref, text) => ctx.files.write(`${results}/${seq}-${ref}.txt`, text),
      readResult: (ref) => ctx.files.read(`${results}/${seq}-${ref}.txt`).catch(() => ''),
      news: async () => roomNews({ messages: sorted((rooms.get(roomId) ?? loaded).messages), names: labels, message: asked, answer: seq, shown }),
      now: () => Date.now(),
      iso: () => new Date().toISOString(),
    },
    signal,
  )
  await finish(ctx, roomId, ended)
}

/** An answer's last write, and the notice when it was the last one its question was waiting on. */
async function finish(ctx: BackendContext, roomId: string, message: AnalystMessage): Promise<void> {
  await saveMessage(ctx, roomId, message)
  const key = `${roomId}/${message.inReplyTo}`
  const waiting = outstanding.get(key)
  if (!waiting) return
  waiting.delete(message.seq)
  if (waiting.size > 0) return
  outstanding.delete(key)
  const loaded = rooms.get(roomId)
  if (!loaded) return
  const answers = [...loaded.messages.values()].filter((m): m is AnalystMessage => m.role === 'analyst' && m.inReplyTo === message.inReplyTo)
  // Stopping them was the user's own doing; that needs no notice.
  if (answers.every((m) => m.status === 'stopped')) return
  const named = (status: AnalystMessage['status']): string[] => answers.filter((m) => m.status === status).map((m) => m.name)
  const parts = [
    named('done').length > 0 ? `${list(named('done'))} answered` : '',
    named('error').length > 0 ? `${list(named('error'))} failed` : '',
    named('stopped').length > 0 ? `${list(named('stopped'))} stopped` : '',
  ].filter(Boolean)
  ctx.notify(`${loaded.room.name}: ${parts.join('; ')}.`)
}

async function saveMessage(ctx: BackendContext, roomId: string, message: Message): Promise<void> {
  const loaded = rooms.get(roomId)
  if (!loaded) return
  loaded.messages.set(message.seq, message)
  await ctx.files.write(`rooms/${roomId}/messages/${seqFile(message.seq)}`, JSON.stringify(message, null, 2))
  ctx.live.set(`rooms/${roomId}/m/${message.seq}`, message)
  publishRoom(ctx, roomId)
}

async function writeRoom(ctx: BackendContext, room: Room): Promise<void> {
  await ctx.files.write(`rooms/${room.id}/room.json`, JSON.stringify(room, null, 2))
  publishRoom(ctx, room.id)
}

function publishRoom(ctx: BackendContext, roomId: string): RoomLive {
  const loaded = rooms.get(roomId)!
  const messages = sorted(loaded.messages)
  const roster = loaded.room.analysts.map((id) => ({ id, name: names.get(id) ?? id }))
  const live: RoomLive = { room: loaded.room, seqs: messages.map((m) => m.seq), output: outputOf(loaded.room, messages, roster) }
  ctx.live.set(`rooms/${roomId}`, live)
  return live
}

async function load(ctx: BackendContext, id: string): Promise<{ room: Room; messages: Map<number, Message> }> {
  if (typeof id !== 'string' || !ROOM_ID.test(id)) throw new Error(`No room ${String(id)}.`)
  const cached = rooms.get(id)
  if (cached) return cached
  const room = await readJson<Room>(ctx, `rooms/${id}/room.json`)
  if (!room) throw new Error(`No room ${id}. Call research__rooms for the rooms there are.`)
  const messages = new Map<number, Message>()
  for (const file of await ctx.files.list(`rooms/${id}/messages`)) {
    const message = await readJson<Message>(ctx, file.path)
    if (message && typeof message.seq === 'number') messages.set(message.seq, message)
  }
  const loaded = { room, messages }
  rooms.set(id, loaded)
  for (const message of messages.values()) ctx.live.set(`rooms/${id}/m/${message.seq}`, message)
  return loaded
}

/**
 * The workspace the call came from, or the one on screen when nobody said: undefined when the tree
 * cannot be read, which leaves the analysts without it.
 */
async function callerWorkspace(ctx: BackendContext): Promise<string | undefined> {
  if (ctx.workspace) return ctx.workspace
  try {
    const workspace = (await ctx.state.get('workspace')) as { id?: unknown } | null
    return typeof workspace?.id === 'string' ? workspace.id : undefined
  } catch {
    return undefined
  }
}

/** Whether a workspace is still there. */
async function workspaceExists(ctx: BackendContext, id: string): Promise<boolean> {
  try {
    await ctx.state.get(`workspaces/${id}/workspace`)
    return true
  } catch {
    return false
  }
}

/** A workspace by id, with the views open on it now, for the prompt; null when it is gone or cannot be read. */
async function workspaceOf(ctx: BackendContext, id: string): Promise<PromptInput['workspace']> {
  try {
    const { name } = (await ctx.state.get(`workspaces/${id}/workspace`)) as { name: string }
    const panels = (await ctx.state.get(`workspaces/${id}/panels`)) as { elementId: string; view: string | null; summary: string | null; textLength?: number | null }[]
    return { name, panels: panels.map((p) => ({ id: p.elementId, view: p.view, summary: p.summary, textLength: p.textLength ?? null })) }
  } catch {
    return null
  }
}

/** The working analysts a list names, found loosely. A list that names none of them is refused, with the ones there are. */
function usable(all: Analyst[], requested: string[]): { ids: string[]; unmatched: string[] } {
  const found = resolveAnalysts(all, requested)
  if (found.ids.length === 0) {
    throw new Error(`No analyst matches ${requested.join(', ') || 'nothing'}. The analysts are ${all.filter((a) => !a.error).map((a) => a.id).join(', ')}.`)
  }
  return found
}

function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function tickers(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean))]
}

function sorted(messages: Map<number, Message>): Message[] {
  return [...messages.values()].sort((a, b) => a.seq - b.seq)
}

function isBusy(message: Message): boolean {
  return message.role === 'analyst' && (message.status === 'working' || message.status === 'queued')
}

async function readJson<T>(ctx: BackendContext, path: string): Promise<T | null> {
  try {
    return JSON.parse(await ctx.files.read(path)) as T
  } catch {
    return null
  }
}
