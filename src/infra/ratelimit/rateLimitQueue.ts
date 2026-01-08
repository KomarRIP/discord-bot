import { AppError } from "../../shared/errors/appError.js";
import { Semaphore } from "./semaphore.js";

export type OperationKind =
  | "RoleEnsure"
  | "CategoryEnsure"
  | "ChannelEnsure"
  | "OverwritesReplace"
  | "MessageEnsure"
  | "Read";

export type OperationBudget = {
  deadlineAt: Date;
  maxAttempts: number;
};

export type Operation<T> = {
  guildId: string;
  kind: OperationKind;
  idempotencyKey: string;
  budget: OperationBudget;
  attempt?: number;
  execute: () => Promise<T>;
  classifyError: (e: unknown) => AppError;
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function withJitter(ms: number, jitterFraction: number) {
  const delta = ms * jitterFraction;
  const min = Math.max(0, ms - delta);
  const max = ms + delta;
  return Math.floor(min + Math.random() * (max - min));
}

export class RateLimitQueue {
  private readonly globalSemaphore: Semaphore;
  private readonly perGuildTails = new Map<string, Promise<unknown>>();
  private readonly inFlightByIdempotencyKey = new Map<string, Promise<unknown>>();

  constructor(params: { maxGlobalConcurrency: number }) {
    this.globalSemaphore = new Semaphore(params.maxGlobalConcurrency);
  }

  enqueue<T>(op: Operation<T>): Promise<T> {
    const existing = this.inFlightByIdempotencyKey.get(op.idempotencyKey) as Promise<T> | undefined;
    if (existing) return existing;

    const tail = this.perGuildTails.get(op.guildId) ?? Promise.resolve();
    const run = tail
      .catch(() => undefined)
      .then(async () => {
        const release = await this.globalSemaphore.acquire();
        try {
          return await this.runWithRetry(op);
        } finally {
          release();
        }
      });

    this.perGuildTails.set(op.guildId, run as Promise<unknown>);
    this.inFlightByIdempotencyKey.set(op.idempotencyKey, run as Promise<unknown>);

    run.finally(() => {
      if (this.inFlightByIdempotencyKey.get(op.idempotencyKey) === (run as Promise<unknown>)) {
        this.inFlightByIdempotencyKey.delete(op.idempotencyKey);
      }
    });

    return run;
  }

  private async runWithRetry<T>(op: Operation<T>): Promise<T> {
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
      } catch (e) {
        const err = op.classifyError(e);
        if (!err.retryable || attempt === maxAttempts) throw err;

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

