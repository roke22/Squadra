export class ApiError extends Error {
  constructor(code, description, extra) {
    super(description)
    this.code = code
    this.extra = extra
  }
}
export const bad = d => new ApiError(400, `Bad Request: ${d}`)

// Periodic work: an error (e.g. the database is busy) is logged, never fatal.
export const guarded = fn => () => {
  try { fn() } catch (err) { process.stderr.write(`squadra-server: ${fn.name || 'timer'}: ${err?.stack ?? err}\n`) }
}
