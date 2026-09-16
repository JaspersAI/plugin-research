import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  answerText,
  claimWorkspace,
  evictResults,
  nextSeq,
  onWorkspace,
  outputOf,
  resultSummary,
  roomIdFor,
  roomNews,
  roomSummary,
  seqFile,
  shownOf,
  stepFor,
  threadText,
  transcript,
  type AnalystMessage,
  type Message,
  type Room,
  type UserMessage,
} from './room.ts'

const NAMES = { credit: 'Credit Analyst', risk: 'Risk Analyst' }
const ROOM: Room = { id: 'flws-credit-7k2p', name: 'FLWS credit', tickers: ['FLWS'], analysts: ['credit', 'risk'], createdAt: '', updatedAt: '' }

function user(seq: number, text: string, to: string[]): UserMessage {
  return { seq, role: 'user', text, to, at: '2026-09-13T10:00:00Z' }
}

function answer(seq: number, analyst: 'credit' | 'risk', text: string, over: Partial<AnalystMessage> = {}): AnalystMessage {
  return {
    seq,
    role: 'analyst',
    analyst,
    name: NAMES[analyst],
    color: null,
    inReplyTo: 1,
    status: 'done',
    text,
    steps: [],
    files: [],
    citations: [],
    audit: null,
    turns: 1,
    error: null,
    usage: { input: 0, output: 0 },
    startedAt: null,
    endedAt: null,
    ...over,
  }
}

test('a room id is its name slugged, then a random suffix; messages are numbered files', () => {
  assert.equal(roomIdFor('FLWS: credit & refinancing!', '7k2p'), 'flws-credit-refinancing-7k2p')
  assert.equal(roomIdFor('???', 'ab12'), 'room-ab12')
  assert.equal(roomIdFor('x'.repeat(80), 'ab12'), `${'x'.repeat(40)}-ab12`)
  assert.equal(seqFile(12), '000012.json')
  assert.equal(nextSeq([]), 1)
  assert.equal(nextSeq([user(1, 'a', []), answer(4, 'credit', 'b')]), 5)
})

test('the transcript labels who said what, numbered, and ends with the message for this analyst', () => {
  const messages: Message[] = [
    user(1, 'Refinancing risk?', ['credit', 'risk']),
    answer(2, 'risk', 'Revolver due 2027.'),
    answer(3, 'credit', '', { status: 'working' }),
    user(4, 'Break it down by instrument.', ['credit']),
  ]
  const text = transcript({ messages, names: NAMES, analyst: 'credit', message: user(4, 'Break it down by instrument.', ['credit']), answer: 5 })
  assert.equal(
    text,
    [
      'The room so far:',
      '',
      '#1 [You → Credit Analyst, Risk Analyst]: Refinancing risk?',
      '',
      '#2 [Risk Analyst]: Revolver due 2027.',
      '',
      '#3 [Credit Analyst] (working)',
      '',
      'New message for you, Credit Analyst:',
      '#4 [You → Credit Analyst]: Break it down by instrument.',
    ].join('\n'),
  )
})

test('the whole room goes in however long it is, later messages too, but not the answer being written', () => {
  const asked = user(3, 'Credit, the covenants?', ['credit'])
  const messages: Message[] = [
    user(1, 'a'.repeat(300_000), ['risk']),
    answer(2, 'risk', 'b'.repeat(300_000)),
    asked,
    answer(4, 'credit', 'Reading the credit agreement.', { status: 'working', inReplyTo: 3 }),
    user(5, 'Risk, insiders?', ['risk']),
    answer(6, 'risk', 'Two sales in May.', { inReplyTo: 5 }),
  ]
  const text = transcript({ messages, names: NAMES, analyst: 'credit', message: asked, answer: 4 })
  assert.equal(text.includes(`#1 [You → Risk Analyst]: ${'a'.repeat(300_000)}`), true)
  assert.equal(text.includes(`#2 [Risk Analyst]: ${'b'.repeat(300_000)}`), true)
  assert.equal(text.includes('left out'), false)
  assert.equal(text.includes('#6 [Risk Analyst]: Two sales in May.'), true)
  assert.equal(text.includes('#4 '), false)
  assert.equal(text.indexOf('#3 [You'), text.lastIndexOf('#3 [You'))
  assert.equal(text.endsWith('New message for you, Credit Analyst:\n#3 [You → Credit Analyst]: Credit, the covenants?'), true)
})

