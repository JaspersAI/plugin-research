import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildRepairMessage,
  citationKey,
  citationLink,
  claimsFor,
  numberCitations,
  parseCitationTags,
  readShowCitations,
  resolveCitations,
  resolveViewCitations,
  sourceTitle,
  stripCitations,
  textFragment,
  toMarkers,
  uncitedSentences,
} from './citations.ts'

const ANSWER = [
  'Checking the debt footnote.',
  '',
  '<cite document_id="55" chunk_id="1020" quote="a $200.0 million revolving credit facility maturing in June 2027">The revolver is $200.0 million and matures in June 2027.</cite>',
  '<cite document_id="55" chunk_id="1020" quote="$40.0 million was drawn">$40.0 million of it was drawn.</cite> <cite document_id="55" chunk_id="1031" quote="a $150.0 million term loan due 2029">A $150.0 million term loan is due in 2029.</cite>',
  '<dbcitation document_id="66f1a2b3c4d5e6f7a8b9c0d1" section_key="item7" quote="leverage ratio below 3.0x">Covenants cap leverage at 3.0x.</dbcitation>',
  'Taken together, the 2027 maturity is the pressure point.',
].join('\n')

test('tags are found with their attributes and inner text, closed or not', () => {
  const tags = parseCitationTags('<cite document_id="1" chunk_id="2" quote="x y z">fact</cite> then <cite document_id="3" chunk_id="4"/> and <cite document_id=\'5\' chunk_id=\'6\'> tail')
  assert.deepEqual(
    tags.map((t) => [t.kind, t.attrs, t.inner]),
    [
      ['cite', { document_id: '1', chunk_id: '2', quote: 'x y z' }, 'fact'],
      ['cite', { document_id: '3', chunk_id: '4' }, ''],
      ['cite', { document_id: '5', chunk_id: '6' }, ''],
    ],
  )
  assert.equal(tags[0]!.start, 0)
  assert.equal(tags[0]!.end, '<cite document_id="1" chunk_id="2" quote="x y z">fact</cite>'.length)
})

test('a quote a model escaped as JSON or as HTML reads as its words', () => {
  const [json] = parseCitationTags('<cite document_id="369363" chunk_id="7870766" quote="\\"op_cf\\": 18308000.0, \\"inv_cf\\": -31280000.0">Operating cash flow was $18.3 million.</cite>')
  assert.equal(json!.attrs['quote'], '"op_cf": 18308000.0, "inv_cf": -31280000.0')
  assert.equal(json!.inner, 'Operating cash flow was $18.3 million.')
  const [html] = parseCitationTags('<cite document_id="9" quote="&quot;name&quot;: &quot;Fund 1 Investments, LLC&quot; &amp; others">x</cite>')
  assert.equal(html!.attrs['quote'], '"name": "Fund 1 Investments, LLC" & others')
})

test('a key names the source: document and chunk, or document and section', () => {
  assert.equal(citationKey({ document_id: '55', chunk_id: '1020' }), '55:1020')
  assert.equal(citationKey({ document_id: '66f1a2b3c4d5e6f7a8b9c0d1', section_key: 'item7' }), '66f1a2b3c4d5e6f7a8b9c0d1:item7')
  assert.equal(citationKey({ document_id: '9' }), '9:')
  assert.equal(citationKey({ quote: 'no ids' }), null)
})

test('each quoted passage is numbered once, in order of first appearance, even two from one chunk', () => {
  const numbered = numberCitations(ANSWER)
  assert.deepEqual(
    numbered.map((c) => [c.n, c.key, c.quote]),
    [
      [1, '55:1020', 'a $200.0 million revolving credit facility maturing in June 2027'],
      [2, '55:1020', '$40.0 million was drawn'],
      [3, '55:1031', 'a $150.0 million term loan due 2029'],
      [4, '66f1a2b3c4d5e6f7a8b9c0d1:item7', 'leverage ratio below 3.0x'],
    ],
  )
  assert.equal(numbered[0]!.claim, 'The revolver is $200.0 million and matures in June 2027.')
  assert.deepEqual(numbered[3]!.attrs, { document_id: '66f1a2b3c4d5e6f7a8b9c0d1', section_key: 'item7', quote: 'leverage ratio below 3.0x' })
  assert.equal(numberCitations(`${ANSWER}\n<cite document_id="55" chunk_id="1020" quote="$40.0 million was drawn">Again.</cite>`).length, 4)
})

