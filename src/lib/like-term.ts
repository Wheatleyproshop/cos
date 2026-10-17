/** A case-insensitive "contains" pattern for SQL LIKE, with % and _ in the search taken literally. */
export function likeTerm(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}