test('room news brings, once each, the messages that came in and the answers that finished since the analyst last saw the room', () => {
  const asked = user(1, 'Refinancing risk?', ['credit', 'risk'])
  const mine = answer(2, 'credit', '', { status: 'working' })
  const theirs = answer(3, 'risk', 'Checking the revolver.', { status: 'working' })
  const shown = shownOf([asked, mine, theirs])
  const look = (messages: Message[]): string | null => roomNews({ messages, names: NAMES, message: asked, answer: 2, shown })
  assert.equal(look([asked, mine, theirs]), null)
  // Still being written, theirs and mine: nothing yet.
  assert.equal(look([asked, { ...mine, text: 'Reading.' }, { ...theirs, text: 'Checking the revolver. Then the notes.' }]), null)
  const finished = answer(3, 'risk', 'Revolver due 2027.')
  const followUp = user(4, 'And insiders?', ['risk'])
  assert.equal(
    look([asked, mine, finished, followUp, answer(5, 'risk', '', { status: 'queued', inReplyTo: 4 })]),
    [
      'Room update: these came in while you were working. You are still answering #1.',
      '',
      '#3 [Risk Analyst]: Revolver due 2027.',
      '',
      '#4 [You → Risk Analyst]: And insiders?',
    ].join('\n'),
  )
  assert.equal(look([asked, mine, finished, followUp]), null)
  const failed = answer(5, 'risk', '', { status: 'error', error: 'Anthropic returned 529: overloaded', inReplyTo: 4 })
  assert.equal(look([asked, mine, finished, followUp, failed]), 'Room update: these came in while you were working. You are still answering #1.\n\n#5 [Risk Analyst] (error: Anthropic returned 529: overloaded)')
})

test('a step sits where the text was when the call was made, and a result says what came back', () => {
  assert.deepEqual(stepFor('Checking the 10-K.', 'search_filings', { query: 'revolving credit facility', ticker: 'FLWS' }), {
    at: 18,
    tool: 'search_filings',
    args: '{"query":"revolving credit facility","ticker":"FLWS"}',
    summary: null,
    ref: null,
    isError: false,
  })
  assert.equal(stepFor('', 'fetch_filings', { q: 'x'.repeat(400) }).args.length, 200)
  assert.equal(resultSummary('[{"a":1},{"a":2}]', false), '2 results')
  assert.equal(resultSummary('{"results":[1,2,3]}', false), '3 results')
  assert.equal(resultSummary('plain text answer', false), '17 characters')
  assert.equal(resultSummary('connection_unavailable: research/jaspers is needs-secret\nmore', true), 'Error: connection_unavailable: research/jaspers is needs-secret')
})

test('eviction stubs the oldest large results and keeps the newest and the small ones', () => {
  const big = (c: string): string => c.repeat(3000)
  const turns = [
    { role: 'user' as const, text: 'q' },
    { role: 'tool' as const, results: [{ callId: 'a', output: big('a'), isError: false }, { callId: 'b', output: 'small', isError: false }] },
    { role: 'tool' as const, results: [{ callId: 'c', output: big('c'), isError: false }] },
    { role: 'tool' as const, results: [{ callId: 'd', output: big('d'), isError: false }] },
  ]
  const refs = new Map([
    ['a', { ref: 'r1', tool: 'search_filings', args: '{"query":"debt"}' }],
    ['b', { ref: 'r2', tool: 'get_guide', args: '{}' }],
    ['c', { ref: 'r3', tool: 'fetch_chunk', args: '{}' }],
    ['d', { ref: 'r4', tool: 'fetch_chunk', args: '{}' }],
  ])
  const out = evictResults(turns, refs, { budget: 7000, keepNewest: 1, minSize: 2000 })
  const outputs = out.flatMap((t) => (t.role === 'tool' ? t.results.map((r) => r.output) : []))
  assert.equal(outputs[0]!.startsWith('[r1 evicted: search_filings {"query":"debt"}. First 1200 characters: aaa'), true)
  assert.equal(outputs[0]!.endsWith('Read the rest with fetch_result("r1", offset).]'), true)
  assert.equal(outputs[1], 'small')
  assert.equal(outputs[2], big('c'))
  assert.equal(outputs[3], big('d'))
  assert.equal(turns[1]!.role === 'tool' && turns[1]!.results[0]!.output, big('a'))
  // A stub is never stubbed again; with no budget left, everything large but the newest goes.
  const again = evictResults(out, refs, { budget: 0, keepNewest: 1, minSize: 2000 }).flatMap((t) => (t.role === 'tool' ? t.results.map((r) => r.output) : []))
  assert.equal(again[0], outputs[0])
  assert.equal(again[2]!.startsWith('[r3 evicted: fetch_chunk'), true)
  assert.equal(again[3], big('d'))
})

