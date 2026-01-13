export class Semaphore {
    capacity;
    available;
    waiters = [];
    constructor(capacity) {
        this.capacity = capacity;
        this.available = capacity;
    }
    async acquire() {
        if (this.available > 0) {
            this.available -= 1;
            return () => this.release();
        }
        await new Promise((resolve) => this.waiters.push(resolve));
        this.available -= 1;
        return () => this.release();
    }
    release() {
        this.available += 1;
        const next = this.waiters.shift();
        if (next)
            next();
    }
}
