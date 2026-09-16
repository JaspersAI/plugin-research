import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseInline, parseMarkdown } from './markdown.ts'

test('headings, paragraphs split by blank lines, and rules', () => {
  assert.deepEqual(parseMarkdown('## Debt\nThe revolver\nmatures in 2027.\n\n---\n\nNext.'), [
    { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Debt' }] },
    { kind: 'paragraph', children: [{ kind: 'text', text: 'The revolver matures in 2027.' }] },
    { kind: 'rule' },
    { kind: 'paragraph', children: [{ kind: 'text', text: 'Next.' }] },
  ])
})

test('bulleted and numbered lists, with continuation lines', () => {
  assert.deepEqual(parseMarkdown('- one\n  more\n* two\n\n1. first\n2) second'), [
    { kind: 'list', ordered: false, items: [[{ kind: 'text', text: 'one more' }], [{ kind: 'text', text: 'two' }]] },
    { kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'first' }], [{ kind: 'text', text: 'second' }]] },
  ])
})

test('a fence keeps its text as written, and one never closed runs to the end', () => {
  assert.deepEqual(parseMarkdown('```python\nprint("**x**")\n```\nafter'), [
    { kind: 'code', lang: 'python', text: 'print("**x**")' },
    { kind: 'paragraph', children: [{ kind: 'text', text: 'after' }] },
  ])
  assert.deepEqual(parseMarkdown('```\na\n\nb'), [{ kind: 'code', lang: '', text: 'a\n\nb' }])
})

test('a table with alignment, and marks inside its cells', () => {
  const [table] = parseMarkdown('| Instrument | Due | Amount |\n|:---|:---:|---:|\n| **Revolver** | 2027 | $200M |\n| Term loan | 2029 | `$150M` |')
  assert.deepEqual(table, {
    kind: 'table',
    align: ['left', 'center', 'right'],
    header: [[{ kind: 'text', text: 'Instrument' }], [{ kind: 'text', text: 'Due' }], [{ kind: 'text', text: 'Amount' }]],
    rows: [
      [[{ kind: 'strong', children: [{ kind: 'text', text: 'Revolver' }] }], [{ kind: 'text', text: '2027' }], [{ kind: 'text', text: '$200M' }]],
      [[{ kind: 'text', text: 'Term loan' }], [{ kind: 'text', text: '2029' }], [{ kind: 'code', text: '$150M' }]],
    ],
  })
})

test('a quote is its own block', () => {
  assert.deepEqual(parseMarkdown('> We expect to refinance.'), [{ kind: 'quote', children: [{ kind: 'text', text: 'We expect to refinance.' }] }])
})

test('inline code, strong, emphasis, links, and bare https links', () => {
  assert.deepEqual(parseInline('Per `10-K`, **net debt *rose*** — see [Item 7](https://www.sec.gov/x) or https://sec.gov/y.'), [
    { kind: 'text', text: 'Per ' },
    { kind: 'code', text: '10-K' },
    { kind: 'text', text: ', ' },
    { kind: 'strong', children: [{ kind: 'text', text: 'net debt ' }, { kind: 'em', children: [{ kind: 'text', text: 'rose' }] }] },
    { kind: 'text', text: ' — see ' },
    { kind: 'link', href: 'https://www.sec.gov/x', children: [{ kind: 'text', text: 'Item 7' }] },
    { kind: 'text', text: ' or ' },
    { kind: 'link', href: 'https://sec.gov/y', children: [{ kind: 'text', text: 'https://sec.gov/y' }] },
    { kind: 'text', text: '.' },
  ])
})

test('a link that is not https stays text', () => {
  assert.deepEqual(parseInline('[run](javascript:alert(1)) and [file](file:///etc/passwd)'), [{ kind: 'text', text: '[run](javascript:alert(1)) and [file](file:///etc/passwd)' }])
})

test('a citation tag is an inline node around its sentence, with its attributes; a stray closing tag is dropped', () => {
  assert.deepEqual(parseInline('<cite document_id="55" chunk_id="1020" quote="a $200.0 million">The revolver is **$200.0 million**.</cite> Then </cite> more <cite document_id="9" chunk_id="1"/> end'), [
    {
      kind: 'cite',
      attrs: { document_id: '55', chunk_id: '1020', quote: 'a $200.0 million' },
      children: [{ kind: 'text', text: 'The revolver is ' }, { kind: 'strong', children: [{ kind: 'text', text: '$200.0 million' }] }, { kind: 'text', text: '.' }],
    },
    { kind: 'text', text: ' Then  more ' },
    { kind: 'cite', attrs: { document_id: '9', chunk_id: '1' }, children: [] },
    { kind: 'text', text: ' end' },
  ])
})

test('a table splits on pipes outside tags, so a quote of a table row keeps its cell', () => {
  const [table] = parseMarkdown('| Region | FY25 |\n|---|---|\n| <cite document_id="1" chunk_id="2" quote="Americas | 167,045 | 162,560">Americas</cite> | 167,045 |')
  assert.equal(table?.kind, 'table')
  if (table?.kind !== 'table') return
  assert.equal(table.rows[0]!.length, 2)
  assert.deepEqual(table.rows[0]![0], [{ kind: 'cite', attrs: { document_id: '1', chunk_id: '2', quote: 'Americas | 167,045 | 162,560' }, children: [{ kind: 'text', text: 'Americas' }] }])
  assert.deepEqual(table.rows[0]![1], [{ kind: 'text', text: '167,045' }])
})
