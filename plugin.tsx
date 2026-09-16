import { defineConnection, definePlugin, defineSource, defineView } from '@jaspers-ai/sdk'
import { z } from 'zod'
import { loadAnalysts, publishAnalysts, saveAnalyst } from './analyst-files'
import { summaryOf, type AnalystInput } from './analysts'
import { errorText } from './errors'
import { INSTRUCTIONS } from './instructions'
import { roomSummary, type RoomOutput } from './room'
import { checkRoomHere, claimRooms, createRoom, listRooms, markInterrupted, openRoom, post, readThread, stop, updateRoom } from './rooms'
import { RoomView } from './RoomView'

// Research rooms: a thread and a roster of analysts who research in parallel over the Jaspers research
// MCP (its own connection, research/jaspers, with its own Jaspers API key), reading what the other views on the user's workspace show. The user talks to a room through
// the orchestrator, whose tools are these sources; the analysts run as jobs in this plugin's host,
// and the room view renders the thread from live values.

const ROOM_ID = z.string().describe('The room id, as research__rooms and the room view output name it.')

const rooms = defineSource({
  description:
    'The research rooms on this workspace, most recently used first: id, name, tickers, analysts, and who is working. A room belongs to the workspace it was started on. A research room is for questions to research in depth in filings and data; finding or filtering companies is the screener\'s job. To start a new room, do not call this: call research__analysts for the analyst ids, then place_view { view: "research/room", state: { start: { name, analysts, tickers, ask } } } and the view creates it. Start it with one analyst, the best fit for the question, unless the user explicitly asks for more than one.',
  input: z.object({}),
  ttlMs: 0,
  run: async (_args, ctx) => listRooms(ctx),
})

/** For the view: a room is started by placing the view with state.start, which runs this. */
const createRoomSource = defineSource({
  description: 'Create a research room. The room view runs this for state.start.',
  input: z.object({ name: z.string(), analysts: z.array(z.string()), tickers: z.array(z.string()).optional() }),
  internal: true,
  run: async (args, ctx) => {
    const { room, unmatched } = await createRoom(ctx, args as { name: string; analysts: string[]; tickers?: string[] })
    return { room: room.id, name: room.name, analysts: room.analysts, unmatched }
  },
})

const updateRoomSource = defineSource({
  description: "Change a research room's name, its whole analysts list, or its tickers.",
  input: z.object({ room: ROOM_ID, name: z.string().optional(), analysts: z.array(z.string()).optional(), tickers: z.array(z.string()).optional() }),
  run: async (args, ctx) => {
    const room = await updateRoom(ctx, args as { room: string; name?: string; analysts?: string[]; tickers?: string[] })
    return `Room ${room.id} is ${room.name}, with ${room.analysts.join(', ') || 'no analysts'}${room.tickers.length ? ` on ${room.tickers.join(', ')}` : ''}.`
  },
})

const postSource = defineSource({
  description:
    "Put the user's message into an open research room for the named analysts. room is the id in the room view's state.room; text is the user's own words, pointing at a view as they did (\"the companies in my screener\"), since the analysts read what the views on this workspace show; to is analyst ids (an analyst not yet in the room joins it). Returns at once; the answers arrive in the room. Never answer the research question yourself. With no room open yet, start one instead: place_view { view: 'research/room', state: { start: { name, analysts, tickers, ask } } }, where ask is this message and analysts is one id from research__analysts, the best fit, unless the user explicitly asked for more than one. Not for finding or filtering companies: that is the screener.",
  input: z.object({ room: ROOM_ID, text: z.string(), to: z.array(z.string()) }),
  run: async (args, ctx) => post(ctx, args as { room: string; text: string; to: string[] }),
})

const stopSource = defineSource({
  description: "Stop a research room's analysts, or one of them. Partial answers are kept.",
  input: z.object({ room: ROOM_ID, analyst: z.string().optional() }),
  run: async (args, ctx) => stop(ctx, args as { room: string; analyst?: string }),
})

const thread = defineSource({
  description: "Read back a research room's messages as text, every one whole with all its sources, for when the user asks what the analysts found. last limits it to the most recent few; analyst to one analyst's.",
  input: z.object({ room: ROOM_ID, last: z.number().int().positive().optional(), analyst: z.string().optional() }),
  ttlMs: 0,
  run: async (args, ctx) => readThread(ctx, args as { room: string; last?: number; analyst?: string }),
})

const openFile = defineSource({
  description: "Open a file an analyst made in a research room, like output/FLWS Debt Waterfall.xlsx, in its default app.",
  input: z.object({ room: ROOM_ID, path: z.string() }),
  run: async (args, ctx) => {
    const { room, path } = args as { room: string; path: string }
    await checkRoomHere(ctx, room)
    await ctx.files.open(`rooms/${room}/sandbox/${path}`)
    return `Opened ${path}.`
  },
})

