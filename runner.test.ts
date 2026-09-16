import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAnalyst } from './analysts.ts'
import type { AnalystMessage } from './room.ts'
import { runAnalyst, type Completion, type RunIo, type RunnerContext, type Turn } from './runner.ts'

const ANALYST = parseAnalyst('credit', '---\nname: Credit Analyst\nconnections: [jaspers/sec]\nmax-turns: 5\n---\nExtract debt.', 'preset')

function message(): AnalystMessage {
  return {
    seq: 2,
    role: 'analyst',
    analyst: 'credit',
    name: 'Credit Analyst',
    color: null,
    inReplyTo: 1,
    status: 'working',
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
}

function reply(text: string, calls: [string, Record<string, unknown>][] = []): Completion {
  return { text, toolCalls: calls.map(([name, input], i) => ({ id: `c${Math.random()}-${i}`, name, input })), stopReason: '', usage: { input: 10, output: 5 }, raw: null }
}

/** A model that answers from a script, tools that answer from a table, and files in memory. */
function world(script: (turns: Turn[], round: number) => Completion | Promise<Completion>, tools: Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string; isError: boolean }>> = {}) {
  const seen: Turn[][] = []
  const calls: string[] = []
  const results = new Map<string, string>()
  const saves: AnalystMessage[] = []
  let clock = 0
  const ctx: RunnerContext = {
    llm: {
      complete: async (req) => {
        seen.push(structuredClone(req.turns))
        return script(req.turns, seen.length)
      },
    },
    tools: {
      list: async () => [
        { id: 'jaspers/sec/search_filings', connection: 'jaspers/sec', name: 'search_filings', description: 'Search', parameters: { type: 'object' } },
        { id: 'jaspers/sec/fetch_chunk', connection: 'jaspers/sec', name: 'fetch_chunk', description: 'Fetch', parameters: { type: 'object' } },
        { id: 'other/search_filings', connection: 'other', name: 'search_filings', description: 'Elsewhere', parameters: { type: 'object' } },
        { id: 'jaspers/sec/show_citations', connection: 'jaspers/sec', name: 'show_citations', description: 'Verify', parameters: { type: 'object' } },
      ],
      call: async (id, args, opts) => {
        calls.push(id)
        const run = tools[id]
        return run ? run(args, opts?.signal) : { text: `no tool ${id}`, isError: true }
      },
    },
    state: {
      get: async (path) => {
        throw new Error(`nothing reads ${path} here`)
      },
    },
  }
  const io: RunIo = {
    save: async (m) => void saves.push(structuredClone(m)),
    saveResult: async (ref, text) => void results.set(ref, text),
    readResult: async (ref) => results.get(ref) ?? '',
    news: async () => null,
    now: () => (clock += 100),
    iso: () => '2026-09-13T10:00:00.000Z',
  }
  return { ctx, io, seen, calls, results, saves }
}

const job = { analyst: ANALYST, system: 'system', firstTurn: 'New message for you, Credit Analyst: debt?', title: 'FLWS debt', workspace: null }

test('a tool round then an answer: text, steps where the calls were made, saved results, usage', async () => {
  const w = world((_turns, round) => (round === 1 ? reply('Checking the 10-K.', [['search_filings', { query: 'debt' }]]) : reply('The revolver matures in June.')), {
    'jaspers/sec/search_filings': async () => ({ text: '[{"a":1},{"a":2}]', isError: false }),
  })
  const done = await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  assert.equal(done.status, 'done')
  assert.equal(done.text, 'Checking the 10-K.\n\nThe revolver matures in June.')
  assert.deepEqual(done.audit, { uncited: 0, unverified: 0, repaired: false })
  assert.deepEqual(done.steps.map((s) => [s.at, s.tool, s.summary, s.ref, s.isError]), [[18, 'search_filings', '2 results', 'r1', false]])
  assert.equal(w.results.get('r1'), '[{"a":1},{"a":2}]')
  assert.deepEqual(done.usage, { input: 20, output: 10 })
  assert.equal(done.turns, 2)
  assert.equal(done.endedAt, '2026-09-13T10:00:00.000Z')
  assert.equal(w.saves.at(-1)?.status, 'done')
  // The model sees each tool once, named by tool name, and the one that collides by connection.
  const round2 = w.seen[1]!
  assert.equal(round2[0]!.role === 'user' && round2[0]!.text, job.firstTurn)
  assert.equal(round2[2]!.role === 'tool' && round2[2]!.results[0]!.output, '[{"a":1},{"a":2}]')
})

