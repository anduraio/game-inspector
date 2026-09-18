// Just enough Chrome DevTools Protocol to attach to a page and run a script in
// it.
//
// No dependencies: Node has had a WebSocket client built in since 22, and the
// rest of the protocol this needs is one HTTP GET and a JSON message pump. The
// alternative was depending on a browser automation library, which would make
// a tool that attaches to games depend on a tool that drives browsers, for
// about a hundred lines of work.

/** Thrown when the debugging port answers with something that is not Chrome. */
export class CdpError extends Error {}

const defaultHost = '127.0.0.1';

/** Every debuggable page, tab, worker and iframe Chrome is currently holding. */
export async function listTargets({ port = 9222, host = defaultHost, timeout = 4000 } = {}) {
  const url = `http://${host}:${port}/json/list`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new CdpError(
      `nothing is listening on ${host}:${port}. Start Chrome with `
      + `--remote-debugging-port=${port}, or run with --launch to start one.`,
      { cause: err },
    );
  }
  if (!response.ok) {
    throw new CdpError(`${url} answered ${response.status}`);
  }
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new CdpError(`${url} did not return a target list`);
  return targets;
}

/** The version endpoint doubles as "is this port actually a browser". */
export async function browserVersion({ port = 9222, host = defaultHost, timeout = 4000 } = {}) {
  const response = await fetch(`http://${host}:${port}/json/version`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new CdpError(`/json/version answered ${response.status}`);
  return response.json();
}

/**
 * Pick the tab to inspect. A page target with a real URL and a debugger socket
 * is the only kind that can host a game; `match` narrows it by substring,
 * because "the one on localhost:5174" is how a person thinks about it.
 */
export function chooseTarget(targets, match = null) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url);
  if (!pages.length) {
    throw new CdpError('no inspectable page is open in that browser');
  }
  if (!match) return pages[0];
  const wanted = String(match).toLowerCase();
  const hit = pages.find((t) => t.url.toLowerCase().includes(wanted))
    ?? pages.find((t) => (t.title ?? '').toLowerCase().includes(wanted));
  if (!hit) {
    throw new CdpError(
      `no page matching "${match}". Open pages:\n`
      + pages.map((t) => `  ${t.title || '(untitled)'}  ${t.url}`).join('\n'),
    );
  }
  return hit;
}

/**
 * A live session with one target.
 *
 * Requests are id-tagged and their replies are matched back, so calls can be
 * made concurrently without the caller tracking ids.
 */
export class Session {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onClosed = null;

    socket.addEventListener('message', (event) => this.#receive(event.data));
    socket.addEventListener('close', () => this.#close());
    socket.addEventListener('error', () => this.#close());
  }

  static async open(webSocketDebuggerUrl, { timeout = 8000 } = {}) {
    if (typeof WebSocket === 'undefined') {
      throw new CdpError('this Node has no built-in WebSocket; Node 22 or newer is required');
    }
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('timed out opening the debugger socket')), timeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new CdpError(`could not open the debugger socket: ${event?.message ?? 'unknown error'}`));
      }, { once: true });
    });
    return new Session(socket);
  }

  #receive(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id === undefined) return; // an event, not a reply
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new CdpError(`${message.error.message} (${entry.method})`));
    else entry.resolve(message.result);
  }

  #close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      entry.reject(new CdpError('the debugger socket closed before the call came back'));
    }
    this.pending.clear();
    this.onClosed?.();
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new CdpError('the debugger socket is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Run an expression in the page and bring the value back.
   *
   * `awaitPromise` means an expression can return a promise and be waited on,
   * and `returnByValue` means the answer arrives as data rather than as an
   * object id we would then have to manage. The cost is that the result has to
   * be JSON-shaped, which is the right trade for a status readout.
   */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'the expression threw';
      throw new CdpError(text.split('\n')[0]);
    }
    return result.result?.value;
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.close();
    } catch {
      this.#close();
    }
  }
}