const loadRoom = defineSource({
  description: 'Load a research room for its view.',
  input: z.object({ room: ROOM_ID }),
  internal: true,
  ttlMs: 0,
  run: async (args, ctx) => {
    const live = await openRoom(ctx, (args as { room: string }).room)
    return `Loaded ${live.room.id}.`
  },
})

const reveal = defineSource({
  description: "Show a research room's folder, or one file in it, in the Finder.",
  input: z.object({ room: ROOM_ID, path: z.string().optional() }),
  internal: true,
  run: async (args, ctx) => {
    const { room, path } = args as { room: string; path?: string }
    await checkRoomHere(ctx, room)
    await ctx.files.reveal(path ? `rooms/${room}/sandbox/${path}` : `rooms/${room}`)
    return 'Shown.'
  },
})

const analysts = defineSource({
  description:
    'The research analysts: id, name, description, model, connections, and any error in the file. With id, that analyst whole, instructions included.',
  input: z.object({ id: z.string().optional() }),
  ttlMs: 0,
  run: async (args, ctx) => {
    const { id } = args as { id?: string }
    const list = await loadAnalysts(ctx)
    if (id === undefined) return list.map(summaryOf)
    const analyst = list.find((a) => a.id === id)
    if (!analyst) throw new Error(`No analyst ${id}. The analysts are ${list.map((a) => a.id).join(', ')}.`)
    return analyst
  },
})

const saveAnalystSource = defineSource({
  description:
    "Create or change a research analyst, saved as analysts/<id>.md in the research folder. id is lower case letters, digits, and dashes; a preset's id replaces that preset. instructions say, in the second person, how the analyst works. To change one, read it with research__analysts { id } first and send it back whole.",
  input: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    model: z.string().optional(),
    connections: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    maxTurns: z.number().int().optional(),
    color: z.string().optional(),
  }),
  run: async (args, ctx) => {
    const input = args as AnalystInput
    await saveAnalyst(ctx, input)
    await publishAnalysts(ctx, false)
    return `Saved ${input.name} as analysts/${input.id}.md.`
  },
})

const Output = z.object({
  room: z.string().nullable(),
  name: z.string().optional(),
  tickers: z.array(z.string()).optional(),
  analysts: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })).optional(),
  last: z.array(z.object({ seq: z.number(), from: z.string(), status: z.string(), excerpt: z.string(), files: z.array(z.string()) })).optional(),
  messages: z.number().optional(),
  files: z.number().optional(),
  available: z.number().optional(),
  starting: z.string().optional(),
  error: z.string().optional(),
})

/** A room to make as the view opens, and optionally the first question for its analysts. */
const Start = z.object({
  name: z.string().describe('What the room is about, like "FLWS refinancing".'),
  analysts: z.array(z.string()).describe('Analyst ids, from research__analysts: one, the best fit for the question, unless the user explicitly asked for more.'),
  tickers: z.array(z.string()).optional(),
  ask: z.string().optional().describe("The user's first question, in their words, posted to every analyst once the room exists."),
})

export default definePlugin({
  id: 'research',
  secrets: { token: { label: 'Jaspers API key' } },
  connections: {
    jaspers: defineConnection({
      url: 'https://analyst-api.jsprai.com/mcp/open',
      auth: 'bearer',
      headers: { Authorization: 'Bearer ${secret:token}' },
      tools: [
        'search_filings',
        'keyword_search_filings',
        'fetch_filings',
        'fetch_chunk',
        'query_filings',
        'aggregate_filings',
        'get_distinct_values',
        'count_filings',
        'get_company_status',
        'get_guide',
        'show_citations',
      ],
    }),
  },
  capabilities: ['llm', 'tools', 'files', 'state'],
  async start(ctx) {
    await markInterrupted(ctx)
    await claimRooms(ctx)
    await publishAnalysts(ctx, false)
    ctx.files.watch('analysts', () => {
      publishAnalysts(ctx, true).catch((err: unknown) => console.warn(`analysts: ${errorText(err, 'failed')}`))
    })
  },
  sources: {
    rooms,
    'create-room': createRoomSource,
    'update-room': updateRoomSource,
    post: postSource,
    stop: stopSource,
    thread,
    'open-file': openFile,
    'load-room': loadRoom,
    reveal,
    analysts,
    'save-analyst': saveAnalystSource,
  },
  views: {
    room: defineView(RoomView, {
      title: 'Research room',
      state: z.object({
        room: z.string().optional().describe('The id of an existing room, as research__rooms lists it. Never made up.'),
        start: Start.optional(),
      }),
      output: Output,
      instructions: INSTRUCTIONS,
      summarize: (_state: unknown, output: (Partial<RoomOutput> & { room: string | null; available?: number; starting?: string; error?: string }) | null) =>
        output?.error
          ? output.error
          : output?.starting
            ? `Starting ${output.starting}…`
            : output?.room
              ? roomSummary(output as RoomOutput)
              : `No room open · ${output?.available ?? 0} analysts`,
    }),
  },
})
