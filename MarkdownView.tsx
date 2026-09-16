import { useMemo, type ReactElement, type ReactNode } from 'react'
import { citationLink, numberKey, type Citation } from './citations'
import { parseMarkdown, type Block, type Inline } from './markdown'

// An analyst's Markdown as React elements. Nothing here becomes HTML from a string: the parser reads
// the text into a tree and each node is an element, so an answer cannot inject markup. Links go out
// through the bridge, since the frame cannot open them. A citation tag renders as its sentence and a
// numbered marker that opens the source on sec.gov, on the quoted words, once the room has checked it.

/** The message's citations, as the markers need them: a number per passage, and what is known about each. */
export interface CiteLookup {
  numbers: Map<string, number>
  resolved: Map<number, Citation>
}

interface Render {
  onLink: (href: string) => void
  cite: CiteLookup | null
}

export function Markdown({ source, onLink, cite = null }: { source: string; onLink: (href: string) => void; cite?: CiteLookup | null }): ReactElement {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  const render: Render = { onLink, cite }
  return <div className="rs-md">{blocks.map((block, i) => renderBlock(block, i, render))}</div>
}

function renderBlock(block: Block, key: number, render: Render): ReactNode {
  const onLink = render.onLink
  switch (block.kind) {
    case 'heading':
      return (
        <div key={key} className={`rs-h rs-h${Math.min(block.level, 4)}`}>
          {inline(block.children, render)}
        </div>
      )
    case 'paragraph':
      return <p key={key}>{inline(block.children, render)}</p>
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}>{inline(item, render)}</li>)
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'code':
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      )
    case 'table':
      return (
        <div key={key} className="rs-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                    {inline(cell, render)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                      {inline(cell, render)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return <blockquote key={key}>{inline(block.children, render)}</blockquote>
    case 'rule':
      return <hr key={key} />
  }
  return null
}

function inline(nodes: Inline[], render: Render): ReactNode[] {
  const { onLink, cite } = render
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return node.text
      case 'code':
        return <code key={i}>{node.text}</code>
      case 'strong':
        return <strong key={i}>{inline(node.children, render)}</strong>
      case 'em':
        return <em key={i}>{inline(node.children, render)}</em>
      case 'link':
        return (
          <a
            key={i}
            href={node.href}
            title={node.href}
            onClick={(event) => {
              event.preventDefault()
              onLink(node.href)
            }}
          >
            {inline(node.children, render)}
          </a>
        )
      case 'cite': {
        const slot = numberKey(node.attrs)
        const n = slot === null ? undefined : cite?.numbers.get(slot)
        const citation = n === undefined ? undefined : cite?.resolved.get(n)
        return (
          <span key={i} className="rs-cited">
            {inline(node.children, render)}
            {n !== undefined && <CiteMark n={n} citation={citation} onLink={onLink} />}
          </span>
        )
      }
    }
    return null
  })
}

/** The [n] after a cited sentence: a link to the source once the room has one, a plain mark before. */
export function CiteMark({ n, citation, onLink }: { n: number; citation: Citation | undefined; onLink: (href: string) => void }): ReactElement {
  const state = citation?.verified === true ? 'rs-cite-ok' : citation?.verified === false ? 'rs-cite-bad' : 'rs-cite-pending'
  const url = citation ? citationLink(citation) : null
  if (!url) return <sup className={`rs-cite ${state}`}>[{n}]</sup>
  return (
    <sup className={`rs-cite ${state}`}>
      <a
        href={url}
        title={citation?.verified === false ? 'The quote was not found in the source; this opens the document.' : `Opens the filing on sec.gov with the quoted passage highlighted.`}
        onClick={(event) => {
          event.preventDefault()
          onLink(url)
        }}
      >
        [{n}]
      </a>
    </sup>
  )
}
