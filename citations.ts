// Citations: the tags an analyst wraps its sourced sentences in, the numbers they get, the verdicts
// the server gives them, and the links that open each source on the quoted words. An analyst writes <cite document_id chunk_id quote>fact</cite>
// (or <dbcitation document_id section_key quote> for a Filing Database section); the room sends
// every tag's ids and quote to the connection's show_citations tool, which finds the quote in the
// source and answers with the sec.gov page that opens on it highlighted. A quote from a view's text,
// like a transcript on the workspace, is <cite panel quote> instead, and the room checks it itself
// against the text. Pure: the reading and the numbering can be checked in a test, and the view
// numbers the same way the runner does.

export interface CitationTag {
  kind: 'cite' | 'dbcitation'
  attrs: Record<string, string>
  /** The sentence the tag wraps; empty for a self-closing or unclosed tag used as a marker. */
  inner: string
  start: number
  end: number
}

/** One passage an answer cites, numbered in order of first appearance: a source and the quote from it. */
export interface NumberedCitation {
  n: number
  /** The source: document and chunk, or document and section. Two citations may share one. */
  key: string
  attrs: Record<string, string>
  quote: string
  claim: string
}

/** A numbered citation after the server has looked at it, or before, with nothing known. */
export interface Citation {
  n: number
  key: string
  documentId: string
  chunkId: string | null
  sectionKey: string | null
  /** The element whose text the quote is from, for a citation of a view; null or missing for a filing, and in answers saved before views could be cited. */
  panel?: string | null
  quote: string
  claim: string
  /** The words the server found the quote in, as its source has them; null when it found none. */
  passage: string | null
  /** The server's link to the source, as it gave it; `citationLink` is the one to open. Null until resolved. */
  url: string | null
  /** "10-K · 2025-09-05 · FLWS", or null until resolved. */
  title: string | null
  /** null until the server has answered, or when no server can. */
  verified: boolean | null
  match: 'exact' | 'prefix' | 'none' | null
}

/** What the audit of an answer found, and whether the analyst got a repair turn for it. */
export interface Audit {
  uncited: number
  unverified: number
  repaired: boolean
}

/** What the server says about one source, keyed the way the tags are. */
export interface ServerRef {
  key: string
  verified: boolean
  match: 'exact' | 'prefix' | 'none'
  url: string | null
  title: string | null
  sourceQuote: string | null
}

const OPEN_TAG = /<(cite|dbcitation)\b([^>]*)>/gi
const ATTR = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'>]+))/g
const CLOSE_TAG = /<\/(?:cite|dbcitation)\s*>/gi

/** Every tag in the text, in order, with where it sits. A closing tag with no opening one is not a tag. */
export function parseCitationTags(text: string): CitationTag[] {
  const tags: CitationTag[] = []
  const opens = [...text.matchAll(OPEN_TAG)]
  for (const [i, open] of opens.entries()) {
    const start = open.index ?? 0
    const kind = open[1]!.toLowerCase() as CitationTag['kind']
    const rawAttrs = open[2] ?? ''
    const selfClosing = /\/\s*$/.test(rawAttrs)
    const attrs = readAttrs(rawAttrs)
    const openEnd = start + open[0].length
    if (selfClosing) {
      tags.push({ kind, attrs, inner: '', start, end: openEnd })
      continue
    }
    // The inner text runs to this tag's closing tag, unless another tag opens first: then it never closed.
    const nextOpen = opens[i + 1]?.index ?? text.length
    CLOSE_TAG.lastIndex = openEnd
    const close = CLOSE_TAG.exec(text)
    if (close && close.index <= nextOpen) {
      tags.push({ kind, attrs, inner: text.slice(openEnd, close.index), start, end: close.index + close[0].length })
    } else {
      tags.push({ kind, attrs, inner: '', start, end: openEnd })
    }
  }
  return tags
}

/** The panel a tag quotes a view's text from, when it names one and no document. */
export function citedPanel(attrs: Record<string, string>): string | null {
  return !(attrs['document_id'] ?? attrs['article_id'] ?? attrs['call_id']) && attrs['panel'] ? attrs['panel'] : null
}

