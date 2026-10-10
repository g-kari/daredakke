import { type Account, type Data, type Person, type Service } from './records.ts';

export type RecordSearch = { hasTerms: boolean; matches: (values: readonly string[]) => boolean };

/** Literal AND matching across existing fields, with whitespace only as a separator. */
export function createRecordSearch(query: string): RecordSearch {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return {
    hasTerms: terms.length > 0,
    matches(values) {
      const text = values.join(' ').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    },
  };
}

/** Keep UI and WebMCP people results on the same fields and existing record order. */
export function searchPeople(data: Data, search: RecordSearch, service: Service | 'all' = 'all'): Person[] {
  const accountsByPerson = new Map<string, Account[]>();
  for (const account of data.accounts) {
    if (account.personId === null) continue;
    const accounts = accountsByPerson.get(account.personId) || [];
    accounts.push(account);
    accountsByPerson.set(account.personId, accounts);
  }
  return data.people.filter(person => {
    const accounts = accountsByPerson.get(person.id) || [];
    return (service === 'all' || accounts.some(account => account.service === service)) && search.matches([
      person.name, ...person.aliases, ...person.tags, person.notes,
      ...accounts.flatMap(account => [account.label, account.url, account.service]),
    ]);
  });
}
