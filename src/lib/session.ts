export function readNamespace(value: unknown): string {
  if (!value || typeof value !== 'object' || !('namespace' in value) || typeof value.namespace !== 'string' || !/^u_[a-f0-9]{64}$/.test(value.namespace)) throw new Error('ログイン情報を確認して再読み込みしてください。');
  return value.namespace;
}
export function identityChanged(status: number, value: unknown): boolean {
  return status === 401 || status === 403 || (status === 409 && !!value && typeof value === 'object' && 'code' in value && value.code === 'identity_changed');
}
export async function readSessionFile(file: { text(): Promise<string> }, isCurrent: () => boolean): Promise<string | null> {
  if (!isCurrent()) return null;
  const text = await file.text();
  return isCurrent() ? text : null;
}
export async function verifyLoadedNamespace(value: unknown, currentSession: () => Promise<unknown>, isCurrent: () => boolean): Promise<string | null> {
  const namespace = readNamespace(value);
  if (!isCurrent()) return null;
  const current = readNamespace(await currentSession());
  if (!isCurrent()) return null;
  if (namespace !== current) throw new Error('ログインしたユーザーが変わりました。再読み込みしてください。');
  return namespace;
}
export function sessionChecks() {
  let generation = 0, active: AbortController | null = null;
  return {
    begin() {
      active?.abort();
      const controller = new AbortController(), started = ++generation;
      active = controller;
      return { signal: controller.signal, isCurrent: () => started === generation && !controller.signal.aborted };
    },
    cancel() { generation++; active?.abort(); active = null; },
  };
}