test('the output says who is working and the last three messages, within 4 KB', () => {
  const messages: Message[] = [
    user(1, 'Refinancing risk?', ['credit', 'risk']),
    answer(2, 'risk', 'r'.repeat(1000), { files: [{ path: 'output/Risk.pdf', size: 10 }] }),
    answer(3, 'credit', 'Working on it', { status: 'working' }),
    user(4, 'And covenants?', ['risk']),
    answer(5, 'risk', '', { status: 'queued' }),
  ]
  const output = outputOf(ROOM, messages, [{ id: 'credit', name: 'Credit Analyst' }, { id: 'risk', name: 'Risk Analyst' }])
  assert.deepEqual(output.analysts, [
    { id: 'credit', name: 'Credit Analyst', status: 'working' },
    { id: 'risk', name: 'Risk Analyst', status: 'queued' },
  ])
  assert.deepEqual(output.last.map((m) => [m.seq, m.from, m.status]), [
    [3, 'Credit Analyst', 'working'],
    [4, 'you', 'sent'],
    [5, 'Risk Analyst', 'queued'],
  ])
  assert.equal(output.messages, 5)
  assert.equal(output.files, 1)
  assert.equal(JSON.stringify(output).length <= 4096, true)
  assert.equal(roomSummary(output), 'FLWS credit · Credit Analyst working, Risk Analyst queued · 5 msgs · 1 file')
})

test('the thread reads back every message whole with all its sources, or one analyst or the last few if asked', () => {
  const notes: Message[] = Array.from({ length: 11 }, (_, i) => answer(i + 2, 'risk', `note ${i}`))
  const citations = Array.from({ length: 12 }, (_, i) => ({
    n: i + 1,
    key: `55:${i}`,
    documentId: '55',
    chunkId: String(i),
    sectionKey: null,
    quote: 'q',
    claim: 'c',
    passage: null,
    url: null,
    title: `10-K part ${i + 1}`,
    verified: true,
    match: 'exact' as const,
  }))
  const messages: Message[] = [
    user(1, 'Q', ['credit', 'risk']),
    ...notes,
    answer(13, 'risk', 'Cited.', { citations }),
    answer(14, 'risk', 'x'.repeat(5000)),
    answer(15, 'credit', 'Credit view', { status: 'stopped' }),
  ]
  const all = threadText(messages, NAMES, {})
  assert.equal(all.startsWith('#1 [You → Credit Analyst, Risk Analyst]: Q\n\n#2 [Risk Analyst]: note 0'), true)
  assert.equal(all.includes('[12] 10-K part 12 · verified'), true)
  assert.equal(all.includes(`#14 [Risk Analyst]: ${'x'.repeat(5000)}\n`), true)
  assert.equal(all.includes('(cut)'), false)
  assert.equal(all.endsWith('#15 [Credit Analyst] (stopped): Credit view'), true)
  assert.equal(threadText(messages, NAMES, { analyst: 'credit' }), '#15 [Credit Analyst] (stopped): Credit view')
  assert.equal(threadText(messages, NAMES, { last: 1 }), '#15 [Credit Analyst] (stopped): Credit view')
})

test('the thread shows citation tags as markers and lists the sources with their links', () => {
  const cited = answer(2, 'credit', '<cite document_id="55" chunk_id="1020" quote="a $200.0 million revolving">The revolver is $200.0 million.</cite> Own view: manageable.', {
    citations: [
      { n: 1, key: '55:1020', documentId: '55', chunkId: '1020', sectionKey: null, quote: 'a $200.0 million revolving', claim: 'The revolver is $200.0 million.', passage: null, url: 'https://www.sec.gov/x.htm#:~:text=a%20%24200.0', title: '10-K · 2025-09-05 · FLWS', verified: true, match: 'exact' },
    ],
  })
  assert.equal(
    threadText([user(1, 'Debt?', ['credit']), cited], NAMES, {}),
    [
      '#1 [You → Credit Analyst]: Debt?',
      '',
      '#2 [Credit Analyst]: The revolver is $200.0 million. [1] Own view: manageable.',
      'Sources: [1] 10-K · 2025-09-05 · FLWS · verified · https://www.sec.gov/x.htm#:~:text=200.0%20million%20revolving',
    ].join('\n'),
  )
  const output = outputOf(ROOM, [user(1, 'Debt?', ['credit']), cited], [{ id: 'credit', name: 'Credit Analyst' }])
  assert.equal(output.last[1]!.excerpt, 'The revolver is $200.0 million. [1] Own view: manageable.')
})

