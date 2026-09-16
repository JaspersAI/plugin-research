// An error's words, whichever realm made it. This plugin's code runs in its own vm, so an Error the
// app creates (an abort's reason, a rejected call) is not `instanceof Error` here, and String() of it
// would lose its message or put "Error: " in front.

export function errorText(value: unknown, fallback = 'stopped'): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message
  }
  return value === undefined || value === null ? fallback : String(value)
}
