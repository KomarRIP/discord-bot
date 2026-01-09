import { AppError } from "../../shared/errors/appError.js";
import { Semaphore } from "./semaphore.js";
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function withJitter(ms, jitterFraction) {
    const delta = ms * jitterFraction;
    const min = Math.max(0, ms - delta);
    const max = ms + delta;
    return Math.floor(min + Math.random() * (max - min));
}
export class RateLimitQueue {
    globalSemaphore;
    perGuildTails = new Map();
    inFlightByIdempotencyKey = new Map();
    constructor(params) {
        this.globalSemaphore = new Semaphore(params.maxGlobalConcurrency);
    }
    enqueue(op) {
        const existing = this.inFlightByIdempotencyKey.get(op.idempotencyKey);
        if (existing)
            return existing;
        const tail = this.perGuildTails.get(op.guildId) ?? Promise.resolve();
        const run = tail
            .catch(() => undefined)
            .then(async () => {
            const release = await this.globalSemaphore.acquire();
            try {
                return await this.runWithRetry(op);
            }
            finally {
                release();
            }
        });
        this.perGuildTails.set(op.guildId, run);
        this.inFlightByIdempotencyKey.set(op.idempotencyKey, run);
        run.finally(() => {
            if (this.inFlightByIdempotencyKey.get(op.idempotencyKey) === run) {
                this.inFlightByIdempotencyKey.delete(op.idempotencyKey);
            }
        });
        return run;
    }
    async runWithRetry(op) {
        const maxAttempts = op.budget.maxAttempts;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (new Date() > op.budget.deadlineAt) {
                throw new AppError({
                    code: "TRANSIENT_FAILURE",
                    message: "Operation deadline exceeded",
                    retryable: true,
                });
            }
            try {
                return await op.execute();
            }
            catch (e) {
                const err = op.classifyError(e);
                if (!err.retryable || attempt === maxAttempts)
                    throw err;
                // экспоненциальный backoff с jitter, как в rate-limit-and-retry.md
                const base = 500;
                const backoff = Math.min(20_000, base * 2 ** (attempt - 1));
                await sleep(withJitter(backoff, 0.3));
            }
        }
        throw new AppError({
            code: "TRANSIENT_FAILURE",
            message: "Operation failed after retries",
            retryable: true,
        });
    }
}
