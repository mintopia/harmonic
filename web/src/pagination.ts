// Stops on whichever comes first — an empty page or `all.length >= total` — so a `total` that overcounts still terminates.
export async function fetchAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<{ total: number; items: T[] }>,
  pageSize = 100,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { items, total } = await fetchPage(pageSize, offset);
    all.push(...items);
    if (items.length === 0 || all.length >= total) return all;
  }
}
