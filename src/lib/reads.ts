// GETs are bounded independently of AbortSignal support in fetch/body readers.
// Writes deliberately do not use this helper: their outcome must be reconciled.
export const READ_TIMEOUT_MS = 15000;
export class ReadTimeoutError extends Error {
  constructor() { super('読み込みが時間内に完了しませんでした。'); this.name = 'ReadTimeoutError'; }
}
export async function readJson(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch, failureMessage = 'ログインを確認できません。再読み込みしてください。'): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => { reject(new DOMException('Read superseded', 'AbortError')); controller.abort(); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { reject(new ReadTimeoutError()); controller.abort(); }, READ_TIMEOUT_MS);
  });
  try {
    if (signal.aborted) return await interrupted;
    const reading = (async () => {
      const response = await fetcher(url, { method: 'GET', cache: 'no-store', signal: controller.signal });
      controller.signal.throwIfAborted();
      // A real rejection must fail closed even if its error body never arrives.
      if (!response.ok) throw new Error(failureMessage);
      const value: unknown = await response.json();
      controller.signal.throwIfAborted();
      return value;
    })();
    return await Promise.race([reading, interrupted]);
  } catch (error) {
    controller.abort(); throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
