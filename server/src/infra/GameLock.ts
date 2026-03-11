export class GameLock {
  private locks = new Map<string, Promise<void>>();

  async withLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(gameId) || Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    // 无论前一个任务成功与否，都要执行当前任务
    // 使用 .then() 链接，确保存储的 Promise 永远是 resolve 状态
    const nextPromise = prev.then(() => current).catch(() => current);
    this.locks.set(gameId, nextPromise);

    try {
      // 等待前一个任务完成（无论成功失败）
      await prev.catch(() => {}); 
      return await fn();
    } finally {
      release();
      if (this.locks.get(gameId) === nextPromise) {
        this.locks.delete(gameId);
      }
    }
  }
}