test('markers replace tags for the orchestrator, and stripping leaves the prose alone', () => {
  assert.equal(
    toMarkers(ANSWER).split('\n').slice(2, 5).join('\n'),
    [
      'The revolver is $200.0 million and matures in June 2027. [1]',
      '$40.0 million of it was drawn. [2] A $150.0 million term loan is due in 2029. [3]',
      'Covenants cap leverage at 3.0x. [4]',
    ].join('\n'),
  )
  assert.equal(toMarkers('see <cite document_id="1" chunk_id="2"/> here'), 'see [1] here')
  assert.equal(stripCitations('<cite document_id="1" chunk_id="2" quote="q">fact</cite> and </cite> stray'), 'fact and  stray')
})

test('sentences without a tag are found when they carry a figure or eight words, and nothing else is', () => {
  const draft = [
    '## Debt',
    '<cite document_id="1" chunk_id="2" quote="q">Cited sentence with $1.',
    'Still inside the same tag, so cited.</cite> Uncited one with a 2027 date.',
    'Short and uncited.',
    'This sentence has more than eight words and carries no citation at all.',
    '| Instrument | Due |',
    '|---|---|',
    '| Revolver | 2027 |',
    '- A bullet with $40.0 million drawn.',
    'Stopped at the 50-turn limit. Ask a follow-up to carry on.',
  ].join('\n')
  assert.deepEqual(uncitedSentences(draft), [
    'Uncited one with a 2027 date.',
    'This sentence has more than eight words and carries no citation at all.',
    'A bullet with $40.0 million drawn.',
  ])
  assert.deepEqual(uncitedSentences('Inc. vs. Corp. in 2027 saw revenue, e.g. growth of 6%.'), ['Inc. vs. Corp. in 2027 saw revenue, e.g. growth of 6%.'])
})

test('claims go to the server with the ids and quote of each numbered citation', () => {
  assert.deepEqual(claimsFor(numberCitations(ANSWER)), [
    { claim: 'The revolver is $200.0 million and matures in June 2027.', quote: 'a $200.0 million revolving credit facility maturing in June 2027', document_id: 55, chunk_id: 1020 },
    { claim: '$40.0 million of it was drawn.', quote: '$40.0 million was drawn', document_id: 55, chunk_id: 1020 },
    { claim: 'A $150.0 million term loan is due in 2029.', quote: 'a $150.0 million term loan due 2029', document_id: 55, chunk_id: 1031 },
    { claim: 'Covenants cap leverage at 3.0x.', quote: 'leverage ratio below 3.0x', document_id: '66f1a2b3c4d5e6f7a8b9c0d1', section_key: 'item7' },
  ])
})

test('a tag with no quote offers its sentence as the quote', () => {
  const claims = claimsFor(numberCitations('<cite document_id="7" chunk_id="8">Borrowings peaked at $175.0 million in November 2025.</cite>'))
  assert.deepEqual(claims, [{ claim: 'Borrowings peaked at $175.0 million in November 2025.', quote: 'Borrowings peaked at $175.0 million in November 2025.', document_id: 7, chunk_id: 8 }])
})

