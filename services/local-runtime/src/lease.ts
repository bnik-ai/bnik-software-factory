import type { PostgresQueue } from './queue.js';

// One renewable lease per active claim. Failure aborts the handler signal;
// settlement still fences in PostgreSQL even if a caller ignores cancellation.
export class LeaseGuard {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(
    private readonly queue: PostgresQueue,
    private readonly token: string,
  ) {
    this.schedule();
  }
  private schedule(): void {
    this.timer = setTimeout(
      () => {
        this.pending = this.queue
          .renew(this.token)
          .then(() => {
            if (!this.stopped) this.schedule();
          })
          .catch(() => {
            if (!this.stopped) this.controller.abort(new Error('work_lease_lost'));
          });
      },
      Math.max(25, Math.floor(this.queue.options.leaseMs / 3)),
    );
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
  abort(): void {
    this.controller.abort(new Error('work_cancelled'));
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
