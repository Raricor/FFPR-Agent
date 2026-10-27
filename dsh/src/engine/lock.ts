/**
 * One small asynchronous lock; the game is a single resource, so bridge calls and later engine
 * work run one at a time. Callers that arrive while it is held wait in arrival order.
 */

export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
