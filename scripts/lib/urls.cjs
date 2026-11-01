'use strict';
// URL checker: asks every source of a map for its page, so that a source that has died or moved off is found before the
// map is handed over. It reads nothing but the status: each page is requested with GET (many servers refuse HEAD), redirects
// are followed, and the body is cancelled as soon as the status is in, which also closes the connection.
const MAX_PARALLEL = 5;
const DEFAULT_TIMEOUT_MS = 10000;

const isWebAddress = url => typeof url === 'string' && /^https?:\/\//i.test(url); // fetch would also answer for a data: address

// The reason a request got no answer, in a few words: a timeout, or what the network said (a code such as ENOTFOUND or ECONNREFUSED).
function reasonFor(err, timeoutMs) {
  if (err?.name === 'TimeoutError') return `timed out after ${timeoutMs} ms`;
  const detail = err?.cause?.code ?? err?.cause?.message;
  const message = String(err?.message ?? err);
  return detail ? `${message}: ${detail}` : message;
}

// One source's result: { id, url, ok, status } when a page answered, { id, url, ok: false, error } when none did. Never rejects.
async function checkOne({ id, url }, timeoutMs) {
  if (!isWebAddress(url)) return { id, url, ok: false, error: 'not an http(s) url' };
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {}); // best effort: the status is what was asked for
    return { id, url, ok: res.status < 400, status: res.status };
  } catch (err) {
    return { id, url, ok: false, error: reasonFor(err, timeoutMs) };
  }
}

/**
 * Checks each source's url and returns one result per source, in the order given, 5 at a time.
 * - ok is true when the final answer, after any redirects, has a status below 400.
 * - status is the status of the answer. Every answer has one, a 404 or a 500 as well.
 * - error is there when no answer came: a timeout, a network failure, or a url that is not http or https.
 * @param {Array<{ id: string, url: string }> | Record<string, { id?: string, url: string }>} sources a list of sources, or the
 *   sources object of a map, keyed by id (an entry with no id of its own is named by its key)
 * @param {{ timeoutMs?: number }} [options] timeoutMs: how long each source gets to answer, in milliseconds above 0 (default 10000)
 * @returns {Promise<Array<{ id: string, url: string, ok: boolean, status?: number, error?: string }>>}
 */
async function checkUrls(sources, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new RangeError('timeoutMs must be a number of milliseconds above 0');
  const entries = Array.isArray(sources) ? sources.map(source => [undefined, source]) : Object.entries(sources ?? {});
  const list = entries.map(([key, source]) => ({ id: source?.id ?? key, url: source?.url }));

  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const at = next++;
      results[at] = await checkOne(list[at], timeoutMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, list.length) }, worker));
  return results;
}

module.exports = { checkUrls };
