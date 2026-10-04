// Only server-authored SQL may be passed to these helpers. Identifiers come from allowlists.
export function bindSql(sql: string, values: readonly unknown[] = []) {
  return sql.replace(/\$(\d+)/g, (_, index: string) => {
    const value = values[Number(index) - 1];
    if (value === null) return 'NULL';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value !== 'string') throw new Error('Unsupported query parameter.');
    if (value.includes('\0')) throw new Error('Invalid query parameter.');
    return `'${value.replaceAll("'", "''")}'`;
  });
}
export function uuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
export function pageOptions(params: URLSearchParams) {
  const page = Number(params.get('page') ?? '1');
  const limit = Number(params.get('limit') ?? '50');
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid pagination.');
  return { page, limit, offset: (page - 1) * limit, q: (params.get('q') ?? '').trim().slice(0, 200) };
}
