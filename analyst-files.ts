import type { BackendContext } from '@jaspers-ai/sdk'
import { errorText } from './errors'
import { analystIdOf, mergeAnalysts, parseAnalyst, serializeAnalyst, summaryOf, type Analyst, type AnalystInput } from './analysts'

// Analysts on disk, through the plugin's files: the presets in this folder's analysts/, the user's
// in the research data folder's analysts/. The merged list is the live value `analysts`, which the
// room view reads, published again whenever the user's folder changes.

/** Errors already announced, by analyst id, so a notice goes out when a file breaks, not on every save. */
const announced = new Map<string, string>()

export async function loadAnalysts(ctx: BackendContext): Promise<Analyst[]> {
  const [presets, users] = await Promise.all([readFolder(ctx, 'plugin:analysts', 'preset'), readFolder(ctx, 'analysts', 'user')])
  return mergeAnalysts(presets, users)
}

/** Publishes the list for the views; with `announce`, a file that newly fails says so in a notice. */
export async function publishAnalysts(ctx: BackendContext, announce: boolean): Promise<Analyst[]> {
  const analysts = await loadAnalysts(ctx)
  ctx.live.set('analysts', analysts.map(summaryOf))
  for (const analyst of analysts) {
    if (analyst.error === null) {
      announced.delete(analyst.id)
    } else if (announced.get(analyst.id) !== analyst.error) {
      announced.set(analyst.id, analyst.error)
      if (announce) ctx.notify(`analysts/${analyst.id}.md: ${analyst.error}`)
    }
  }
  return analysts
}

/** Writes one analyst, refusing what would not read back as a working one. */
export async function saveAnalyst(ctx: BackendContext, input: AnalystInput): Promise<void> {
  const text = serializeAnalyst(input)
  const checked = parseAnalyst(input.id, text, 'user')
  if (checked.error) throw new Error(`Not saved: ${checked.error}.`)
  await ctx.files.write(`analysts/${input.id}.md`, text)
}

async function readFolder(ctx: BackendContext, folder: string, origin: Analyst['origin']): Promise<Analyst[]> {
  const analysts: Analyst[] = []
  for (const entry of await ctx.files.list(folder)) {
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
    // Editors leave hidden lock and swap files beside the ones being edited; they are not analysts.
    const id = entry.dir || name.startsWith('.') ? null : analystIdOf(entry.path)
    if (id === null) continue
    try {
      analysts.push(parseAnalyst(id, await ctx.files.read(entry.path), origin))
    } catch (err) {
      // Gone between the listing and the read, or unreadable: listed with why, not a broken list.
      analysts.push({ ...parseAnalyst(id, '', origin), error: `could not be read: ${errorText(err, 'unreadable')}` })
    }
  }
  return analysts
}
