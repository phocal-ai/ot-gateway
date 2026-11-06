/** The closest of `candidates` to a mistyped `word`, as `cf` and git suggest one: at most two edits away. */
export const closestMatch = (word: string, candidates: Iterable<string>): string | undefined => {
  let best: { readonly candidate: string; readonly distance: number } | undefined
  for (const candidate of candidates) {
    const distance = editDistance(word.toLowerCase(), candidate)
    if (distance <= 2 && (best === undefined || distance < best.distance)) best = { candidate, distance }
  }
  return best?.candidate
}

/** Levenshtein distance, with a swap of two neighbours counted as one edit, over a flat table. */
const editDistance = (left: string, right: string) => {
  const width = right.length + 1
  const table = new Uint16Array((left.length + 1) * width)
  const at = (row: number, column: number) => table[row * width + column] ?? 0
  for (let row = 0; row <= left.length; row++) table[row * width] = row
  for (let column = 0; column <= right.length; column++) table[column] = column
  for (let row = 1; row <= left.length; row++) {
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      let distance = Math.min(at(row - 1, column) + 1, at(row, column - 1) + 1, at(row - 1, column - 1) + cost)
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        distance = Math.min(distance, at(row - 2, column - 2) + 1)
      }
      table[row * width + column] = distance
    }
  }
  return at(left.length, right.length)
}