/** What names a source: the document and its chunk, the document and its section, or a view's panel. Null for a tag with no id. */
export function citationKey(attrs: Record<string, string>): string | null {
  const panel = citedPanel(attrs)
  if (panel) return `panel:${panel}`
  const id = attrs['document_id'] ?? attrs['article_id'] ?? attrs['call_id']
  if (!id) return null
  const part = attrs['section_key'] ?? attrs['chunk_id'] ?? ''
  return `${id}:${part === 'N/A' ? '' : part}`
}

/** What gets a number of its own: the source and the quote. Two tags quoting the same words share one. */
export function numberKey(attrs: Record<string, string>): string | null {
  const key = citationKey(attrs)
  return key === null ? null : `${key}\n${(attrs['quote'] ?? '').trim()}`
}

/** The passages an answer cites, each once, numbered as they first appear. Each is its own link, on its own words. */
export function numberCitations(text: string): NumberedCitation[] {
  const seen = new Map<string, NumberedCitation>()
  for (const tag of parseCitationTags(text)) {
    const key = citationKey(tag.attrs)
    const slot = numberKey(tag.attrs)
    if (key === null || slot === null) continue
    const claim = tag.inner.replace(/\s+/g, ' ').trim()
    const found = seen.get(slot)
    if (found) {
      if (!found.claim && claim) found.claim = claim
      continue
    }
    seen.set(slot, { n: seen.size + 1, key, attrs: tag.attrs, quote: (tag.attrs['quote'] ?? '').trim(), claim })
  }
  return [...seen.values()]
}

/**
 * The text with each tag turned into its sentence and a [n] marker, for a reader without the view.
 * A piece of an answer takes its numbers from the whole answer, so its markers match the view's.
 */
export function toMarkers(text: string, numbered: NumberedCitation[] = numberCitations(text)): string {
  const numbers = new Map(numbered.map((c) => [numberKey(c.attrs), c.n]))
  return rewrite(text, (tag) => {
    const slot = numberKey(tag.attrs)
    const n = slot === null ? undefined : numbers.get(slot)
    const inner = tag.inner.trim()
    if (n === undefined) return inner
    return inner ? `${inner} [${n}]` : `[${n}]`
  })
}

/** What a source is called: the server's title for it, or its ids until the server has named it. */
export function sourceTitle(numbered: NumberedCitation, citation: Citation | undefined): string {
  const { attrs } = numbered
  const panel = citedPanel(attrs)
  if (panel) return citation?.title ?? `View ${panel}`
  return (
    citation?.title ??
    `Document ${attrs['document_id'] ?? '?'}${attrs['chunk_id'] ? ` · chunk ${attrs['chunk_id']}` : ''}${attrs['section_key'] ? ` · ${attrs['section_key']}` : ''}`
  )
}

/** The text with the tags gone and their sentences kept. */
export function stripCitations(text: string): string {
  return rewrite(text, (tag) => tag.inner.trim())
}

/** Every tag replaced by what `render` makes of it; a stray closing tag goes too. */
function rewrite(text: string, render: (tag: CitationTag) => string): string {
  let out = ''
  let at = 0
  for (const tag of parseCitationTags(text)) {
    out += text.slice(at, tag.start) + render(tag)
    at = tag.end
  }
  return (out + text.slice(at)).replace(CLOSE_TAG, '')
}