test('a copied answer is what follows the last tool call, its tags as markers and its sources linked under it', () => {
  const INDEX = 'https://www.sec.gov/Archives/edgar/data/1084869/000108486925000030/0001084869-25-000030-index.htm'
  const first = 'I will read the 10-K.'
  const narration = `${first}\n\nFound the debt note.`
  const message = answer(
    2,
    'credit',
    `${narration}\n\n## Debt\n\n<cite document_id="55" chunk_id="1020" quote="a $200.0 million revolving">The revolver is $200.0 million.</cite> <cite document_id="55" chunk_id="1021" quote="matures in 2027">It matures in 2027.</cite> Own view: manageable.`,
    {
      steps: [
        { at: first.length, tool: 'search_filings', args: '{}', summary: '3 results', ref: 'r1', isError: false },
        { at: narration.length, tool: 'fetch_chunk', args: '{}', summary: '1 result', ref: 'r2', isError: false },
      ],
      citations: [
        { n: 1, key: '55:1020', documentId: '55', chunkId: '1020', sectionKey: null, quote: 'a $200.0 million revolving', claim: 'The revolver is $200.0 million.', passage: null, url: 'https://www.sec.gov/x.htm#:~:text=a%20%24200.0', title: '10-K · 2025-09-05 · FLWS', verified: true, match: 'exact' },
        { n: 2, key: '55:1021', documentId: '55', chunkId: '1021', sectionKey: null, quote: 'matures in 2027', claim: 'It matures in 2027.', passage: null, url: INDEX, title: '10-K · 2025-09-05 · FLWS', verified: false, match: 'none' },
      ],
    },
  )
  assert.equal(
    answerText(message),
    [
      '## Debt',
      '',
      'The revolver is $200.0 million. [1] It matures in 2027. [2] Own view: manageable.',
      '',
      '## Sources',
      '',
      '- [1] 10-K · 2025-09-05 · FLWS: https://www.sec.gov/x.htm#:~:text=200.0%20million%20revolving',
      `- [2] 10-K · 2025-09-05 · FLWS (quote not found): ${INDEX}`,
    ].join('\n'),
  )
})

test('a copied answer numbers its markers as the whole message does and lists only the sources it cites', () => {
  const narration = '<cite document_id="55" chunk_id="1000" quote="the annual report">The 10-K is the annual report.</cite> Reading it.'
  const message = answer(2, 'credit', `${narration}\n\n<cite document_id="55" chunk_id="1021" quote="matures in 2027">The revolver matures in 2027.</cite>`, {
    steps: [{ at: narration.length, tool: 'fetch_chunk', args: '{}', summary: '1 result', ref: 'r1', isError: false }],
  })
  assert.equal(answerText(message), ['The revolver matures in 2027. [2]', '', '## Sources', '', '- [2] Document 55 · chunk 1021'].join('\n'))
})

test('nothing is copied until the answer is in, and an answer that cites nothing is copied as written', () => {
  const narration = 'Reading the 10-K first.'
  const step = { at: narration.length, tool: 'fetch_chunk', args: '{}', summary: null, ref: null, isError: false }
  assert.equal(answerText(answer(2, 'credit', narration, { status: 'stopped', steps: [step] })), '')
  assert.equal(answerText(answer(2, 'credit', `${narration}\n\nDraft view.`, { status: 'working', steps: [step] })), '')
  assert.equal(answerText(answer(2, 'credit', `${narration}\n\nNo figures to cite here.`, { steps: [step] })), 'No figures to cite here.')
})

test('a room is reached from its own workspace, or from anywhere when a call names none', () => {
  const room: Room = { ...ROOM, workspace: 'ws-1' }
  assert.equal(onWorkspace(room, 'ws-1'), true)
  assert.equal(onWorkspace(room, 'ws-2'), false)
  assert.equal(onWorkspace(room, null), true)
  // One made before rooms belonged to a workspace, and not yet given one, belongs to none.
  assert.equal(onWorkspace(ROOM, 'ws-1'), false)
})

test('an older room goes to the workspace its first message came from, while that workspace is still there', () => {
  const from = (seq: number, workspace?: string): UserMessage => ({ ...user(seq, 'q', ['credit']), ...(workspace ? { workspace } : {}) })
  assert.equal(claimWorkspace([from(3, 'ws-2'), from(1, 'ws-1')], new Set(['ws-1', 'ws-2']), 'ws-9'), 'ws-1')
  assert.equal(claimWorkspace([from(1, 'gone'), from(2, 'ws-2'), answer(3, 'credit', 'a')], new Set(['ws-2']), 'ws-9'), 'ws-2')
  assert.equal(claimWorkspace([from(1)], new Set(['ws-1']), 'ws-9'), 'ws-9')
  assert.equal(claimWorkspace([], new Set(), null), null)
})
