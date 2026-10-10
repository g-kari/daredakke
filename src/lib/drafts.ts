import { normalizeAccount, type Service } from '../domain/records.ts';

export type PersonDraft = { id?: string; name: string; aliases: string; tags: string; notes: string };
export type AccountDraft = { id?: string; service: Service; label: string; url: string; personId: string };

const list = (value: string) => [...new Set(value.split(/[,、\n]/).map(item => item.trim()).filter(Boolean))];
// Existing aliases/tags may themselves contain commas. Keep edited delimiter text
// significant, matching submitPerson's preservation of the original arrays.
const personValue = (draft: PersonDraft) => [draft.name.trim(), draft.id ? draft.aliases : list(draft.aliases), draft.id ? draft.tags : list(draft.tags), draft.notes.trim()];
function accountValue(draft: AccountDraft) {
  let url = draft.url.trim();
  try { url = normalizeAccount(draft.service, url).url; } catch { /* Invalid input is still an unsaved edit. */ }
  return [draft.service, draft.label.trim(), url, draft.personId];
}
export function personDraftChanged(draft: PersonDraft | null, initial: PersonDraft | null): boolean {
  return !!draft && (!initial || JSON.stringify(personValue(draft)) !== JSON.stringify(personValue(initial)));
}
export function accountDraftChanged(draft: AccountDraft | null, initial: AccountDraft | null): boolean {
  return !!draft && (!initial || JSON.stringify(accountValue(draft)) !== JSON.stringify(accountValue(initial)));
}
