/** 可被 signal 中斷的等待：中斷時以 AbortError 結束 */
export function sleep(durationMs: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const abortError = () =>
      new DOMException('The operation was aborted.', 'AbortError')
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
