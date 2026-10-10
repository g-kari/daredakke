import { type Data, parseImport, validateData, duplicateGroups } from './records.ts';

export type ImportCounts = { before: number; after: number; added: number; updated: number; removed: number; unchanged: number };
export type ImportReview = { data: Data; format: 'daredakke' | 'friend-record'; people: ImportCounts; accounts: ImportCounts; unresolved: number; duplicateGroups: number; duplicateAccounts: number; empty: boolean };

/** Compare validated records by exact IDs; names and profile URLs never infer identity. */
function counts<T extends { id: string }>(before: T[], after: T[]): ImportCounts {
  const previous = new Map(before.map(value => [value.id, value]));
  const incoming = new Set(after.map(value => value.id));
  let added = 0, updated = 0, unchanged = 0;
  for (const value of after) {
    const old = previous.get(value.id);
    if (!old) added++;
    else if (JSON.stringify(old) === JSON.stringify(value)) unchanged++;
    else updated++;
  }
  return { before: before.length, after: after.length, added, updated, removed: before.filter(value => !incoming.has(value.id)).length, unchanged };
}

/** Validate a version-1 replacement and summarize its effect without changing either input. */
export function buildImportReview(current: Data, json: string): ImportReview {
  const before = validateData(current), data = parseImport(json);
  const source = JSON.parse(json) as { format: 'daredakke' | 'friend-record' };
  const duplicates = duplicateGroups(data);
  return {
    data, format: source.format, people: counts(before.people, data.people), accounts: counts(before.accounts, data.accounts),
    unresolved: data.accounts.filter(account => account.personId === null).length,
    duplicateGroups: duplicates.length, duplicateAccounts: duplicates.reduce((total, group) => total + group.length, 0),
    empty: !data.people.length && !data.accounts.length,
  };
}
