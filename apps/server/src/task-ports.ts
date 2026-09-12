export const PORT_BLOCK_SIZE = 10;
export const PORT_RANGE_START = 20000;
export const PORT_RANGE_END = 29999;

export class PortRangeExhaustedError extends Error {}

export function allocatePortBase(usedBases: number[]): number {
  const used = new Set(usedBases);
  for (let base = PORT_RANGE_START; base + PORT_BLOCK_SIZE - 1 <= PORT_RANGE_END; base += PORT_BLOCK_SIZE) {
    if (!used.has(base)) return base;
  }
  throw new PortRangeExhaustedError(`no free port block in ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

export function portRangeOf(base: number): { base: number; end: number } {
  return { base, end: base + PORT_BLOCK_SIZE - 1 };
}