test('tools the analyst is not limited away from are named plainly; a clash is named by connection', async () => {
  let offered: string[] = []
  const w = world(() => reply('ok'))
  w.ctx.llm.complete = async (req) => {
    offered = (req.tools ?? []).map((t) => t.name)
    return reply('ok')
  }
  const limited = parseAnalyst('credit', '---\nname: Credit Analyst\ntools: [search_filings]\n---\nX', 'preset')
  await runAnalyst(w.ctx, { ...job, analyst: limited, message: message() }, w.io, new AbortController().signal)
  assert.deepEqual(offered, ['jaspers__sec__search_filings', 'other__search_filings', 'fetch_result'])
  await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  assert.deepEqual(offered, ['search_filings', 'fetch_chunk', 'fetch_result'])
})

test('read_workspace reads the panels of the workspace the user asked from, and nothing outside them', async () => {
  let offered: string[] = []
  const asked: string[] = []
  const tree: Record<string, unknown> = {
    'workspaces/ws-2/panels/e1/output/tickers': ['FLWS', 'ETSY'],
    'workspaces/ws-2/panels/e1/output/nope': null,
  }
  const w = world((_turns, round) =>
    round === 1
      ? reply('Reading your screener.', [
          ['read_workspace', { path: 'panels/e1/output/tickers' }],
          ['read_workspace', { path: '/panels/e1/output/nope/' }],
          ['read_workspace', { path: 'panels/e9/output' }],
          ['read_workspace', { path: 'connections' }],
        ])
      : reply('Done.'),
  )
  const script = w.ctx.llm.complete
  w.ctx.llm.complete = async (req) => {
    offered = (req.tools ?? []).map((t) => t.name)
    return script(req)
  }
  w.ctx.state.get = async (path) => {
    asked.push(path)
    if (path in tree) return tree[path]
    throw new Error('No panel e9. The grid has p1 (e1).')
  }
  const done = await runAnalyst(w.ctx, { ...job, workspace: 'ws-2', message: message() }, w.io, new AbortController().signal)
  assert.equal(offered.includes('read_workspace'), true)
  assert.deepEqual(asked, ['workspaces/ws-2/panels/e1/output/tickers', 'workspaces/ws-2/panels/e1/output/nope', 'workspaces/ws-2/panels/e9/output'])
  const toolTurn = w.seen[1]![2]!
  assert.ok(toolTurn.role === 'tool')
  const [tickers, nothing, unknown, outside] = toolTurn.results
  assert.deepEqual([tickers!.output, tickers!.isError], ['["FLWS","ETSY"]', false])
  assert.deepEqual([nothing!.output, nothing!.isError], ['Nothing at panels/e1/output/nope.', false])
  assert.deepEqual([unknown!.output, unknown!.isError], ['No panel e9. The grid has p1 (e1).', true])
  assert.equal(outside!.isError, true)
  assert.equal(done.steps.map((s) => s.ref).filter(Boolean).length, 2)
})

test('calls in one round run together, and a failing tool goes back to the model as an error', async () => {
  let active = 0
  let most = 0
  const slow = async (): Promise<{ text: string; isError: boolean }> => {
    active++
    most = Math.max(most, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active--
    return { text: 'chunk', isError: false }
  }
  const w = world(
    (_turns, round) => (round === 1 ? reply('', [['fetch_chunk', { id: 1 }], ['fetch_chunk', { id: 2 }], ['search_filings', {}]]) : reply('Done.')),
    { 'jaspers/sec/fetch_chunk': slow },
  )
  const done = await runAnalyst(w.ctx, { ...job, analyst: parseAnalyst('credit', '---\nname: Credit Analyst\nconnections: [jaspers/sec]\n---\nX', 'preset'), message: message() }, w.io, new AbortController().signal)
  assert.equal(most, 2)
  const toolTurn = w.seen[1]![2]!
  assert.equal(toolTurn.role === 'tool' && toolTurn.results[2]!.isError, true)
  assert.deepEqual(done.steps.map((s) => s.isError), [false, false, true])
})

test('at the turn cap the answer ends done, saying so', async () => {
  const w = world(() => reply('Still looking.', [['search_filings', {}]]), { 'jaspers/sec/search_filings': async () => ({ text: 'x', isError: false }) })
  const done = await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  assert.equal(done.status, 'done')
  assert.equal(done.turns, 5)
  assert.equal(done.text.endsWith('Stopped at the 5-turn limit. Ask a follow-up to carry on.'), true)
})

test('an abort mid-run keeps the text so far and ends stopped with the reason', async () => {
  const controller = new AbortController()
  const w = world(
    (_turns, round) => (round === 1 ? reply('Pulling the debt footnote.', [['search_filings', {}]]) : reply('never')),
    {
      'jaspers/sec/search_filings': (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason))
          setTimeout(() => controller.abort(new Error('plugin reloaded')), 5)
        }),
    },
  )
  const done = await runAnalyst(w.ctx, { ...job, message: message() }, w.io, controller.signal)
  assert.equal(done.status, 'stopped')
  assert.equal(done.error, 'plugin reloaded')
  assert.equal(done.text, 'Pulling the debt footnote.')
  assert.equal(w.seen.length, 1)
})

