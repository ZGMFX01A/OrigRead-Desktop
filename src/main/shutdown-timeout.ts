/** Bound external cleanup, including synchronous throws, and always release the timer. */
export async function withShutdownTimeout(action: () => unknown | Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Shutdown cleanup timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
