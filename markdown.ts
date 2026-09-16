import { parseCitationTags } from './citations.ts'

// The Markdown an analyst writes, read into a small tree the view renders as React elements, never
// as HTML: headings, paragraphs, lists, fenced code, tables, quotes, rules, and inside them code,
// strong, emphasis, links, and citation tags around sourced sentences. Only https links survive,
// since they open in the browser through the bridge. Anything else reads as the text it is. Pure,
// so the reading can be checked in a test.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'cite'; attrs: Record<string, string>; children: Inline[] }

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'quote'; children: Inline[] }
  | { kind: 'rule' }

const FENCE = /^```\s*([\w+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const INLINE =
  /(`[^`\n]+`)|\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|\*\*((?:[^*]|\*[^*\n]+\*)+?)\*\*|\*([^*\s](?:[^*\n]*[^*\s])?)\*|(https:\/\/[^\s<>()]+)/g

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      i++
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, children: parseInline(heading[2] ?? '') })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!)) {
      const align = cells(lines[i + 1]!).map(alignOf)
      const header = cells(line).map(parseInline)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') rows.push(cells(lines[i++]!).map(parseInline))
      blocks.push({ kind: 'table', align, header, rows })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      const ordered = numbered !== null
      const items: string[] = []
      while (i < lines.length) {
        const item = (ordered ? NUMBERED : BULLET).exec(lines[i]!)
        if (item) items.push(item[1] ?? '')
        else if (items.length > 0 && /^\s{2,}\S/.test(lines[i]!)) items[items.length - 1] += ` ${lines[i]!.trim()}`
        else break
        i++
      }
      blocks.push({ kind: 'list', ordered, items: items.map((item) => parseInline(item.trim())) })
      continue
    }
    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (i < lines.length && lines[i]!.startsWith('>')) quoted.push(lines[i++]!.replace(/^>\s?/, '').trim())
      blocks.push({ kind: 'quote', children: parseInline(quoted.join(' ')) })
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines, i)) paragraph.push(lines[i++]!.trim())
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) })
  }
  return blocks
}

/** Inline text: citation tags first, since their attributes may hold any character, then the marks between them. */
export function parseInline(source: string): Inline[] {
  const tags = parseCitationTags(source)
  if (tags.length === 0) return parseMarks(source)
  const out: Inline[] = []
  let at = 0
  for (const tag of tags) {
    out.push(...parseMarks(source.slice(at, tag.start)))
    out.push({ kind: 'cite', attrs: tag.attrs, children: parseInline(tag.inner) })
    at = tag.end
  }
  out.push(...parseMarks(source.slice(at)))
  return mergeText(out)
}

/** A stray closing tag is not text. */
const STRAY_CLOSE = /<\/(?:cite|dbcitation)\s*>/gi

function parseMarks(raw: string): Inline[] {
  const source = raw.replace(STRAY_CLOSE, '')
  const out: Inline[] = []
  const text = (value: string): void => {
    if (!value) return
    const last = out[out.length - 1]
    if (last?.kind === 'text') last.text += value
    else out.push({ kind: 'text', text: value })
  }
  let at = 0
  for (const match of source.matchAll(INLINE)) {
    const index = match.index ?? 0
    text(source.slice(at, index))
    at = index + match[0].length
    const [, code, label, href, strong, em, bare] = match
    if (code !== undefined) out.push({ kind: 'code', text: code.slice(1, -1) })
    else if (label !== undefined && href !== undefined) out.push({ kind: 'link', href, children: parseInline(label) })
    else if (strong !== undefined) out.push({ kind: 'strong', children: parseInline(strong) })
    else if (em !== undefined) out.push({ kind: 'em', children: parseInline(em) })
    else if (bare !== undefined) {
      // Punctuation ending a sentence is not part of the link.
      const url = bare.replace(/[.,;:!?]+$/, '')
      out.push({ kind: 'link', href: url, children: [{ kind: 'text', text: url }] })
      at -= bare.length - url.length
    }
  }
  text(source.slice(at))
  return out
}

/** A paragraph ends where another block starts. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    line.startsWith('>') ||
    (line.includes('|') && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!))
  )
}

/** Adjacent text runs joined, so a dropped tag leaves one node where a reader expects one. */
function mergeText(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    const last = out[out.length - 1]
    if (node.kind === 'text' && last?.kind === 'text') last.text += node.text
    else if (node.kind !== 'text' || node.text) out.push(node)
  }
  return out
}

/** The cells of a table row: split on pipes, except a pipe inside a tag, whose quote may hold one. */
function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cell = ''
  let inTag = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (!inTag && ch === '<' && /^<(?:cite|dbcitation)\b/i.test(trimmed.slice(i))) inTag = true
    else if (inTag && ch === '>') inTag = false
    if (ch === '|' && !inTag) {
      out.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  out.push(cell.trim())
  return out
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null
}
