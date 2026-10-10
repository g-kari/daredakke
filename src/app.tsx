'use client';
import { useEffect, useRef, useState, type FocusEvent, type FormEvent } from 'react';
import { Users, Search, Plus, LockKeyhole, Undo2, Link2, Download, Upload, Pencil, Trash2, FileJson, Copy, Check, ExternalLink, GitMerge, UserRound, LoaderCircle, LayoutGrid, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { type PersonDraft, type AccountDraft, personDraftChanged, accountDraftChanged } from '@/lib/drafts';
import { identityChanged, readNamespace, readSessionFile, verifyLoadedNamespace, sessionChecks } from '@/lib/session';
import { buildImportReview, type ImportReview } from '@/domain/import-review';
import { type Person, type Account, type Service, type Data, type RecordState, colors, demoData, empty, normalizeAccount, validateData, change, undoChange, mergePeople, duplicateGroups, parseImport, exportData } from '@/domain/records';

type DraftKind = 'person' | 'account' | 'import';
type DraftFocus = { kind: DraftKind; target: HTMLElement; dialog: HTMLElement; epoch: number };
type Confirm = { title: string; message: string; action: string; run: () => Promise<void> };
type StagedImport = { review: ImportReview; text: string; source: string; baseline: RecordState; revision: number; namespace: string; epoch: number; readEpoch: number };
const blankPerson = (): PersonDraft => ({ name: '', aliases: '', tags: '', notes: '' });
const split = (value: string) => value.split(/[,、\n]/).map(v => v.trim()).filter(Boolean);
const services: Service[] = ['Discord', 'X', 'VRChat'];
function ServiceMark({ service }: { service: Service }) { return <span className={'service-mark service-' + service}>{service === 'Discord' ? 'D' : service === 'VRChat' ? 'V' : 'X'}</span>; }
function Choice({ value, onChange, items, label, disabled }: { value: string; onChange: (v: string) => void; items: { value: string; label: string }[]; label: string; disabled?: boolean }) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger aria-label={label} className="choice"><SelectValue /></SelectTrigger><SelectContent>{items.map(i => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent></Select>;
}
function useCompactProfile() {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 800px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 800px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}
export default function FriendRecord() {
  const compactProfile = useCompactProfile();
  const [scope, setScope] = useState<'demo' | 'personal'>('demo');
  const [state, setState] = useState<RecordState | null>(null);
  const [revision, setRevision] = useState(0);
  const [namespace, setNamespace] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('people');
  const [query, setQuery] = useState('');
  const [serviceFilter, setServiceFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [personDraft, setPersonDraft] = useState<PersonDraft | null>(null);
  const [accountDraft, setAccountDraft] = useState<AccountDraft | null>(null);
  const [formError, setFormError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirm | null>(null);
  const [discard, setDiscard] = useState<{ run: () => void; epoch: number } | null>(null);
  const [mergeTarget, setMergeTarget] = useState('none');
  const [importText, setImportText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importReview, setImportReview] = useState<StagedImport | null>(null);
  const [importSource, setImportSource] = useState('貼り付けたJSON');
  const [importFilePending, setImportFilePending] = useState(false);
  const [emptyImportConfirmed, setEmptyImportConfirmed] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const personDraftInitial = useRef<PersonDraft | null>(null);
  const accountDraftInitial = useRef<AccountDraft | null>(null);
  const draftFocus = useRef<DraftFocus | null>(null);
  const profileFocus = useRef<{ target: HTMLButtonElement; epoch: number } | null>(null);
  const discardFocus = useRef<DraftFocus | null>(null);
  const startPersonCreation = useRef<() => void>(() => {}); startPersonCreation.current = () => editPerson();
  const stateRef = useRef(state); stateRef.current = state;
  const confirmationRef = useRef(confirmation); confirmationRef.current = confirmation;
  const namespaceRef = useRef<string | null>(null);
  const identityEpoch = useRef(0);
  const importReadEpoch = useRef(0);
  const sessionPending = useRef(false);
  const recordLoad = useRef<AbortController | null>(null);
  const inputFile = useRef<HTMLInputElement>(null);
  const importReviewHeading = useRef<HTMLHeadingElement>(null);
  const importTextInput = useRef<HTMLTextAreaElement>(null);
  const importConfirmButton = useRef<HTMLButtonElement>(null);
  const importConfirmationFocus = useRef<{ target: HTMLButtonElement; epoch: number; readEpoch: number; namespace: string } | null>(null);
  const personDirty = personDraftChanged(personDraft, personDraftInitial.current);
  const accountDirty = accountDraftChanged(accountDraft, accountDraftInitial.current);
  const importDirty = importOpen && !!importText.trim();
  const hasUnsavedChanges = personDirty || accountDirty || importDirty;
  const data = state?.data || empty();
  const person = data.people.find(p => p.id === selected);
  const unresolved = data.accounts.filter(a => a.personId === null);
  const duplicate = duplicateGroups(data);
  const normalizedQuery = query.toLocaleLowerCase();
  const match = (values: string[]) => values.join(' ').toLocaleLowerCase().includes(normalizedQuery);
  const filteredPeople = data.people.filter(p => {
    const accounts = data.accounts.filter(a => a.personId === p.id);
    return (serviceFilter === 'all' || accounts.some(a => a.service === serviceFilter)) && match([p.name, ...p.aliases, ...p.tags, p.notes, ...accounts.flatMap(a => [a.label, a.url, a.service])]);
  });
  const desktopPerson = filteredPeople.find(p => p.id === selected) || filteredPeople[0];
  useEffect(() => { setMergeTarget('none'); }, [desktopPerson?.id, person?.id]);
  const accountMatch = (a: Account) => (serviceFilter === 'all' || a.service === serviceFilter) && match([a.label, a.url, a.service, data.people.find(p => p.id === a.personId)?.name || '']);
  const peopleChoices = [{ value: 'none', label: '未整理のまま' }, ...data.people.map(p => ({ value: p.id, label: p.name }))];
  function clearSessionData(message = '') {
    identityEpoch.current++;
    importReadEpoch.current++;
    importConfirmationFocus.current = null;
    sessionPending.current = false; setCheckingSession(false);
    stateRef.current = null; namespaceRef.current = null;
    setState(null); setNamespace(null); setRevision(0); setSelected(null);
    personDraftInitial.current = null; accountDraftInitial.current = null; draftFocus.current = null; discardFocus.current = null;
    setPersonDraft(null); setAccountDraft(null); setConfirmation(null); setDiscard(null);
    setImportText(''); setImportOpen(false); setImportReview(null); setImportSource('貼り付けたJSON'); setImportFilePending(false); setEmptyImportConfirmed(false); setExportOpen(false); setCopied(false);
    setQuery(''); setServiceFilter('all'); setMergeTarget('none'); setFormError(''); setError(message);
    if (inputFile.current) inputFile.current.value = '';
  }
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedChanges]);
  function rememberDraftFocus(kind: DraftKind, event: FocusEvent<HTMLElement>) {
    const target = event.target;
    if (target instanceof HTMLElement && target !== event.currentTarget && target.closest('[role="dialog"]') === event.currentTarget) {
      draftFocus.current = { kind, target, dialog: event.currentTarget, epoch: identityEpoch.current };
    }
  }
  function clearDraftFocus(kind: DraftKind) {
    if (draftFocus.current?.kind === kind) draftFocus.current = null;
    if (discardFocus.current?.kind === kind) discardFocus.current = null;
  }
  function restoreDiscardFocus(event: Event) {
    const focus = discardFocus.current;
    discardFocus.current = null;
    if (focus && focus.epoch === identityEpoch.current && !sessionPending.current &&
        focus.dialog.isConnected && focus.target.isConnected && focus.dialog.contains(focus.target) &&
        focus.target.closest('[role="dialog"]') === focus.dialog) {
      event.preventDefault(); focus.target.focus();
    }
  }
  function requestDiscard(dirty: boolean, run: () => void) {
    if (busy || sessionPending.current || discard) return;
    if (!dirty) { run(); return; }
    // A pointer on the backdrop can move activeElement to body before dismissal.
    // Keep the last control from the originating draft, never the nested alert.
    discardFocus.current = draftFocus.current;
    setDiscard({ run, epoch: identityEpoch.current });
  }
  function closePersonDraft() {
    requestDiscard(personDirty, () => { clearDraftFocus('person'); setPersonDraft(null); personDraftInitial.current = null; setFormError(''); });
  }
  function closeAccountDraft() {
    requestDiscard(accountDirty, () => { clearDraftFocus('account'); setAccountDraft(null); accountDraftInitial.current = null; setFormError(''); });
  }
  function closeImport() {
    requestDiscard(importDirty, () => { clearDraftFocus('import'); importReadEpoch.current++; setImportOpen(false); setImportText(''); setImportReview(null); setImportSource('貼り付けたJSON'); setImportFilePending(false); setEmptyImportConfirmed(false); setFormError(''); });
  }
  useEffect(() => { if (importReview) importReviewHeading.current?.focus(); }, [importReview]);
  useEffect(() => { if (importReview && importReview.baseline !== state) { setImportReview(null); setEmptyImportConfirmed(false); } }, [state, importReview]);
  function editImportText(value: string) {
    importReadEpoch.current++;
    if (inputFile.current) inputFile.current.value = '';
    setImportText(value); setImportSource('貼り付けたJSON'); setImportReview(null); setImportFilePending(false); setEmptyImportConfirmed(false); setFormError('');
  }
  function editImportPreview() {
    const epoch = identityEpoch.current;
    setImportReview(null); setEmptyImportConfirmed(false); setFormError('');
    requestAnimationFrame(() => { if (epoch === identityEpoch.current && !sessionPending.current) importTextInput.current?.focus(); });
  }
  function restoreImportConfirmationFocus(event: Event) {
    const focus = importConfirmationFocus.current;
    // A same-owner session probe temporarily unmounts both dialogs. Keep the
    // guarded intent and resolve the newly mounted button when the alert closes.
    if (sessionPending.current || confirmationRef.current) return;
    importConfirmationFocus.current = null;
    const target = importConfirmButton.current || focus?.target;
    if (!focus || focus.epoch !== identityEpoch.current || focus.readEpoch !== importReadEpoch.current || focus.namespace !== namespaceRef.current || !target?.isConnected) return;
    event.preventDefault();
    if (!target.disabled) target.focus();
    else importReviewHeading.current?.focus();
  }
  function switchScope(next: 'demo' | 'personal') {
    if (next === scope) return;
    requestDiscard(hasUnsavedChanges, () => { setScope(next); setQuery(''); });
  }
  function discardChanges() {
    const pending = discard;
    setDiscard(null);
    if (pending && pending.epoch === identityEpoch.current && !sessionPending.current) pending.run();
  }
  useEffect(() => {
    const ctrl = new AbortController(); clearSessionData();
    recordLoad.current = ctrl;
    const epoch = identityEpoch.current;
    fetch('/api/records?scope=' + scope, { signal: ctrl.signal, cache: 'no-store' }).then(async r => {
      const result = await r.json() as { error?: string; state: RecordState; revision: number; namespace: string }; if (!r.ok) throw new Error(result.error || '読み込めませんでした。');
      const received = await verifyLoadedNamespace(result, async () => {
        const session = await fetch('/api/session', { signal: ctrl.signal, cache: 'no-store' });
        if (!session.ok) throw new Error('ログインを確認できません。再読み込みしてください。');
        return session.json();
      }, () => !ctrl.signal.aborted && epoch === identityEpoch.current);
      if (received && !ctrl.signal.aborted && epoch === identityEpoch.current) { namespaceRef.current = received; setNamespace(received); setState(result.state); setRevision(result.revision); }
    }).catch(e => { if (!ctrl.signal.aborted && epoch === identityEpoch.current) setError(e.message); });
    return () => { ctrl.abort(); if (recordLoad.current === ctrl) recordLoad.current = null; };
  }, [scope, reloadKey]);
  useEffect(() => {
    const checks = sessionChecks();
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      const operation = checks.begin(), expected = namespaceRef.current;
      if (!expected) { recordLoad.current?.abort(); clearSessionData('読み込み中に表示状態が変わりました。再読み込みしてログインを確認してください。'); }
      const epoch = identityEpoch.current;
      sessionPending.current = true; setCheckingSession(true);
      try {
        const response = await fetch('/api/session', { cache: 'no-store', signal: operation.signal });
        const result = await response.json();
        if (!operation.isCurrent() || epoch !== identityEpoch.current) return;
        const received = readNamespace(result);
        if (!response.ok || (expected && received !== expected)) throw new Error('ログインが変わったか期限切れです。古い入力を保存せず、再読み込みしてください。');
      } catch {
        if (operation.isCurrent() && expected === namespaceRef.current && epoch === identityEpoch.current) clearSessionData('ログインを確認できません。古い入力を保存せず、再読み込みしてください。');
      } finally { if (operation.isCurrent() && epoch === identityEpoch.current) { sessionPending.current = false; setCheckingSession(false); } }
    };
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { checks.cancel(); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, []);
  useEffect(() => {
    type Context = { registerTool: (tool: Record<string, unknown>, opts: { signal: AbortSignal }) => void | Promise<void> };
    const ctx = (document as Document & { modelContext?: Context }).modelContext;
    if (!ctx?.registerTool) return;
    const life = new AbortController();
    const tools = [
      { name: 'search_friend_records', title: '人とアカウントを検索', description: '現在の保存先の人とアカウントを検索し、表示中の検索欄にも反映します。記録は変更しません。', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input: unknown) => {
        if (sessionPending.current) throw new Error('ログイン確認中です。');
        const i = input as { query?: unknown }; if (!i || typeof i.query !== 'string' || i.query.length > 100 || Object.keys(i).some(k => k !== 'query')) throw new Error('queryは100文字までの文字列です。');
        const q = i.query.toLocaleLowerCase(); setQuery(i.query); setTab('people'); setServiceFilter('all');
        const d = stateRef.current?.data || empty(); return { people: d.people.filter(p => [p.name, ...p.aliases, ...p.tags, p.notes, ...d.accounts.filter(a => a.personId === p.id).flatMap(a => [a.label, a.url])].join(' ').toLocaleLowerCase().includes(q)).map(p => ({ id: p.id, name: p.name, accounts: d.accounts.filter(a => a.personId === p.id) })) };
      } },
      { name: 'start_person_creation', title: '人の追加を開く', description: '人を追加する入力画面を開きます。保存はユーザーが画面で行います。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: (input: unknown) => {
        if (sessionPending.current) throw new Error('ログイン確認中です。');
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('入力は空のオブジェクトです。'); startPersonCreation.current(); return { opened: 'person_creation' };
      } },
    ];
    tools.forEach(tool => { try { void Promise.resolve(ctx.registerTool(tool, { signal: life.signal })).catch(() => {}); } catch {} });
    return () => life.abort();
  }, []);
  async function save(next: RecordState, message: string): Promise<boolean> {
    if (busy || sessionPending.current || !state || !namespace || namespace !== namespaceRef.current) return false;
    const expected = namespace, epoch = identityEpoch.current;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Friend-Record': '1' }, body: JSON.stringify({ scope, revision, state: next, expectedNamespace: expected }) });
      const result = await response.json().catch(() => null) as { error?: string; revision?: number; code?: string } | null;
      if (epoch !== identityEpoch.current || expected !== namespaceRef.current) return false;
      if (identityChanged(response.status, result) || !result) { const reason = result?.error || 'ログインを確認できません。再読み込みしてください。'; clearSessionData(reason); toast.error(reason); return false; }
      if (!response.ok || typeof result.revision !== 'number') throw new Error(result.error || '保存できませんでした。');
      setState(next); setRevision(result.revision); toast.success(message); return true;
    } catch (e) { if (epoch !== identityEpoch.current || expected !== namespaceRef.current) return false; const message = e instanceof Error ? e.message : '保存できませんでした。'; setError(message); setFormError(message); toast.error(message); return false; }
    finally { setBusy(false); }
  }
  async function update(next: Data, label: string) { if (!state) return false; try { return await save(change(state, next, label), label); } catch (e) { const msg = (e as Error).message; setFormError(msg); toast.error(msg); return false; } }
  function editPerson(p?: Person) {
    const draft = p ? { id: p.id, name: p.name, aliases: p.aliases.join(', '), tags: p.tags.join(', '), notes: p.notes } : blankPerson();
    requestDiscard(personDraftChanged(personDraft, personDraftInitial.current), () => { clearDraftFocus('person'); setFormError(''); personDraftInitial.current = draft; setPersonDraft(draft); });
  }
  function editAccount(a?: Account, owner?: string) {
    const draft: AccountDraft = a ? { ...a, personId: a.personId || 'none' } : { service: 'Discord', label: '', url: '', personId: owner || 'none' };
    requestDiscard(accountDraftChanged(accountDraft, accountDraftInitial.current), () => { clearDraftFocus('account'); setFormError(''); accountDraftInitial.current = draft; setAccountDraft(draft); });
  }
  async function submitPerson(e: FormEvent) {
    e.preventDefault(); if (!personDraft) return;
    const draft = personDraft, old = data.people.find(p => p.id === draft.id);
    const next: Person = { id: draft.id || crypto.randomUUID(), name: draft.name.trim(), aliases: old && draft.aliases === old.aliases.join(', ') ? old.aliases : split(draft.aliases), tags: old && draft.tags === old.tags.join(', ') ? old.tags : split(draft.tags), notes: draft.notes, color: old?.color || colors[data.people.length % colors.length] };
    if (await update({ ...data, people: old ? data.people.map(p => p.id === old.id ? next : p) : [...data.people, next] }, old ? '人の記録を更新しました' : '人を追加しました')) { clearDraftFocus('person'); personDraftInitial.current = null; setPersonDraft(null); setSelected(next.id); }
  }
  async function submitAccount(e: FormEvent) {
    e.preventDefault(); if (!accountDraft) return;
    try {
      const normalized = normalizeAccount(accountDraft.service, accountDraft.url);
      const next: Account = { id: accountDraft.id || crypto.randomUUID(), service: accountDraft.service, label: accountDraft.label.trim() || normalized.key.split(':')[1], personId: accountDraft.personId === 'none' ? null : accountDraft.personId, ...normalized };
      if (await update({ ...data, accounts: accountDraft.id ? data.accounts.map(a => a.id === accountDraft.id ? next : a) : [...data.accounts, next] }, accountDraft.id ? 'アカウントを更新しました' : 'アカウントを追加しました')) { clearDraftFocus('account'); accountDraftInitial.current = null; setAccountDraft(null); }
    } catch (e) { setFormError((e as Error).message); }
  }
  async function link(a: Account, target: string) { await update({ ...data, accounts: data.accounts.map(c => c.id === a.id ? { ...c, personId: target === 'none' ? null : target } : c) }, target === 'none' ? '紐づけを解除しました' : 'アカウントを紐づけました'); }
  function confirmMerge(target: string, source: string) {
    const a = data.people.find(p => p.id === target), b = data.people.find(p => p.id === source); if (!a || !b || a.id === b.id) return;
    setConfirmation({ title: 'この2人を統合しますか？', message: `「${b.name}」を「${a.name}」にまとめます。別名・タグ・メモ・アカウントを引き継ぎます。名前だけでは同一人物と判定していません。直近10操作は元に戻せます。`, action: '統合する', run: async () => { try { if (await update(mergePeople(data, target, source), '2人の記録を統合しました')) { setSelected(target); setMergeTarget('none'); } } catch (e) { toast.error((e as Error).message); } } });
  }
  function removePerson(p: Person) { setConfirmation({ title: '人の記録を削除しますか？', message: `「${p.name}」の記録を削除します。アカウントは未整理へ移します。元に戻すこともできます。`, action: '人の記録を削除', run: async () => { if (await update({ people: data.people.filter(c => c.id !== p.id), accounts: data.accounts.map(a => a.personId === p.id ? { ...a, personId: null } : a) }, '人の記録を削除しました')) setSelected(null); } }); }
  function removeAccount(a: Account) { setConfirmation({ title: 'アカウントの登録を削除しますか？', message: `${a.service}「${a.label}」の登録だけを削除します。外部サービスのアカウントには何もしません。元に戻せます。`, action: '登録を削除', run: async () => { await update({ ...data, accounts: data.accounts.filter(c => c.id !== a.id) }, 'アカウントの登録を削除しました'); } }); }
  async function readFile(file?: File) {
    if (!file || busy || sessionPending.current || !namespace || namespace !== namespaceRef.current) return;
    const expected = namespace, epoch = identityEpoch.current, readEpoch = ++importReadEpoch.current;
    const isCurrent = () => expected === namespaceRef.current && epoch === identityEpoch.current && readEpoch === importReadEpoch.current;
    setImportReview(null); setEmptyImportConfirmed(false);
    if (file.size > 900000) { setImportFilePending(false); toast.error('JSONファイルは900KBまでです。'); if (inputFile.current) inputFile.current.value = ''; return; }
    setImportFilePending(true);
    try {
      const text = await readSessionFile(file, isCurrent);
      if (text === null || !isCurrent()) return;
      parseImport(text); setImportText(text); setImportSource(file.name || '選択したファイル'); setFormError(''); setImportOpen(true);
    } catch (e) { if (isCurrent()) toast.error((e as Error).message); }
    finally { if (isCurrent()) { setImportFilePending(false); if (inputFile.current) inputFile.current.value = ''; } }
  }
  function stageImport() {
    if (busy || importFilePending || sessionPending.current || !state || !namespace || namespace !== namespaceRef.current) return;
    try {
      const review = buildImportReview(data, importText);
      setImportReview({ review, text: importText, source: importSource, baseline: state, revision, namespace, epoch: identityEpoch.current, readEpoch: importReadEpoch.current }); setEmptyImportConfirmed(false); setFormError('');
    } catch (e) { setImportReview(null); setEmptyImportConfirmed(false); setFormError((e as Error).message); }
  }
  function confirmImport() {
    const staged = importReview;
    if (!staged || busy || importFilePending || sessionPending.current || (staged.review.empty && !emptyImportConfirmed)) return;
    const isCurrent = () => staged.baseline === stateRef.current && staged.revision === revision && staged.namespace === namespaceRef.current && staged.epoch === identityEpoch.current && staged.readEpoch === importReadEpoch.current && !sessionPending.current;
    if (!isCurrent()) { setImportReview(null); setEmptyImportConfirmed(false); setFormError('表示中の記録か入力が変わりました。内容をもう一度確認してください。'); return; }
    const r = staged.review;
    if (importConfirmButton.current) importConfirmationFocus.current = { target: importConfirmButton.current, epoch: staged.epoch, readEpoch: staged.readEpoch, namespace: staged.namespace };
    setConfirmation({ title: `${scope === 'demo' ? 'デモ' : 'マイレコード'}を読み込みデータに置き換えますか？`, message: `${r.people.before}人・${r.accounts.before}アカウントから、${r.people.after}人・${r.accounts.after}アカウントへ置き換えます。今の記録から${r.people.removed}人・${r.accounts.removed}アカウントが取り除かれます。${r.empty ? 'この保存先の記録は空になります。' : ''}もう一方の保存先には影響しません。直前の記録へ戻せます。`, action: '置き換えて読み込む', run: async () => {
      if (!isCurrent()) return;
      if (await update(r.data, 'JSONを読み込みました')) { clearDraftFocus('import'); importReadEpoch.current++; setImportOpen(false); setImportText(''); setImportReview(null); setImportSource('貼り付けたJSON'); setEmptyImportConfirmed(false); setSelected(null); }
    } });
  }
  function downloadExport() {
    if (sessionPending.current || !namespace || namespace !== namespaceRef.current) return;
    const blob = new Blob([exportData(data)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `daredakke-${scope}-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast.success('JSONを書き出しました');
  }
  async function copyExport() {
    if (sessionPending.current || !namespace || namespace !== namespaceRef.current) return;
    const expected = namespace, epoch = identityEpoch.current;
    const isCurrent = () => expected === namespaceRef.current && epoch === identityEpoch.current;
    try { await navigator.clipboard.writeText(exportData(data)); if (isCurrent()) { setCopied(true); toast.success('JSONをコピーしました'); } }
    catch { if (isCurrent()) toast.error('コピーできませんでした。テキストを選択してコピーしてください。'); }
  }
  function accountRow(a: Account, controls = true, compact = false) {
    const tools = <div className="account-controls"><Choice label={a.label + 'の紐づけ先'} value={a.personId || 'none'} onChange={v => void link(a, v)} items={peopleChoices} disabled={busy} />{!compact && <Button variant="ghost" size="icon" aria-label={a.label + 'を編集'} onClick={() => editAccount(a)} disabled={busy}><Pencil aria-hidden="true" /></Button>}<Button variant="ghost" size="icon" aria-label={a.label + 'の登録を削除'} onClick={() => removeAccount(a)} disabled={busy}><Trash2 aria-hidden="true" /></Button></div>;
    return <article key={a.id} className={'account-row' + (compact ? ' profile-account' : '')}><div className="account-line"><ServiceMark service={a.service} /><div className="account-title"><strong>{a.label}</strong><span>{a.service}</span></div>{scope === 'personal' && <a className="icon-link" href={a.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={a.label + 'のプロフィールを開く'}><ExternalLink size={17} aria-hidden="true" /></a>}{compact && <Button variant="ghost" size="icon" aria-label={a.label + 'を編集'} onClick={() => editAccount(a)} disabled={busy}><Pencil aria-hidden="true" /></Button>}</div>{compact ? <details className="account-details"><summary aria-label={a.label + 'のURLと紐づけ'}>URL・紐づけ<ChevronDown size={13} aria-hidden="true" /></summary><div className="account-url">{a.url}</div>{controls && tools}</details> : <><div className="account-url">{a.url}</div>{controls && tools}</>}</article>;

  }
  function profileContent(p: Person) {
    return <div className="profile-content" style={{ '--person-color': p.color } as React.CSSProperties}>
      <div className="profile-cover" aria-hidden="true" />
      <div className="profile-body">
        <div className="profile-identity"><span className="initial profile-avatar" aria-hidden="true">{Array.from(p.name)[0]}</span><Button variant="outline" onClick={() => editPerson(p)} disabled={busy}><Pencil aria-hidden="true" />編集</Button></div>
        <div className="profile-name"><h2>{p.name}</h2>{p.aliases[0] && <p>{p.aliases[0]}</p>}</div>
        {p.tags.length > 0 && <div className="tags profile-tags" aria-label="タグ">{p.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
        <div className="profile-columns"><div className="profile-memory">
          <section className="profile-section"><h3>メモ</h3><p className="detail-notes">{p.notes || 'メモはまだありません'}</p></section>
          <section className="profile-section"><h3>別名</h3><p className="profile-aliases">{p.aliases.join(' / ') || '別名はまだありません'}</p></section>
          {!p.tags.length && <section className="profile-section"><h3>タグ</h3><p className="muted">タグはまだありません</p></section>}
        </div><section className="profile-section profile-accounts"><div className="section-head"><h3>アカウント</h3><span>{data.accounts.filter(a => a.personId === p.id).length}件</span></div>
          {data.accounts.filter(a => a.personId === p.id).map(a => accountRow(a, true, true))}
          {!data.accounts.some(a => a.personId === p.id) && <p className="muted">まだ紐づいていません</p>}
          <Button variant="ghost" className="context-add" onClick={() => editAccount(undefined, p.id)} disabled={busy}><Plus aria-hidden="true" />アカウントを追加</Button>
        </section></div>
        <details className="record-maintenance"><summary>統合・削除<ChevronDown size={16} aria-hidden="true" /></summary><div className="maintenance-body"><section className="merge-section"><h3>別の人の記録と統合</h3><p>同じ人だと自分で確認できた記録を選びます。</p><Choice label="統合する別の人" value={mergeTarget} onChange={setMergeTarget} items={[{ value: 'none', label: '統合する人を選ぶ' }, ...data.people.filter(other => other.id !== p.id).map(other => ({ value: other.id, label: other.name }))]} disabled={busy} /><Button variant="outline" disabled={busy || mergeTarget === 'none'} onClick={() => confirmMerge(p.id, mergeTarget)}><GitMerge aria-hidden="true" />この人に統合する</Button></section><Button variant="ghost" className="danger-text" disabled={busy} onClick={() => removePerson(p)}><Trash2 aria-hidden="true" />人の記録を削除</Button></div></details>
      </div>
    </div>;
  }
  if (checkingSession) return <div className="app-shell"><main className="main"><p role="status">ログインを確認しています…</p></main></div>;
  return <div className="app-shell">
    <Toaster position="bottom-center" richColors />
    <a className="skip-link" href="#main">メインへ移動</a>
    <aside className="service-rail" aria-label="サービスで絞り込み"><span className="rail-brand" aria-hidden="true"><Users size={23} /></span><div className="rail-filters"><button className={'service-filter' + (serviceFilter === 'all' ? ' active' : '')} aria-pressed={serviceFilter === 'all'} onClick={() => setServiceFilter('all')}><span className="rail-symbol"><LayoutGrid size={23} aria-hidden="true" /></span><span>すべて</span></button>{services.map(service => <button key={service} className={'service-filter' + (serviceFilter === service ? ' active' : '')} aria-pressed={serviceFilter === service} onClick={() => setServiceFilter(service)}><span className="rail-symbol" aria-hidden="true"><ServiceMark service={service} /></span><span>{service}</span></button>)}</div></aside>
    <header className="app-header"><div className="brand"><h1>だれだっけ</h1></div><div className="header-workspace"><div className="scope-switch" role="group" aria-label="保存先"><Button variant={scope === 'demo' ? 'secondary' : 'ghost'} aria-pressed={scope === 'demo'} onClick={() => switchScope('demo')} disabled={busy || !state && !error}>デモ</Button><Button variant={scope === 'personal' ? 'secondary' : 'ghost'} aria-pressed={scope === 'personal'} onClick={() => switchScope('personal')} disabled={busy || !state && !error}>マイレコード</Button></div><span className="scope-label">{scope === 'demo' ? '架空データ' : '自分の記録'}</span></div><span className="save-status" role="status">{busy ? <><LoaderCircle className="spin" size={14} aria-hidden="true" />保存中</> : state ? <><Check size={14} aria-hidden="true" />保存済み</> : '読み込み中…'}</span><div className="private-label"><LockKeyhole size={14} aria-hidden="true" />本人専用</div></header>
    <main id="main" className="main" tabIndex={-1}>
      {error && <div className="error-banner" role="alert"><p>{error}</p><Button variant="outline" onClick={() => setReloadKey(k => k + 1)} disabled={busy}>再読み込み</Button></div>}
      <Tabs value={tab} onValueChange={setTab} className="workspace-tabs">
        <div className="navigation-bar"><TabsList className="tab-list" variant="line"><TabsTrigger value="people">人<span className="count">{data.people.length}</span></TabsTrigger><TabsTrigger value="unresolved">未整理<span className="count">{unresolved.length}</span></TabsTrigger><TabsTrigger value="duplicates">重複候補<span className="count">{duplicate.length}</span></TabsTrigger><TabsTrigger value="settings">保存・バックアップ</TabsTrigger></TabsList></div>
        <div className={'workspace-content' + (tab === 'people' ? ' people-workspace' : '')}>
          {tab !== 'settings' && <aside className="collection-sidebar" aria-label="人の記録"><div className="collection-toolbar"><div className="search-field"><Search size={17} aria-hidden="true" /><Input disabled={busy} value={query} onChange={e => setQuery(e.target.value)} maxLength={100} placeholder="名前、別名、タグを検索" aria-label="記録を検索" /></div><div className="collection-actions"><Button onClick={() => editPerson()} disabled={!state || busy}><Plus aria-hidden="true" />人を追加</Button><Button variant="ghost" onClick={() => editAccount()} disabled={!state || busy}><Plus aria-hidden="true" />アカウントを追加</Button></div></div>
          <div className="collection-heading"><h2>人の記録</h2><span>{filteredPeople.length}人</span></div>
          {!state && !error && <div className="people-list" aria-label="読み込み中">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="loading-row" />)}</div>}
          <div className="people-list">{filteredPeople.map(p => <button key={p.id} className={'person-row' + (tab === 'people' && (compactProfile ? person?.id : desktopPerson?.id) === p.id ? ' selected' : '')} style={{ '--person-color': p.color } as React.CSSProperties} onClick={event => { profileFocus.current = { target: event.currentTarget, epoch: identityEpoch.current }; setSelected(p.id); setMergeTarget('none'); setTab('people'); }} aria-pressed={tab === 'people' && (compactProfile ? person?.id : desktopPerson?.id) === p.id} aria-label={p.name + 'の記録を開く'}><span className="initial" aria-hidden="true">{Array.from(p.name)[0]}</span><span className="person-row-text"><strong>{p.name}</strong><span className="aliases">{p.aliases.join(' / ') || '別名なし'}</span>{p.tags.length > 0 && <span className="row-tags">{p.tags.slice(0, 2).join(' · ')}{p.tags.length > 2 ? ` ほか${p.tags.length - 2}個` : ''}</span>}</span></button>)}</div>
          {state && !filteredPeople.length && <div className="sidebar-empty"><p>{query || serviceFilter !== 'all' ? '一致する人がいません' : '人の記録はまだありません'}</p><span>{query || serviceFilter !== 'all' ? '検索やサービスの条件を変えてみてください。' : '「人を追加」から名前を登録できます。'}</span></div>}
          </aside>}
          <div className="workspace-detail">
            <TabsContent value="people">{!compactProfile && desktopPerson && <article className="desktop-profile" aria-label={desktopPerson.name + 'のプロフィール'}>{profileContent(desktopPerson)}</article>}{!compactProfile && !desktopPerson && state && <div className="empty-state"><UserRound size={30} aria-hidden="true" /><h2>{query || serviceFilter !== 'all' ? '条件に合う人がいません' : '覚えておきたい人を追加'}</h2><p>{query || serviceFilter !== 'all' ? '左側の検索やサービスの条件を変えると、記録を探せます。' : '名前とアカウントをひとつにまとめておけます。'}</p></div>}</TabsContent>
        <TabsContent value="unresolved"><div className="section-head"><h2>だれのアカウント？</h2><span>紐づけ先を選んで整理</span></div><div className="accounts-grid">{unresolved.filter(accountMatch).map(a => accountRow(a))}</div>{state && !unresolved.filter(accountMatch).length && <div className="empty-state"><Link2 size={34} /><h3>{query || serviceFilter !== 'all' ? '一致する未整理アカウントがありません' : '未整理アカウントはありません'}</h3><p>名前のわからないアカウントは、紐づけ先を「未整理のまま」で追加できます。</p><Button variant="outline" onClick={() => editAccount()}><Plus />アカウントを追加</Button></div>}</TabsContent>
        <TabsContent value="duplicates"><div className="section-head"><h2>同じアカウントの重複候補</h2></div><p className="section-help">同じサービスのプロフィールURLが一致した登録だけを表示します。名前や顔からは判定せず、人の統合は自分で確かめて行います。</p><div className="duplicate-list">{duplicate.filter(group => group.some(accountMatch)).map(group => {
          const owners = [...new Set(group.map(a => a.personId).filter(Boolean))] as string[];
          return <article className="duplicate-card" key={group[0].key}><div className="duplicate-heading"><ServiceMark service={group[0].service} /><div><strong>{group[0].service}のURLが一致</strong><p className="account-url">{group[0].url}</p></div><span className="candidate-label">{group.length}件</span></div><div className="duplicate-owners">{group.map(a => <div key={a.id}><UserRound size={17} /><strong>{data.people.find(p => p.id === a.personId)?.name || '未整理'}</strong><span>{a.label}</span><Button variant="ghost" onClick={() => { if (a.personId) { setSelected(a.personId); setTab('people'); setQuery(''); setServiceFilter('all'); } else setTab('unresolved'); }}>記録を確認</Button></div>)}</div><div className="duplicate-actions">{owners.length === 2 && <Button variant="outline" disabled={busy} onClick={() => confirmMerge(owners[0], owners[1])}><GitMerge />この2人を統合</Button>}{owners.length <= 1 && group.every(a => a.personId === group[0].personId) && <Button variant="outline" disabled={busy} onClick={() => setConfirmation({ title: '重複登録を1件にまとめますか？', message: '最初の登録を残し、同じURLの追加登録を取り除きます。人の記録は変わりません。元に戻せます。', action: '1件にまとめる', run: async () => { const remove = new Set(group.slice(1).map(a => a.id)); await update({ ...data, accounts: data.accounts.filter(a => !remove.has(a.id)) }, '重複登録をまとめました'); } })}><Copy />重複登録をまとめる</Button>}<span>直近10操作は元に戻せます</span></div></article>;
        })}</div>{state && !duplicate.filter(group => group.some(accountMatch)).length && <div className="empty-state"><Check size={34} /><h3>重複候補はありません</h3><p>同じURLの登録が見つかると、ここで確認できます。</p></div>}</TabsContent>
        <TabsContent value="settings"><div className="settings-layout"><section className="settings-panel"><div className="section-head"><h2>サービス連携</h2><span className="prototype-label">準備中</span></div><p>この試作ではURL・IDを手入力で管理します。外部アカウントへ接続せず、取得・投稿・自動紐づけは行いません。</p><div className="connection-list">{services.map(s => <div key={s}><ServiceMark service={s} /><strong>{s}</strong><span className="connection-state">未接続</span></div>)}</div><p className="small-note">名前の似ている人を自動で結びつける機能はありません。今は同じサービスのURLが一致する登録を重複候補として出します。</p></section><section className="settings-panel"><div className="section-head"><h2>保存・バックアップ</h2></div><p>記録は本人専用サイトに保存されます。所有者としてCloudflare Accessでログインして使います。デモとマイレコードの保存先は別々です。</p><p>直近10操作を元に戻せます。長期の保管用には、ときどきJSONを書き出してください。書き出したファイルには名前やメモが含まれます。</p><p className="small-note">JSONの書き出し・読み込みと復元は、画面下の保存ツールから使えます。</p>{scope === 'demo' && <div className="demo-settings"><h3>デモデータ</h3><div className="settings-actions"><Button variant="outline" disabled={!state || busy} onClick={() => setConfirmation({ title: 'デモを最初の状態に戻しますか？', message: 'デモ保存先に架空のサンプルを入れ直します。マイレコードは変わりません。この操作も元に戻せます。', action: 'サンプルを入れ直す', run: async () => { await update(demoData(), 'デモを最初の状態に戻しました'); } })}>最初のデモに戻す</Button><Button variant="ghost" disabled={!state || busy} onClick={() => setConfirmation({ title: 'デモの記録を空にしますか？', message: 'デモの人とアカウントをすべて取り除きます。マイレコードは変わりません。元に戻せます。', action: 'デモを空にする', run: async () => { await update(empty(), 'デモを空にしました'); } })}><Trash2 />デモを空にする</Button></div></div>}</section></div></TabsContent>
          </div>
        </div>
      </Tabs>
      <footer className="workspace-footer"><div className="backup-tools"><Button variant="ghost" onClick={() => { setCopied(false); setExportOpen(true); }} disabled={!state || busy}><Download aria-hidden="true" />JSONを書き出す</Button><Button variant="ghost" onClick={() => { setFormError(''); setImportOpen(true); }} disabled={!state || busy}><Upload aria-hidden="true" />JSONを読み込む</Button><Button variant="ghost" onClick={() => { if (state) void save(undoChange(state), '直前の操作を元に戻しました'); }} disabled={busy || !state?.undo.length} title={state?.undo[0]?.label}><Undo2 aria-hidden="true" />元に戻す</Button></div><span>アカウントは手入力 / サービス未接続</span></footer>
      <input className="sr-only" ref={inputFile} type="file" accept="application/json,.json" onChange={e => void readFile(e.target.files?.[0])} aria-label="JSONファイルを選択" />
    </main>
    {compactProfile && <Sheet open={!!person} onOpenChange={open => { if (!open) setSelected(null); }}><SheetContent className="person-sheet" onCloseAutoFocus={event => { const focus = profileFocus.current; if (focus && focus.epoch === identityEpoch.current && !sessionPending.current && focus.target.isConnected) { event.preventDefault(); focus.target.focus(); } }}><SheetHeader><SheetTitle>{person?.name || '人の記録'}</SheetTitle><SheetDescription>別名・メモ・アカウントをこの人にまとめる</SheetDescription></SheetHeader>{person && <div className="sheet-body">{profileContent(person)}</div>}</SheetContent></Sheet>}
    <Dialog open={!!personDraft} onOpenChange={open => { if (!open) closePersonDraft(); }}><DialogContent className="record-dialog" onFocusCapture={event => rememberDraftFocus('person', event)}><DialogHeader><DialogTitle>{personDraft?.id ? '人の記録を編集' : '人を追加'}</DialogTitle><DialogDescription>{scope === 'demo' ? 'デモ保存先への登録です。' : 'マイレコードへの登録です。'} 呼びやすい名前でまとめておけます。</DialogDescription></DialogHeader>{personDraft && <form onSubmit={e => void submitPerson(e)} className="record-form"><label>名前 <span className="required">必須</span><Input disabled={busy} autoFocus required maxLength={100} value={personDraft.name} onChange={e => setPersonDraft({ ...personDraft, name: e.target.value })} placeholder="いつも呼んでいる名前" /></label><label>別名<Input disabled={busy} maxLength={1600} value={personDraft.aliases} onChange={e => setPersonDraft({ ...personDraft, aliases: e.target.value })} placeholder="カンマ区切り。例: Ao, あおちゃん" /></label><label>タグ<Input disabled={busy} maxLength={1600} value={personDraft.tags} onChange={e => setPersonDraft({ ...personDraft, tags: e.target.value })} placeholder="カンマ区切り。例: VRChat, 制作" /></label><label>メモ<Textarea disabled={busy} maxLength={6000} rows={5} value={personDraft.notes} onChange={e => setPersonDraft({ ...personDraft, notes: e.target.value })} placeholder="どこで知り合ったか、覚えておきたいこと" /></label><p className="small-note">別名・タグはそれぞれ20個まで。パスワードや秘密情報は入れないでください。</p>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={closePersonDraft} disabled={busy}>キャンセル</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存する'}</Button></div></form>}</DialogContent></Dialog>
    <Dialog open={!!accountDraft} onOpenChange={open => { if (!open) closeAccountDraft(); }}><DialogContent className="record-dialog" onFocusCapture={event => rememberDraftFocus('account', event)}><DialogHeader><DialogTitle>{accountDraft?.id ? 'アカウントを編集' : 'アカウントを追加'}</DialogTitle><DialogDescription>プロフィールURLまたはサービスのIDを登録します。外部サービスには接続しません。</DialogDescription></DialogHeader>{accountDraft && <form onSubmit={e => void submitAccount(e)} className="record-form"><div className="form-label">サービス<Choice disabled={busy} label="登録するサービス" value={accountDraft.service} onChange={v => setAccountDraft({ ...accountDraft, service: v as Service, url: '' })} items={services.map(s => ({ value: s, label: s }))} /></div><label>表示名<Input disabled={busy} maxLength={100} value={accountDraft.label} onChange={e => setAccountDraft({ ...accountDraft, label: e.target.value })} placeholder="サービスでの表示名（任意）" /></label><label>プロフィールURL / ID <span className="required">必須</span><Input disabled={busy} required maxLength={500} value={accountDraft.url} onChange={e => setAccountDraft({ ...accountDraft, url: e.target.value })} placeholder={accountDraft.service === 'Discord' ? '17〜20桁のユーザーID' : accountDraft.service === 'X' ? '@username または https://x.com/username' : 'https://vrchat.com/home/user/usr_…'} /></label><div className="form-label">だれのアカウント？<Choice disabled={busy} label="アカウントの紐づけ先" value={accountDraft.personId} onChange={v => setAccountDraft({ ...accountDraft, personId: v })} items={peopleChoices} /></div><p className="small-note">Discordの表示名だけでは照合しません。数字のユーザーIDが必要です。URLの追跡パラメーターは保存時に取り除きます。</p>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={closeAccountDraft} disabled={busy}>キャンセル</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存する'}</Button></div></form>}</DialogContent></Dialog>
    <Dialog open={importOpen} onOpenChange={open => { if (!open) closeImport(); }}><DialogContent className="record-dialog import-dialog" onFocusCapture={event => rememberDraftFocus('import', event)}>
      <DialogHeader><DialogTitle>JSONを読み込む</DialogTitle><DialogDescription>version 1 のだれだっけJSONを選ぶか、貼り付けてください。{scope === 'demo' ? 'デモ' : 'マイレコード'}だけが対象です。</DialogDescription></DialogHeader>
      <Button variant="outline" disabled={busy} onClick={() => inputFile.current?.click()}><FileJson />ファイルを選ぶ</Button>
      <label className="form-label">JSON<Textarea ref={importTextInput} disabled={busy} rows={importReview ? 3 : 8} maxLength={900000} value={importText} onChange={e => editImportText(e.target.value)} spellCheck={false} /></label>
      <p className="small-note">今の記録に追加するのではなく、保存先全体を置き換えます。直前の状態を履歴に残します。900KBまで。</p>
      {importFilePending && <p role="status" className="small-note">ファイルを読み込んでいます…</p>}
      {formError && <p className="form-error" role="alert">{formError}</p>}
      {!importReview ? <Button onClick={stageImport} disabled={busy || importFilePending || !importText.trim()}>内容を確認して読み込む</Button> : <section className="import-review" aria-label="読み込み内容の確認">
        <h3 ref={importReviewHeading} tabIndex={-1}>読み込み内容の確認</h3>
        <p className="import-provenance">入力元: {importReview.source}<br />形式: {importReview.review.format} / version 1<br />置き換える保存先: {scope === 'demo' ? 'デモ' : 'マイレコード'}</p>
        <p className="small-note">入力元は選んだファイル名か貼り付け操作です。JSONの形式は確認しましたが、作成者や内容の正しさを保証するものではありません。</p>
        <div className="import-counts">{([['人', importReview.review.people], ['アカウント', importReview.review.accounts]] as const).map(([label, count]) => <section key={label} aria-label={label + 'の変更'}><h4>{label}</h4><dl>{([['現在', count.before], ['読み込み後', count.after], ['追加', count.added], ['更新', count.updated], ['取り除く', count.removed], ['変更なし', count.unchanged]] as const).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}件</dd></div>)}</dl></section>)}</div>
        <p className="small-note">同じIDの記録だけを比較します。名前やURLから同じ人を推測せず、異なるIDは追加・取り除くとして数えます。別名・タグの並び替えも更新に含みます。</p>
        <div className="import-notices"><p>読み込み後の未整理アカウント: {importReview.review.unresolved}件</p><p>読み込み後の重複候補: {importReview.review.duplicateGroups}組（{importReview.review.duplicateAccounts}アカウント）</p><p className="small-note">未整理や重複候補は自動で紐づけ・統合しません。</p></div>
        {importReview.review.empty && <div className="import-empty-warning"><p role="alert">読み込み後は0人・0アカウントです。この保存先の今の記録がすべて取り除かれます。</p><label><input type="checkbox" disabled={busy} checked={emptyImportConfirmed} onChange={e => setEmptyImportConfirmed(e.target.checked)} />この保存先の記録を空にすることを確認しました</label></div>}
        <p className="small-note">まだ保存していません。次の確認で置き換えを実行します。もう一方の保存先には影響しません。戻せるのは直近10操作で、長期の保管には先にJSONを書き出してください。</p>
        <div className="form-actions import-actions"><Button variant="outline" disabled={busy} onClick={editImportPreview}>JSONの編集に戻る</Button><Button ref={importConfirmButton} onClick={confirmImport} disabled={busy || importFilePending || (importReview.review.empty && !emptyImportConfirmed)}>置き換えを確認する</Button></div>
      </section>}
    </DialogContent></Dialog>
    <Dialog open={exportOpen} onOpenChange={setExportOpen}><DialogContent className="record-dialog"><DialogHeader><DialogTitle>JSONを書き出す</DialogTitle><DialogDescription>{scope === 'demo' ? 'デモ' : 'マイレコード'}の{data.people.length}人・{data.accounts.length}アカウントを保存します。</DialogDescription></DialogHeader><Textarea disabled={busy} readOnly rows={8} value={exportData(data)} aria-label="書き出しJSON" spellCheck={false} /><p className="small-note">名前・メモ・URLが含まれます。ファイルは自分で安全に保管してください。操作履歴は書き出しません。</p><div className="settings-actions"><Button onClick={downloadExport}><Download />ファイルを保存</Button><Button variant="outline" onClick={() => void copyExport()}>{copied ? <Check /> : <Copy />}{copied ? 'コピー済み' : 'コピー'}</Button></div></DialogContent></Dialog>
    <AlertDialog open={!!discard} onOpenChange={open => { if (!open) setDiscard(null); }}><AlertDialogContent onCloseAutoFocus={restoreDiscardFocus}><AlertDialogTitle>保存していない入力を破棄しますか？</AlertDialogTitle><AlertDialogDescription>入力した変更はまだ保存されていません。編集を続けると、入力はそのまま残ります。</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>編集を続ける</AlertDialogCancel><AlertDialogAction onClick={discardChanges}>入力を破棄する</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><AlertDialogContent onCloseAutoFocus={restoreImportConfirmationFocus}><AlertDialogTitle>{confirmation?.title}</AlertDialogTitle><AlertDialogDescription>{confirmation?.message}</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>キャンセル</AlertDialogCancel><AlertDialogAction onClick={() => { const c = confirmation; setConfirmation(null); if (c) void c.run(); }} disabled={busy}>{confirmation?.action}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
