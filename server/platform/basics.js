import { createHash } from 'node:crypto'

export const sha256 = s => createHash('sha256').update(s).digest('hex')
export const now = () => Date.now()
export const unix = ms => Math.floor(ms / 1000)