/** A sentence with this many words states something, cited or not. */
const MIN_WORDS = 8
const MAX_UNCITED = 25
const MAX_SENTENCE = 400
const FIGURE = /\d|\$|%/
const HEADING = /^\s{0,3}#{1,6}\s/
const TABLE_ROW = /^\s*\|/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}/
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+/
const FENCE = /^\s*```/
const TURN_LIMIT = /^Stopped at the \d+-turn limit\./
const BOUNDARY = /[.!?]["'”’)\]]*\s+(?=[A-Z0-9$(["“])/g
const ABBREVIATIONS = new Set(
  'inc corp co ltd llc plc mr mrs ms dr vs no st u.s e.g i.e jan feb mar apr jun jul aug sep sept oct nov dec fig approx est'.split(' '),
)

/**
 * The sentences of a draft that state something without a citation: any with a figure in it, or
 * long enough to be a claim. Headings, tables, code, and the turn-limit line are not sentences. A
 * sentence anywhere inside a tag counts as cited, so a tag around two sentences covers both.
 */
export function uncitedSentences(draft: string): string[] {
  const tags = parseCitationTags(draft)
  const masked = maskTags(draft, tags)
  const cited = (start: number, end: number): boolean => tags.some((t) => t.start < end && t.end > start)
  const found: string[] = []
  let at = 0
  let inFence = false
  for (const line of masked.split('\n')) {
    const lineStart = at
    at += line.length + 1
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || HEADING.test(line) || TABLE_SEPARATOR.test(line) || TABLE_ROW.test(line) || TURN_LIMIT.test(line.trim())) continue
    const bullet = BULLET.exec(line)
    const offset = bullet ? bullet[0].length : 0
    for (const [s, e] of sentenceSpans(line.slice(offset))) {
      const start = lineStart + offset + s
      const end = lineStart + offset + e
      if (cited(start, end)) continue
      const text = masked.slice(start, end).replace(/\s+/g, ' ').trim()
      if (!text) continue
      const words = text.split(' ').filter((w) => /[A-Za-z0-9]/.test(w)).length
      if (!FIGURE.test(text) && words < MIN_WORDS) continue
      found.push(text.length > MAX_SENTENCE ? `${text.slice(0, MAX_SENTENCE)}…` : text)
      if (found.length >= MAX_UNCITED) return found
    }
  }
  return found
}

/** Tags replaced by spaces of the same length, so offsets hold and attribute text ends no sentence. */
function maskTags(text: string, tags: CitationTag[]): string {
  let out = text
  for (const tag of tags) {
    const openEnd = text.indexOf('>', tag.start) + 1
    out = blank(out, tag.start, openEnd)
    if (tag.end > openEnd + tag.inner.length) out = blank(out, openEnd + tag.inner.length, tag.end)
  }
  return out.replace(CLOSE_TAG, (m) => ' '.repeat(m.length))
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(Math.max(0, end - start)) + text.slice(end)
}

/** Where each sentence of a segment starts and ends, splitting at sentence ends that are not abbreviations. */
function sentenceSpans(segment: string): [number, number][] {
  const spans: [number, number][] = []
  let start = 0
  for (const match of segment.matchAll(BOUNDARY)) {
    const index = match.index ?? 0
    const before = segment.slice(start, index + 1)
    const lastWord = /([A-Za-z.]+)\.$/.exec(before)?.[1]?.toLowerCase().replace(/\.$/, '')
    if (lastWord && (ABBREVIATIONS.has(lastWord) || /^[a-z]$/.test(lastWord))) continue
    spans.push([start, index + 1])
    start = index + match[0].length
  }
  if (start < segment.length) spans.push([start, segment.length])
  return spans
}

/**
 * What show_citations takes: one claim per numbered citation, ids as the server's schema types them.
 * A tag with no quote offers its sentence as the quote: a sentence copied from the source verifies
 * on its opening words, and one that was not comes back unverified, which the repair then says.
 */
export function claimsFor(numbered: NumberedCitation[]): Record<string, unknown>[] {
  return numbered.map((c) => {
    const claim: Record<string, unknown> = { claim: c.claim || c.quote, quote: c.quote || c.claim }
    const document = c.attrs['document_id']
    if (document !== undefined) claim['document_id'] = /^\d+$/.test(document) ? Number(document) : document
    if (c.attrs['section_key']) claim['section_key'] = c.attrs['section_key']
    else if (c.attrs['chunk_id'] && c.attrs['chunk_id'] !== 'N/A') claim['chunk_id'] = /^\d+$/.test(c.attrs['chunk_id']) ? Number(c.attrs['chunk_id']) : c.attrs['chunk_id']
    return claim
  })
}

/** The refs in show_citations' answer, keyed like the tags. Anything that is not that answer reads as none. */
export function readShowCitations(text: string): ServerRef[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { citations?: unknown }).citations)) return []
  const refs: ServerRef[] = []
  for (const raw of (parsed as { citations: unknown[] }).citations) {
    if (typeof raw !== 'object' || raw === null) continue
    const ref = raw as Record<string, unknown>
    const key = citationKey({
      ...(ref['document_id'] !== undefined && ref['document_id'] !== null ? { document_id: String(ref['document_id']) } : {}),
      ...(ref['chunk_id'] !== undefined && ref['chunk_id'] !== null ? { chunk_id: String(ref['chunk_id']) } : {}),
      ...(typeof ref['section_key'] === 'string' ? { section_key: ref['section_key'] } : {}),
    })
    if (key === null) continue
    const match = ref['match']
    const title = [ref['form_type'], ref['filing_date'], ref['ticker']].filter((v) => typeof v === 'string' && v).join(' · ')
    refs.push({
      key,
      verified: ref['verified'] === true,
      match: match === 'exact' || match === 'prefix' ? match : 'none',
      url: typeof ref['url'] === 'string' ? ref['url'] : typeof ref['source_url'] === 'string' ? ref['source_url'] : typeof ref['index_url'] === 'string' ? ref['index_url'] : null,
      title: title || null,
      sourceQuote: typeof ref['source_quote'] === 'string' ? ref['source_quote'] : null,
    })
  }
  return refs
}

/**
 * The numbered citations with what the server said about each; one it did not mention stays unknown.
 * The server answers per source, so the caller sends it citations with distinct sources at a time.
 */
export function resolveCitations(numbered: NumberedCitation[], refs: ServerRef[]): Citation[] {
  const byKey = new Map(refs.map((r) => [r.key, r]))
  return numbered.map((c) => {
    const ref = byKey.get(c.key)
    return {
      n: c.n,
      key: c.key,
      documentId: c.attrs['document_id'] ?? c.attrs['article_id'] ?? c.attrs['call_id'] ?? '',
      chunkId: c.attrs['chunk_id'] && c.attrs['chunk_id'] !== 'N/A' ? c.attrs['chunk_id'] : null,
      sectionKey: c.attrs['section_key'] ?? null,
      panel: citedPanel(c.attrs),
      quote: c.quote,
      claim: c.claim,
      passage: ref?.sourceQuote ?? null,
      url: ref?.url ?? null,
      title: ref?.title ?? null,
      verified: ref ? ref.verified : null,
      match: ref ? ref.match : null,
    }
  })
}

/**
 * The citations of views' texts, checked here, since no server holds a view: each quote has to be in
 * the text of the panel it names, whatever the spacing, the case, or the quote marks, which models
 * change when they copy. `texts` is each panel's text by the id a tag names it by. The title is the
 * text's first line, which names what it is; a panel with no text is only its id.
 */
export function resolveViewCitations(numbered: NumberedCitation[], texts: ReadonlyMap<string, string>): Citation[] {
  const citations: Citation[] = []
  for (const c of numbered) {
    const panel = citedPanel(c.attrs)
    if (!panel) continue
    const text = texts.get(panel)
    const found = text !== undefined && c.quote !== '' && looseText(text).includes(looseText(c.quote))
    citations.push({
      n: c.n,
      key: c.key,
      documentId: '',
      chunkId: null,
      sectionKey: null,
      panel,
      quote: c.quote,
      claim: c.claim,
      passage: null,
      url: null,
      title: text?.split('\n', 1)[0]?.trim() || `View ${panel}`,
      verified: found,
      match: found ? 'exact' : 'none',
    })
  }
  return citations
}

/** Text as a quote of it is compared: one kind of quote mark and dash, single spaces, lower case. */
function looseText(text: string): string {
  return text
    .replace(/[‘’‚‛′`´"“”„‟″]/g, "'")
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * The link a citation opens: the server's page for its source, with a text directive that highlights
 * the passage. The server's own directive takes the passage's first and last words as they are, and
 * a browser misses those where table cells ran together in the source text or a word sits against a
 * symbol the page sets apart; this one takes words that read the same on the page. An index page, a
 * link with some other fragment, or a passage with no such words keeps the server's link.
 */
