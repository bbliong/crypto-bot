import type { EventEmitter } from 'node:events';

/** Idempotent CLI shutdown; caller supplies the actual process exit function. */
export function attachFollowerShutdown(
  signals: Pick<EventEmitter,'on'>,
  stop: () => Promise<void>,
  exit: (code: number) => void,
): void {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void stop().then(() => exit(0), error => {
      console.warn('[FOLLOWER] graceful shutdown failed:', String(error));
      exit(1);
    });
  };
  signals.on('SIGINT', shutdown);
  signals.on('SIGTERM', shutdown);
}
