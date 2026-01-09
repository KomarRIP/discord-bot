export class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  private release() {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

