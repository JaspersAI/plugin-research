import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analystIdOf, mergeAnalysts, parseAnalyst, resolveAnalysts, serializeAnalyst, summaryOf, type Analyst, type AnalystInput } from './analysts.ts'

const CREDIT = `---
name: Credit Analyst
description: Debt maturities and covenants from filings
connections: [jaspers/sec]
max-turns: 40
color: "#1E3A5F"
---

Extract ALL debt issuance details.
`

test('a file becomes an analyst: the frontmatter, and the body as instructions', () => {
  assert.deepEqual(parseAnalyst('credit', CREDIT, 'preset'), {
    id: 'credit',
    name: 'Credit Analyst',
    description: 'Debt maturities and covenants from filings',
    model: null,
    connections: ['jaspers/sec'],
    tools: [],
    maxTurns: 40,
    color: '#1E3A5F',
    instructions: 'Extract ALL debt issuance details.',
    origin: 'preset',
    error: null,
  })
})

test('only a name and instructions are needed; the rest has defaults', () => {
  const analyst = parseAnalyst('basic', '---\nname: Basic Analyst\n---\nReason with data.', 'user')
  assert.equal(analyst.error, null)
  assert.equal(analyst.maxTurns, 50)
  assert.deepEqual([analyst.description, analyst.model, analyst.connections, analyst.tools, analyst.color], ['', null, [], [], null])
})

test('a file that breaks a rule is still an analyst, carrying what to fix', () => {
  const cases: [string, string, RegExp][] = [
    ['credit', 'Extract debt.', /has to start with a --- line/],
    ['credit', '---\nname: Credit\nExtract debt.', /has to start with a --- line/],
    ['credit', '---\ndescription: x\n---\nBody', /name is missing/],
    ['credit', '---\nname: Credit\nmaxturns: 3\n---\nBody', /unknown field maxturns; the fields are name, description/],
    ['credit', '---\nname: Credit\nmax-turns: 0\n---\nBody', /max-turns has to be a whole number from 1 to 200/],
    ['credit', '---\nname: Credit\ncolor: blue\n---\nBody', /color has to be #rrggbb/],
    ['credit', '---\nname: Credit\nconnections: {a: 1}\n---\nBody', /connections has to be a list of names/],
    ['credit', '---\nname: Credit\n---\n', /the instructions, the text after the frontmatter, are empty/],
    ['credit', `---\nname: Credit\n---\n${'x'.repeat(10_001)}`, /the most is 10000/],
    ['credit', '---\nname: [a\n---\nBody', /the frontmatter is not valid YAML/],
    ['credit', '---\n- a\n- b\n---\nBody', /key: value lines/],
    ['Credit Analyst', '---\nname: Credit\n---\nBody', /lower case letters, digits, and dashes/],
  ]
  for (const [id, text, expected] of cases) {
    const analyst = parseAnalyst(id, text, 'user')
    assert.match(analyst.error ?? '', expected, text)
    assert.equal(analyst.id, id)
  }
})

test('what save writes reads back as the same analyst', () => {
  const input: AnalystInput = {
    id: 'covenant-watch',
    name: 'Covenant Watch',
    description: 'Tracks covenant breaches: #1 risk, quoted "exactly"',
    instructions: 'You track covenant breaches.\n\nCite the filing.',
    model: 'claude-sonnet-5',
    connections: ['jaspers/sec'],
    tools: ['search_filings'],
    maxTurns: 30,
    color: '#1E3A5F',
  }
  const text = serializeAnalyst(input)
  assert.equal(text.startsWith('---\nname: Covenant Watch\n'), true)
  const analyst = parseAnalyst(input.id, text, 'user')
  assert.equal(analyst.error, null)
  assert.deepEqual(
    [analyst.name, analyst.description, analyst.instructions, analyst.model, analyst.connections, analyst.tools, analyst.maxTurns, analyst.color],
    [input.name, input.description, input.instructions, input.model, input.connections, input.tools, input.maxTurns, input.color],
  )
})

test('save leaves defaults out of the file', () => {
  const text = serializeAnalyst({ id: 'basic', name: 'Basic', description: '', instructions: ' Reason. ', maxTurns: 50, connections: [], color: null })
  assert.equal(text, '---\nname: Basic\n---\n\nReason.\n')
})

test("a user's file replaces the preset with its id, and the roster is sorted by name", () => {
  const preset = (id: string, name: string): Analyst => parseAnalyst(id, `---\nname: ${name}\n---\nBody`, 'preset')
  const merged = mergeAnalysts(
    [preset('risk', 'Risk Analyst'), preset('credit', 'Credit Analyst')],
    [parseAnalyst('risk', '---\nname: Risk, terse\n---\nShort.', 'user'), parseAnalyst('broken', 'nope', 'user')],
  )
  assert.deepEqual(
    merged.map((a) => [a.id, a.origin]),
    [
      ['broken', 'user'],
      ['credit', 'preset'],
      ['risk', 'user'],
    ],
  )
})

test('a file name gives an id, and a summary leaves the instructions out', () => {
  assert.equal(analystIdOf('plugin:analysts/fact-checker.md'), 'fact-checker')
  assert.equal(analystIdOf('analysts/notes.txt'), null)
  assert.equal('instructions' in summaryOf(parseAnalyst('credit', CREDIT, 'preset')), false)
})

test('a requested analyst is found by id, by name, or by the one id its words contain', () => {
  const file = (id: string, name: string): Analyst => parseAnalyst(id, `---\nname: ${name}\n---\nBody`, 'preset')
  const all = [
    file('basic', 'Basic Analyst'),
    file('credit', 'Credit Analyst'),
    file('qoq-credit-diff', 'QoQ Credit Diff'),
    file('ownership', 'Ownership Analyst'),
    file('fact-checker', 'Fact-checker'),
    file('risk', 'Risk Analyst'),
    { ...file('broken', 'Broken'), error: 'name is missing' },
  ]
  assert.deepEqual(resolveAnalysts(all, ['credit', 'Risk Analyst', 'ownership-researcher', 'fact checker', 'credit-analyst']), {
    ids: ['credit', 'risk', 'ownership', 'fact-checker'],
    unmatched: [],
  })
  assert.deepEqual(resolveAnalysts(all, ['qoq credit diff', 'macro-strategist', 'broken', 'analyst']), {
    ids: ['qoq-credit-diff'],
    unmatched: ['macro-strategist', 'broken', 'analyst'],
  })
})