export function citationLink(citation: { url: string | null; passage?: string | null; quote: string }): string | null {
  const { url } = citation
  if (!url) return null
  const hash = url.indexOf('#')
  if (hash >= 0 && !url.startsWith('#:~:', hash)) return url
  const page = hash >= 0 ? url.slice(0, hash) : url
  if (/-index\.html?$/i.test(page)) return url
  const fragment = textFragment(citation.passage || citation.quote)
  return fragment ? page + fragment : url
}

/** How many words the opening and closing terms take, and the longest passage highlighted as one term. */
const START_WORDS = 8
const END_WORDS = 5
const WHOLE_WORDS = 10
const JSON_FIELD = /"[\w ]+"\s*:/
const JSON_STRING_VALUE = /"[^"]*"\s*:\s*"([^"]+)"/g

/**
 * The `#:~:text=` directive that highlights a passage on its rendered page, or '' when none of its
 * words can be trusted to read the same there. A browser finds each term inside one block of text
 * and at word boundaries, so terms come from runs of plain words (`wordRuns`): prose runs from its
 * first run with three words that say something to the end of its last, or is one term when that is
 * a single short run; a table row, whose cells the page sets apart, runs from its first figure to its
 * last; and structured data is found by its longest quoted value of two or more words, like a name.
 */
export function textFragment(passage: string): string {
  let text = plainText(passage)
  if (JSON_FIELD.test(text)) {
    const values = [...text.matchAll(JSON_STRING_VALUE)].map((m) => m[1]!).filter((v) => v.trim().split(/\s+/).length >= 2)
    if (values.length === 0) return ''
    text = values.reduce((a, b) => (b.length > a.length ? b : a))
  }
  const runs = wordRuns(text)
  const prose = runs.filter((run) => run.length >= 3 && run.filter((word) => /[A-Za-z]/.test(word)).length >= 2)
  let terms = isTableRow(text, runs, prose) || prose.length === 0 ? figureTerms(runs) : null
  if (!terms && prose.length > 0) {
    const start = prose.find((run) => contentWords(run) >= 3) ?? prose.reduce((a, b) => (contentWords(b) > contentWords(a) ? b : a))
    const end = prose[prose.length - 1]!
    if (end !== start) terms = [start.slice(0, START_WORDS), end.slice(-END_WORDS)]
    else if (start.length <= WHOLE_WORDS) terms = [start]
    else terms = [start.slice(0, Math.min(START_WORDS, start.length - END_WORDS)), start.slice(-END_WORDS)]
  }
  return terms ? `#:~:text=${terms.map((words) => encodeTerm(words.join(' '))).join(',')}` : ''
}

/** Words too common to find a passage by: small words, and month names, since a date opens so many sentences in a filing. */
const COMMON_WORDS = new Set(
  'a an and as at by for from in into is it of on or the to was were with its their this that than be been has have had which who per january february march april may june july august september october november december'.split(' '),
)

/** How many of a run's words say something: words with letters that are not common words. */
function contentWords(run: string[]): number {
  return run.filter((word) => {
    const bare = word.toLowerCase().replace(/[.,;:]+$/, '')
    return /[a-z]/.test(bare) && !COMMON_WORDS.has(bare)
  }).length
}

/** Marks that start a run of plain words and marks that end one, since a page may set either apart. */
const OPENERS = new Set(['"', '“', '”', "'", '‘', '’', '(', '[', '{', '$', '€', '£'])
const CLOSERS = new Set(['"', '“', '”', "'", '‘', '’', ')', ']', '}', '%', '®', '™', '*', '†', '‡'])
const PUNCTUATION = new Set([',', '.', ';', ':', '!', '?'])
const PLAIN_WORD = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.,'’&/-]*[A-Za-z0-9])?|&)$/
/** Where table cells ran together in source text: a pipe or a line, or letters against digits or a dollar sign. */
const CELL_BREAK = /[|\n\r\t]+/
const GLUED = /(?<=[A-Za-z)])(?=\$)|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z]{2,})/
const GLUED_ANYWHERE = /[A-Za-z)]\$|[a-z]\d|\d[a-z]{2,}/
const EMPTY_CELL = /(^|\s)\$?[-—–](\s|$)/

