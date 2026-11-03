type Flush = () => Promise<void>
const flushers = new Set<Flush>()

/** Each mounted recovery buffer participates, including hidden workspaces. */
export function registerCloseFlush(flush: Flush): () => void {
  flushers.add(flush)
  return () => {
    flushers.delete(flush)
  }
}

/** Finish every save before reporting a failure so no writer outlives the acknowledgement. */
export async function flushBeforeClose(): Promise<void> {
  const results = await Promise.allSettled(
    [...flushers].map((flush) => Promise.resolve().then(flush)),
  )
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failed)
    throw failed.reason instanceof Error
      ? failed.reason
      : new Error('未能保存所有未发送内容，请重试退出。')
}
