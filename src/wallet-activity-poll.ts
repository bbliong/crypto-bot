// Self-contained so Playwright can evaluate this function inside the controller page.
export async function fetchWalletActivityPair(options: { incomingUrl: string; sellUrl: string; requestGapMs: number }) {
  const requests = [];
  for (const url of [options.incomingUrl, options.sellUrl]) {
    if (requests.length) await new Promise(resolve => setTimeout(resolve, options.requestGapMs));
    const startedAt = Date.now();
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30_000) });
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let body: { data?: { activities?: unknown[] } } | null = null;
    try { body = JSON.parse(text); } catch { /* Persist the actual non-JSON response below. */ }
    const valid = response.ok && Array.isArray(body?.data?.activities);
    requests.push({
      url, startedAt, finishedAt: Date.now(), status: response.status, contentType, valid,
      body, ...(valid ? {} : { rawBody: text }),
    });
    // A failed response must not be used to assume that the wallet has not sold.
    if (!valid) break;
  }
  return {
    requests,
    complete: requests.length === 2 && requests.every(request => request.valid),
    status: Math.max(...requests.map(request => request.status)),
    body: { data: { activities: requests.flatMap(request => request.body?.data?.activities ?? []) } },
  };
}