/**
 * The runs of words in a passage that should read on the page exactly as they read here. A run ends
 * at a table cell, at a quote mark, bracket, currency or percent sign, and at a word holding anything
 * else a page may render differently, so a term taken from one run is text a browser finds whole.
 */
export function wordRuns(text: string): string[][] {
  const runs: string[][] = []
  for (const segment of text.split(CELL_BREAK).flatMap((part) => part.split(GLUED))) {
    let run: string[] = []
    const close = (): void => {
      if (run.length > 0) runs.push(run)
      run = []
    }
    for (const raw of segment.trim().split(/\s+/)) {
      let word = raw
      let opened = false
      while (word && OPENERS.has(word[0]!)) {
        word = word.slice(1)
        opened = true
      }
      let end = word.length
      let closed = false
      while (end > 0 && (CLOSERS.has(word[end - 1]!) || PUNCTUATION.has(word[end - 1]!))) {
        if (CLOSERS.has(word[end - 1]!)) closed = true
        end--
      }
      const core = word.slice(0, end)
      if (!PLAIN_WORD.test(core)) {
        close()
        continue
      }
      if (opened) close()
      run.push(closed ? core : word)
      if (closed) close()
    }
    close()
  }
  return runs
}

/** A table row: pipes, cells run together, an empty cell beside a figure, or figures with too few words for prose. */
function isTableRow(text: string, runs: string[][], prose: string[][]): boolean {
  const figures = runs.flat().filter(isFigure).length
  const longest = Math.max(0, ...prose.map((run) => run.length))
  return text.includes('|') || GLUED_ANYWHERE.test(text) || (EMPTY_CELL.test(text) && figures >= 1) || (figures >= 2 && longest < 5)
}

