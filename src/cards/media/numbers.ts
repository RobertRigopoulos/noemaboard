/** Positive finite number from untrusted data, else 0. */
export const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
