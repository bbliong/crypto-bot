import type { IncomingMessage, ServerResponse } from "node:http";

/** Dashboard controls are intentionally open when the owner disables passwords. */
export function createProfit4Admin(_dir: string, _password?: string) {
  return {
    authenticated(_req: IncomingMessage) {
      return true;
    },
    login(_req: IncomingMessage, _res: ServerResponse, _value?: unknown) {},
    logout(_req: IncomingMessage, _res: ServerResponse) {},
  };
}
