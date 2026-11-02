// Every command prints one JSON result and stops through Exit, which the dispatcher turns into the
// exit code after stdout has been written, so a result piped to another program is never cut short.
export class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function emit(result, code = result.ok === false ? 1 : 0) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  throw new Exit(code);
}

export function fail(failure, detail, extra = {}) {
  emit({ ok: false, failure, ...(detail ? { detail } : {}), ...extra }, failure === 'usage' ? 2 : 1);
}

export function say(text) {
  process.stdout.write(text + '\n');
}