test("a citation of a view's text names its panel, and is checked here against the text, forgiving spacing, case, and quote marks", () => {
  const transcript = [
    'MSFT Q4 2026 earnings call · Microsoft Corporation · 2026-07-29',
    'Machine-transcribed plain transcript.',
    '',
    '¶12 We now expect capital expenditures to increase sequentially, driven by “cloud and AI” demand.',
  ].join('\n')
  const answer = [
    '<cite panel="e1" quote="we now expect  capital expenditures to increase sequentially">Capex keeps rising.</cite>',
    '<cite panel="e1" quote="driven by ’cloud and AI’ demand">Demand is cloud and AI.</cite>',
    '<cite panel="e1" quote="capital expenditures will fall next year">Capex falls.</cite>',
    '<cite panel="e2" quote="revenue grew double digits this quarter">Revenue grew.</cite>',
    '<cite document_id="55" chunk_id="1020" quote="a filing passage">A filing says so.</cite>',
  ].join(' ')
  assert.equal(citationKey({ panel: 'e1' }), 'panel:e1')
  const numbered = numberCitations(answer)
  assert.deepEqual(numbered.map((c) => [c.n, c.key]), [[1, 'panel:e1'], [2, 'panel:e1'], [3, 'panel:e1'], [4, 'panel:e2'], [5, '55:1020']])
  assert.equal(sourceTitle(numbered[3]!, undefined), 'View e2')
  const title = 'MSFT Q4 2026 earnings call · Microsoft Corporation · 2026-07-29'
  assert.deepEqual(
    resolveViewCitations(numbered, new Map([['e1', transcript]])).map((c) => [c.n, c.panel, c.verified, c.match, c.title, c.url]),
    [
      [1, 'e1', true, 'exact', title, null],
      [2, 'e1', true, 'exact', title, null],
      [3, 'e1', false, 'none', title, null],
      [4, 'e2', false, 'none', 'View e2', null],
    ],
  )
})

test("the server's verdicts are read back and matched to the citations by source", () => {
  const payload = JSON.stringify({
    verified: 1,
    unverified: 1,
    hint: '1 citation(s) did not verify…',
    citations: [
      { n: 1, type: 'chunk', document_id: 55, chunk_id: 1020, form_type: '10-K', filing_date: '2025-09-05', ticker: 'FLWS', verified: true, match: 'exact', source_quote: 'a $200.0 million revolving credit facility maturing in June 2027', url: 'https://www.sec.gov/Archives/edgar/data/1084869/000108486925000034/flws-20250629.htm#:~:text=a%20%24200.0%20million%20revolving%20credit%20facility%20maturing%20in%20June%202027', index_url: 'https://www.sec.gov/Archives/edgar/data/1084869/000108486925000034/0001084869-25-000034-index.htm' },
      { n: 2, type: 'chunk', document_id: 55, chunk_id: 1031, form_type: '10-K', filing_date: '2025-09-05', ticker: 'FLWS', verified: false, match: 'none', url: 'https://www.sec.gov/Archives/edgar/data/1084869/000108486925000034/flws-20250629.htm' },
    ],
  })
  const refs = readShowCitations(payload)
  const resolved = resolveCitations(numberCitations(ANSWER), refs)
  // The server answers per source, so a second quote from the same chunk reads the same verdict here.
  assert.deepEqual(
    resolved.map((c) => [c.n, c.verified, c.match, c.title, c.url?.includes('#:~:text=')]),
    [
      [1, true, 'exact', '10-K · 2025-09-05 · FLWS', true],
      [2, true, 'exact', '10-K · 2025-09-05 · FLWS', true],
      [3, false, 'none', '10-K · 2025-09-05 · FLWS', false],
      [4, null, null, null, undefined],
    ],
  )
  assert.equal(resolved[3]!.url, null)
  assert.deepEqual(resolved.map((c) => c.passage), ['a $200.0 million revolving credit facility maturing in June 2027', 'a $200.0 million revolving credit facility maturing in June 2027', null, null])
  assert.deepEqual(readShowCitations('{"error":"claims is required"}'), [])
  assert.deepEqual(readShowCitations('not json'), [])
})

// Each passage below is one a real room cited, and each directive is one that opened on it in Chromium.
test('prose is highlighted from its first run of plain words to its last, or whole when short', () => {
  assert.equal(textFragment('driving cost savings and organizational efficiency'), '#:~:text=driving%20cost%20savings%20and%20organizational%20efficiency')
  assert.equal(
    textFragment('Class B Common Stock is convertible at any time at the option of the holder into Class A Common Stock'),
    '#:~:text=Class%20B%20Common%20Stock%20is%20convertible%20at%20any,into%20Class%20A%20Common%20Stock',
  )
  // A dollar or percent sign ends a run, since a page may set it apart from its figure.
  assert.equal(textFragment('net revenues decreased by $182.1 million, or 10.8%, to $1,503.5 million'), '#:~:text=net%20revenues%20decreased%20by,182.1%20million%2C%20or%2010.8')
  // A date and small words say too little to find a passage by, so the highlight starts at words that do.
  assert.equal(textFragment('As of March 29, 2026, $10.6 million remained authorized under the plan.'), '#:~:text=10.6%20million%20remained%20authorized%20under%20the%20plan.')
  // A quote mark or a bracket ends a run too.
  assert.equal(
    textFragment('the outstanding term loan (the "Term Loan") was subject to quarterly payments'),
    '#:~:text=the%20outstanding%20term%20loan,was%20subject%20to%20quarterly%20payments',
  )
})

