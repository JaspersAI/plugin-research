import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// Analysts are files: frontmatter saying who one is and what it may use, then the instructions it
// works by. This is the reading and the writing of those files, and the merge of the plugin's presets
// with the user's own, pure so the format can be read in a test. A file that breaks a rule still
// becomes an analyst, carrying the error, so the room can show the user what to fix.

export interface Analyst {
  id: string
  name: string
  description: string
  /** A model on the configured provider; null for the app's own. */
  model: string | null
  /** Connection ids whose tools it gets; empty for every ready connection. */
  connections: string[]
  /** Tool names it is limited to on those connections; empty for all of them. */
  tools: string[]
  maxTurns: number
  /** #rrggbb for its square, or null. */
  color: string | null
  instructions: string
  origin: 'preset' | 'user'
  /** Why the file is not usable, worded for the user; null when it is. */
  error: string | null
}

/** What save-analyst writes: an analyst without what reading one adds. */
export interface AnalystInput {
  id: string
  name: string
  description: string
  instructions: string
  model?: string | null
  connections?: string[]
  tools?: string[]
  maxTurns?: number
  color?: string | null
}

export const ANALYST_ID = /^[a-z0-9][a-z0-9-]*$/
export const INSTRUCTIONS_MAX = 10_000
const NAME_MAX = 80
const DESCRIPTION_MAX = 500
const MODEL_MAX = 200
const MAX_TURNS_DEFAULT = 50
const MAX_TURNS_LIMIT = 200
const COLOR = /^#[0-9a-fA-F]{6}$/
const FIELDS = ['name', 'description', 'model', 'connections', 'tools', 'max-turns', 'color']
/** The frontmatter: a --- line, anything, and the next line that is only ---. */
const FRONTMATTER = /^---\n([\s\S]*?)^---[ \t]*$/m

export function parseAnalyst(id: string, text: string, origin: Analyst['origin']): Analyst {
  const analyst: Analyst = {
    id,
    name: id,
    description: '',
    model: null,
    connections: [],
    tools: [],
    maxTurns: MAX_TURNS_DEFAULT,
    color: null,
    instructions: '',
    origin,
    error: null,
  }
  try {
    if (!ANALYST_ID.test(id)) throw new Error('the file name has to be lower case letters, digits, and dashes, then .md')
    const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    const match = FRONTMATTER.exec(normalized)
    if (!match || match.index !== 0) throw new Error('the file has to start with a --- line, then the frontmatter, then a closing --- line')
    const data = frontmatter(match[1] ?? '')
    const unknown = Object.keys(data).filter((key) => !FIELDS.includes(key))
    if (unknown.length > 0) throw new Error(`unknown field ${unknown.join(', ')}; the fields are ${FIELDS.join(', ')}`)
    analyst.name = textField(data['name'], 'name', NAME_MAX, true)
    analyst.description = textField(data['description'], 'description', DESCRIPTION_MAX, false)
    analyst.model = textField(data['model'], 'model', MODEL_MAX, false) || null
    analyst.connections = names(data['connections'], 'connections')
    analyst.tools = names(data['tools'], 'tools')
    analyst.maxTurns = turns(data['max-turns'])
    analyst.color = color(data['color'])
    const body = normalized.slice(match[0].length).trim()
    if (body === '') throw new Error('the instructions, the text after the frontmatter, are empty')
    if (body.length > INSTRUCTIONS_MAX) throw new Error(`the instructions are ${body.length} characters; the most is ${INSTRUCTIONS_MAX}`)
    analyst.instructions = body
  } catch (err) {
    analyst.error = err instanceof Error ? err.message : String(err)
  }
  return analyst
}

export function serializeAnalyst(input: AnalystInput): string {
  const front: Record<string, unknown> = { name: input.name.trim() }
  if (input.description.trim()) front['description'] = input.description.trim()
  if (input.model?.trim()) front['model'] = input.model.trim()
  if (input.connections?.length) front['connections'] = input.connections
  if (input.tools?.length) front['tools'] = input.tools
  if (input.maxTurns !== undefined && input.maxTurns !== MAX_TURNS_DEFAULT) front['max-turns'] = input.maxTurns
  if (input.color) front['color'] = input.color
  return `---\n${stringifyYaml(front, { lineWidth: 0 }).trimEnd()}\n---\n\n${input.instructions.trim()}\n`
}