/** A figure distinctive enough to find a row by: grouped thousands, or four digits or more that are not a year. */
function isFigure(word: string): boolean {
  const figure = word.replace(/[.,;:]+$/, '')
  return (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(figure) || /^\d{4,}(\.\d+)?$/.test(figure)) && !/^(19|20)\d{2}$/.test(figure)
}

/** A row's first and last figures as terms, one when they are the same. */
function figureTerms(runs: string[][]): string[][] | null {
  const figures = runs.flat().filter(isFigure).map((word) => word.replace(/[.,;:]+$/, ''))
  if (figures.length === 0) return null
  const first = figures[0]!
  const last = figures[figures.length - 1]!
  return last === first ? [[first]] : [[first], [last]]
}

/** A term as a text directive needs it: `-`, `,`, and `&` are the directive's own syntax, so they are encoded. */
function encodeTerm(term: string): string {
  return encodeURIComponent(term).replace(/-/g, '%2D')
}

/** Text with what a model or a converter added taken back out: backslash escapes, HTML entities, Markdown marks. */
function plainText(text: string): string {
  return unescapeText(text).replace(/\*\*|__|`/g, '').replace(/\u00a0/g, ' ')
}

const ENTITIES: Record<string, string> = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ' }

/** A value with JSON's backslash escapes and HTML's entities undone, as a model may have copied them from a tool result. */
function unescapeText(value: string): string {
  return value
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\([^\sA-Za-z0-9])/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    })
}

/** The message that sends a draft back for repair, or null when the audit found nothing. */
export function buildRepairMessage(report: { uncited: string[]; unverified: { n: number; tag: string; quote: string; reason: string }[] }): string | null {
  if (report.uncited.length === 0 && report.unverified.length === 0) return null
  const parts = [
    'A citation audit of your draft found the problems below. Reply with the COMPLETE corrected response - the full text, not a diff or a summary of changes - keeping everything that was not flagged identical.',
  ]
  if (report.uncited.length > 0) {
    parts.push(
      'Sentences that state tool-derived facts without a citation. For each one either add a citation tag whose quote="…" is copied verbatim from a tool result already in this conversation, remove the claim, or rewrite it so it is clearly your own reasoning:\n' +
        report.uncited.map((s, i) => `${i + 1}. "${s}"`).join('\n'),
    )
  }
  if (report.unverified.length > 0) {
    parts.push(
      'Citations whose quote could not be found in the cited source. Replace quote="…" with an exact excerpt copied from that source (same ids), or drop the citation together with the claim it supported:\n' +
        report.unverified.map((u, i) => `${i + 1}. ${u.tag} quote="${u.quote}" - ${u.reason}`).join('\n'),
    )
  }
  parts.push(
    'Rules: use only ids that appear in tool results; every <cite>/<dbcitation> tag carries quote="…" copied character-for-character (5-40 words, no double quotes inside); add no new claims; call a tool only when you must re-read a source to copy an exact quote; keep the structure, tables and formatting of the answer.',
  )
  return parts.join('\n\n')
}

function readAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of raw.replace(/\/\s*$/, '').matchAll(ATTR)) {
    attrs[match[1]!.toLowerCase()] = unescapeText(match[2] ?? match[3] ?? match[4] ?? '').trim()
  }
  return attrs
}