test('room news that lands between rounds is in front of the model at its next call', async () => {
  const w = world((_turns, round) => (round === 1 ? reply('Checking the 10-K.', [['search_filings', {}]]) : reply('The revolver matures in June.')), {
    'jaspers/sec/search_filings': async () => ({ text: 'x', isError: false }),
  })
  const update = 'Room update: these came in while you were working. You are still answering #1.\n\n#3 [Risk Analyst]: Revolver due 2027.'
  const updates = [null, update]
  w.io.news = async () => updates.shift() ?? null
  await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  assert.equal(w.seen[0]!.length, 1)
  const second = w.seen[1]!
  assert.equal(second.at(-2)!.role, 'tool')
  assert.deepEqual(second.at(-1), { role: 'user', text: update })
})

test('a model error ends the message in error with its words', async () => {
  const w = world(() => {
    throw new Error('Anthropic returned 401: invalid x-api-key')
  })
  const done = await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  assert.equal(done.status, 'error')
  assert.equal(done.error, 'Anthropic returned 401: invalid x-api-key')
})

test('fetch_result reads a saved result back in pieces', async () => {
  const long = `${'a'.repeat(20_000)}${'b'.repeat(5)}`
  const w = world(
    (_turns, round) =>
      round === 1 ? reply('', [['search_filings', {}]]) : round === 2 ? reply('', [['fetch_result', { ref: 'r1', offset: 20_000 }]]) : reply('Read it.'),
    { 'jaspers/sec/search_filings': async () => ({ text: long, isError: false }) },
  )
  await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  const third = w.seen[2]!.at(-1)!
  assert.equal(third.role === 'tool' && third.results[0]!.output, 'bbbbb')
})

test('a reason made outside the plugin keeps its words', async () => {
  const { runInNewContext } = await import('node:vm')
  const controller = new AbortController()
  const w = world(() => new Promise<Completion>(() => undefined))
  const run = runAnalyst(w.ctx, { ...job, message: message() }, w.io, controller.signal)
  w.ctx.llm.complete = async (req) =>
    new Promise((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(req.signal?.reason)))
  controller.abort(runInNewContext('new Error("plugin reloaded")'))
  const done = await run
  assert.equal(done.status, 'stopped')
  assert.equal(done.error, 'plugin reloaded')
})