/** The presets with the user's files over them by id, sorted by name for the roster. */
export function mergeAnalysts(presets: Analyst[], users: Analyst[]): Analyst[] {
  const byId = new Map<string, Analyst>()
  for (const analyst of presets) byId.set(analyst.id, analyst)
  for (const analyst of users) byId.set(analyst.id, analyst)
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The id a file gives an analyst, or null for a file that is not one. */
export function analystIdOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : null
}

/** An analyst as a list shows it: everything but the instructions. */
export function summaryOf(analyst: Analyst): Omit<Analyst, 'instructions'> {
  const { instructions: _instructions, ...rest } = analyst
  return rest
}

function frontmatter(source: string): Record<string, unknown> {
  let data: unknown
  try {
    data = source.trim() === '' ? {} : parseYaml(source)
  } catch (err) {
    throw new Error(`the frontmatter is not valid YAML: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('the frontmatter has to be key: value lines')
  return data as Record<string, unknown>
}

function textField(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} is missing`)
    return ''
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${field} has to be text`)
  const text = String(value).trim()
  if (required && text === '') throw new Error(`${field} is missing`)
  if (text.length > max) throw new Error(`${field} is ${text.length} characters; the most is ${max}`)
  return text
}

function names(value: unknown, field: string): string[] {
  if (value === undefined || value === null || value === '') return []
  const list: unknown = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`${field} has to be a list of names, like [jaspers/research]`)
  }
  return [...new Set(list.map((item: string) => item.trim()))]
}

function turns(value: unknown): number {
  if (value === undefined || value === null || value === '') return MAX_TURNS_DEFAULT
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TURNS_LIMIT) {
    throw new Error(`max-turns has to be a whole number from 1 to ${MAX_TURNS_LIMIT}`)
  }
  return value
}

function color(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !COLOR.test(value)) throw new Error('color has to be #rrggbb in quotes, like "#1E3A5F"')
  return value
}

/** Words that say what someone is rather than which one; a loose name is matched without them. */
const GENERIC = new Set(['analyst', 'analysts', 'researcher', 'research', 'agent', 'expert', 'specialist', 'the', 'a', 'an'])

/**
 * The analysts a model asked for, found the forgiving way, since models name them loosely: the exact
 * id, then the name or its slug ("Risk Analyst", "fact checker"), then the one analyst whose id words
 * are all in the request ("ownership-researcher" is ownership), the most specific when several are.
 * What matches nothing, or only a broken file, comes back as unmatched instead of failing the rest.
 */
export function resolveAnalysts(all: Analyst[], requested: string[]): { ids: string[]; unmatched: string[] } {
  const usable = all.filter((a) => a.error === null)
  const ids: string[] = []
  const unmatched: string[] = []
  for (const raw of requested) {
    const wanted = raw.trim()
    if (!wanted) continue
    const found = matchAnalyst(usable, wanted)
    if (found === null) unmatched.push(wanted)
    else if (!ids.includes(found)) ids.push(found)
  }
  return { ids, unmatched }
}

function matchAnalyst(usable: Analyst[], wanted: string): string | null {
  const exact = usable.find((a) => a.id === wanted)
  if (exact) return exact.id
  const byName = usable.filter((a) => a.name.toLowerCase() === wanted.toLowerCase() || a.id === words(wanted).join('-'))
  if (byName.length === 1) return byName[0]!.id
  const asked = new Set(words(wanted).filter((w) => !GENERIC.has(w)))
  if (asked.size === 0) return null
  const covered = usable.filter((a) => {
    const own = words(a.id).filter((w) => !GENERIC.has(w))
    return own.length > 0 && own.every((w) => asked.has(w))
  })
  if (covered.length === 0) return null
  const most = Math.max(...covered.map((a) => words(a.id).length))
  const best = covered.filter((a) => words(a.id).length === most)
  return best.length === 1 ? best[0]!.id : null
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}