test('a table row is highlighted from its first figure to its last, since the page sets its cells apart', () => {
  assert.equal(textFragment('Total net revenues$1,503,511 $- $- $1,503,511 $1,685,658'), '#:~:text=1%2C503%2C511,1%2C685%2C658')
  assert.equal(textFragment('Net loss$(134,765)$(199,993)'), '#:~:text=134%2C765,199%2C993')
  assert.equal(
    textFragment('| James F. McCann (6) (14)                                 |     |                    |     |  1,510,250 |     |          |     | 20,342,581'),
    '#:~:text=1%2C510%2C250,20%2C342%2C581',
  )
  assert.equal(textFragment('Fund 1 Investments, LLC (1)                              |     |                    |     |  9,527,250'), '#:~:text=9%2C527%2C250')
})

test('structured data is found by its longest quoted value, and nothing plain gives no directive', () => {
  assert.equal(textFragment('"name": "Fund 1 Investments, LLC", "aggregate_shares": 3553230, "percent_of_class": 9.6'), '#:~:text=Fund%201%20Investments%2C%20LLC')
  assert.equal(textFragment('\\"name\\": \\"Fund 1 Investments, LLC\\"'), '#:~:text=Fund%201%20Investments%2C%20LLC')
  assert.equal(textFragment('"op_cf": 18308000.0, "inv_cf": -31280000.0'), '')
  assert.equal(textFragment('\\'), '')
  assert.equal(textFragment(''), '')
})

test("a citation's link is the server's page with this directive, from the source's words when the server found them", () => {
  const page = 'https://www.sec.gov/Archives/edgar/data/1084869/000108486926000019/flws-20260329.htm'
  assert.equal(
    citationLink({ url: `${page}#:~:text=Total%20net%20revenues%241%2C210%2C393`, passage: 'Total net revenues$1,210,393 $- $- $1,210,393 $1,349,036', quote: 'something else' }),
    `${page}#:~:text=1%2C210%2C393,1%2C349%2C036`,
  )
  assert.equal(citationLink({ url: page, passage: null, quote: 'driving cost savings and organizational efficiency' }), `${page}#:~:text=driving%20cost%20savings%20and%20organizational%20efficiency`)
  // An index page does not hold the passage, a PDF page fragment is not a highlight, and a passage with nothing plain keeps what the server gave.
  const index = 'https://www.sec.gov/Archives/edgar/data/1084869/000108486926000019/0001084869-26-000019-index.htm'
  assert.equal(citationLink({ url: index, quote: 'driving cost savings and organizational efficiency' }), index)
  assert.equal(citationLink({ url: 'https://example.com/report.pdf#page=3', quote: 'driving cost savings and organizational efficiency' }), 'https://example.com/report.pdf#page=3')
  assert.equal(citationLink({ url: `${page}#:~:text=op_cf`, quote: '"op_cf": 18308000.0' }), `${page}#:~:text=op_cf`)
  assert.equal(citationLink({ url: null, quote: 'anything at all here' }), null)
})

test('the repair message lists what to fix and how, and nothing when there is nothing', () => {
  const text = buildRepairMessage({
    uncited: ['Uncited one with a 2027 date.'],
    unverified: [{ n: 2, tag: '<cite document_id="55" chunk_id="1031">', quote: 'a $150.0 million term loan due 2029', reason: 'quote not found in the source' }],
  })
  assert.equal(text!.startsWith('A citation audit of your draft found the problems below. Reply with the COMPLETE corrected response'), true)
  assert.equal(text!.includes('1. "Uncited one with a 2027 date."'), true)
  assert.equal(text!.includes('1. <cite document_id="55" chunk_id="1031"> quote="a $150.0 million term loan due 2029" - quote not found in the source'), true)
  assert.equal(text!.includes('use only ids that appear in tool results'), true)
  assert.equal(buildRepairMessage({ uncited: [], unverified: [] }), null)
})