/** A server that knows one passage: quotes copied from it verify and get the highlighted link. */
const SOURCE = 'The Company has a $200.0 million revolving credit facility maturing in June 2027, of which $40.0 million was drawn.'
function showCitations(calls: unknown[]): (args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> {
  return async (args) => {
    calls.push(args)
    const claims = args['claims'] as { quote: string; document_id: number; chunk_id?: number }[]
    const citations = claims.map((c, i) => {
      const verified = SOURCE.includes(c.quote)
      return {
        n: i + 1,
        document_id: c.document_id,
        chunk_id: c.chunk_id,
        form_type: '10-K',
        filing_date: '2025-09-05',
        ticker: 'FLWS',
        verified,
        match: verified ? 'exact' : 'none',
        url: `https://www.sec.gov/Archives/edgar/data/1/2/flws.htm${verified ? `#:~:text=${encodeURIComponent(c.quote)}` : ''}`,
      }
    })
    return { text: JSON.stringify({ verified: citations.filter((c) => c.verified).length, unverified: citations.filter((c) => !c.verified).length, citations }), isError: false }
  }
}

const CITED_DRAFT =
  '<cite document_id="55" chunk_id="1020" quote="a $200.0 million revolving credit facility maturing in June 2027">The revolver is $200.0 million, due June 2027.</cite> <cite document_id="55" chunk_id="1020" quote="forty million drawn">$40.0 million was drawn.</cite>'
const REPAIRED_DRAFT =
  '<cite document_id="55" chunk_id="1020" quote="a $200.0 million revolving credit facility maturing in June 2027">The revolver is $200.0 million, due June 2027.</cite> <cite document_id="55" chunk_id="1020" quote="$40.0 million was drawn">$40.0 million was drawn.</cite>'

test('citations are verified by the server, a bad quote sends the draft back once, and the repaired answer replaces it', async () => {
  const served: unknown[] = []
  const w = world(
    (turns, round) => {
      if (round === 1) return reply('Reading the debt footnote.', [['search_filings', { query: 'revolver' }]])
      if (round === 2) return reply(CITED_DRAFT)
      const last = turns.at(-1)
      assert.equal(last?.role === 'user' && last.text.includes('quote could not be found'), true)
      return reply(REPAIRED_DRAFT)
    },
    { 'jaspers/sec/search_filings': async () => ({ text: SOURCE, isError: false }), 'jaspers/sec/show_citations': showCitations(served) },
  )
  const done = await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  assert.equal(done.status, 'done')
  assert.equal(done.text, `Reading the debt footnote.\n\n${REPAIRED_DRAFT}`)
  assert.deepEqual(done.audit, { uncited: 0, unverified: 0, repaired: true })
  // Two quotes from one chunk go to the server in separate calls, before and after the repair.
  assert.equal(served.length, 4)
  assert.deepEqual((served[0] as { title: string }).title, 'FLWS debt')
  assert.deepEqual(
    done.citations.map((c) => [c.n, c.verified, c.title, c.url]),
    [
      [1, true, '10-K · 2025-09-05 · FLWS', `https://www.sec.gov/Archives/edgar/data/1/2/flws.htm#:~:text=${encodeURIComponent('a $200.0 million revolving credit facility maturing in June 2027')}`],
      [2, true, '10-K · 2025-09-05 · FLWS', `https://www.sec.gov/Archives/edgar/data/1/2/flws.htm#:~:text=${encodeURIComponent('$40.0 million was drawn')}`],
    ],
  )
  // The step from before the answer still sits where it was made; the model never saw show_citations.
  assert.deepEqual(done.steps.map((s) => [s.at, s.tool]), [['Reading the debt footnote.'.length, 'search_filings']])
  assert.equal(done.turns, 3)
})

test('an uncited factual sentence sends the draft back even when every quote verified', async () => {
  const served: unknown[] = []
  const draft = `${REPAIRED_DRAFT} A $150.0 million term loan is due in 2029.`
  const w = world(
    (turns, round) => {
      if (round === 1) return reply(draft)
      const last = turns.at(-1)
      assert.equal(last?.role === 'user' && last.text.includes('1. "A $150.0 million term loan is due in 2029."'), true)
      return reply(REPAIRED_DRAFT)
    },
    { 'jaspers/sec/show_citations': showCitations(served) },
  )
  const done = await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  assert.equal(done.text, REPAIRED_DRAFT)
  assert.deepEqual(done.audit, { uncited: 0, unverified: 0, repaired: true })
})

test('a repair that re-reads a source keeps its step with the answer, and a repair that fails keeps the draft', async () => {
  const served: unknown[] = []
  const w = world(
    (_turns, round) => {
      if (round === 1) return reply(CITED_DRAFT)
      if (round === 2) return reply('Re-reading.', [['fetch_chunk', { id: 1020 }]])
      return reply(REPAIRED_DRAFT)
    },
    { 'jaspers/sec/fetch_chunk': async () => ({ text: SOURCE, isError: false }), 'jaspers/sec/show_citations': showCitations(served) },
  )
  const done = await runAnalyst(w.ctx, { ...job, message: message() }, w.io, new AbortController().signal)
  assert.equal(done.text, REPAIRED_DRAFT)
  assert.deepEqual(done.steps.map((s) => [s.at, s.tool]), [[0, 'fetch_chunk']])

  const failing = world(
    (_turns, round) => {
      if (round === 1) return reply(CITED_DRAFT)
      throw new Error('Anthropic returned 529: overloaded')
    },
    { 'jaspers/sec/show_citations': showCitations([]) },
  )
  const kept = await runAnalyst(failing.ctx, { ...job, message: message() }, failing.io, new AbortController().signal)
  assert.equal(kept.status, 'done')
  assert.equal(kept.text, CITED_DRAFT)
  assert.deepEqual(kept.audit, { uncited: 0, unverified: 1, repaired: true })
})

test('with no citation server on the connection, citations are numbered but unchecked, and the turn cap gets no repair', async () => {
  const w = world(() => reply(CITED_DRAFT))
  w.ctx.tools.list = async () => [{ id: 'mock/search_filings', connection: 'mock', name: 'search_filings', description: '', parameters: {} }]
  const analyst = parseAnalyst('credit', '---\nname: Credit Analyst\nconnections: [mock]\nmax-turns: 5\n---\nX', 'preset')
  const done = await runAnalyst(w.ctx, { ...job, analyst, message: message() }, w.io, new AbortController().signal)
  assert.deepEqual(done.citations.map((c) => [c.n, c.verified, c.url]), [[1, null, null], [2, null, null]])
  assert.deepEqual(done.audit, { uncited: 0, unverified: 0, repaired: false })

  const capped = world(() => reply('Uncited figure: $1.', [['search_filings', {}]]), { 'jaspers/sec/search_filings': async () => ({ text: 'x', isError: false }) })
  const atCap = await runAnalyst(capped.ctx, { ...job, message: message() }, capped.io, new AbortController().signal)
  assert.equal(atCap.turns, 5)
  assert.deepEqual(atCap.audit, { uncited: 1, unverified: 0, repaired: false })
})

test("read_workspace reads a view's text a part at a time, and a quote from it verifies against the text as it was read", async () => {
  const served: unknown[] = []
  const title = 'MSFT Q4 2026 earnings call · Microsoft Corporation · 2026-07-29'
  const transcript = `${title}\n\n¶1 ${'Thank you all for joining us today. '.repeat(700)}\n\n¶2 We now expect capital expenditures to increase sequentially.`
  const asked: string[] = []
  const w = world(
    (_turns, round) => {
      if (round === 1) return reply('Reading the call.', [['read_workspace', { path: 'panels/e1/text' }]])
      if (round === 2) return reply('', [['read_workspace', { path: 'panels/e1/text', offset: 20000 }]])
      return reply('<cite panel="e1" quote="We now expect capital expenditures to increase sequentially">Microsoft expects capex to keep rising.</cite>')
    },
    { 'jaspers/sec/show_citations': showCitations(served) },
  )
  w.ctx.state.get = async (path) => {
    asked.push(path)
    // After both reads the user opens another quarter; the quote still comes from the call that was read.
    return asked.length <= 2 ? transcript : 'MSFT Q3 2026 earnings call\n\n¶1 Other words.'
  }
  const done = await runAnalyst(w.ctx, { ...job, workspace: 'ws-2', message: message() }, w.io, new AbortController().signal)
  const first = w.seen[1]![2]!
  const second = w.seen[2]![4]!
  assert.ok(first.role === 'tool' && second.role === 'tool')
  assert.equal(first.results[0]!.isError, false)
  assert.equal(first.results[0]!.output.startsWith('panels/e1/text'), true)
  assert.equal(first.results[0]!.output.includes('offset 20000'), true)
  assert.equal(first.results[0]!.output.endsWith(`\n\n${transcript.slice(0, 20000)}`), true)
  assert.equal(second.results[0]!.output.endsWith(`\n\n${transcript.slice(20000)}`), true)
  assert.equal(second.results[0]!.output.includes('offset 40000'), false)
  assert.deepEqual(done.citations.map((c) => [c.n, c.panel, c.verified, c.title, c.url]), [[1, 'e1', true, title, null]])
  assert.deepEqual(done.audit, { uncited: 0, unverified: 0, repaired: false })
  // No server holds a view, so none is asked about one.
  assert.equal(served.length, 0)
})

test("a quote not in the view's text sends the draft back once naming the panel, and a panel never read is checked against its text now", async () => {
  const text = 'FLWS Q2 2026 earnings call\n\n¶1 Gross margin improved 150 basis points on lower freight costs.'
  const w = world((turns, round) => {
    if (round === 1) return reply('<cite panel="e3" quote="gross margin improved 200 basis points">Margin rose 200 basis points.</cite>')
    const last = turns.at(-1)
    assert.equal(last?.role === 'user' && last.text.includes('<cite panel="e3">'), true)
    return reply('<cite panel="e3" quote="Gross margin improved 150 basis points on lower freight costs">Margin rose 150 basis points on cheaper freight.</cite>')
  })
  const asked: string[] = []
  w.ctx.state.get = async (path) => {
    asked.push(path)
    return text
  }
  const done = await runAnalyst(w.ctx, { ...job, workspace: 'ws-2', message: message() }, w.io, new AbortController().signal)
  assert.equal(asked.includes('workspaces/ws-2/panels/e3/text'), true)
  assert.deepEqual(done.citations.map((c) => [c.n, c.panel, c.verified, c.title]), [[1, 'e3', true, 'FLWS Q2 2026 earnings call']])
  assert.deepEqual(done.audit, { uncited: 0, unverified: 0, repaired: true })
})
