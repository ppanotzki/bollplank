// Questions for init and uninstall. On a terminal they are asked through readline. With an
// answers file every question is looked up by its key instead, so tests and automation run the
// same steps with no terminal. A key the file leaves out takes the question's default.
//
// Keys are paths into the answers object, such as ['checks', 'acme-api'] for answers.checks['acme-api'].
import { createInterface } from 'node:readline/promises';
import { fail } from '../out.mjs';

export function asker({ answers = null, json = false } = {}) {
  const out = json ? process.stderr : process.stdout;
  // The interface opens at once, so input typed ahead of the first question is kept.
  const rl = answers === null ? createInterface({ input: process.stdin, output: out, terminal: Boolean(process.stdin.isTTY) }) : null;
  const line = async (q) => {
    try {
      return (await rl.question(q)).trim();
    } catch (e) {
      if (e?.name === 'AbortError') fail('stopped', 'Stopped before the end. Run the command again to finish.');
      throw e;
    }
  };
  const given = (key) => {
    let v = answers;
    for (const k of [key].flat()) v = v && typeof v === 'object' ? v[k] : undefined;
    return v;
  };
  const name = (key) => [key].flat().join('.');
  const scripted = answers !== null;

  return {
    scripted,
    // Free text. A required question with no default and no answer in the file is a usage error.
    async text(key, question, def, { required = true } = {}) {
      if (scripted) {
        const v = given(key);
        if (v !== undefined && v !== null) return String(v);
        if (def !== undefined || !required) return def ?? '';
        fail('usage', `the answers file has no ${name(key)}, and "${question}" has no default`);
      }
      for (;;) {
        const v = await line(`${question}${def ? ` [${def}]` : ''} `);
        if (v) return v;
        if (def !== undefined || !required) return def ?? '';
      }
    },
    async yes(key, question, def = false) {
      if (scripted) {
        const v = given(key);
        return typeof v === 'boolean' ? v : def;
      }
      for (;;) {
        const v = (await line(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
        if (!v) return def;
        if (['y', 'yes'].includes(v)) return true;
        if (['n', 'no'].includes(v)) return false;
      }
    },
    // One of options, by number or by name. allowOther takes any typed name.
    async pick(key, question, options, def, { allowOther = false } = {}) {
      if (scripted) {
        const v = given(key);
        if (v === undefined || v === null) {
          if (def !== undefined) return def;
          fail('usage', `the answers file has no ${name(key)}, and "${question}" has no default`);
        }
        const s = String(v);
        if (options.includes(s) || allowOther) return s;
        fail('usage', `${name(key)} must be one of ${options.join(', ')}`);
      }
      const list = options.map((o, i) => `  ${i + 1}. ${o}`).join('\n');
      for (;;) {
        const v = await line(`${question}\n${list}\n${allowOther ? 'Pick a number or type a name' : 'Pick a number'}${def ? ` [${def}]` : ''} `);
        if (!v && def !== undefined) return def;
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
        const match = options.find((o) => o.toLowerCase() === v.toLowerCase());
        if (match) return match;
        if (allowOther && v) return v;
      }
    },
    // A comma separated list.
    async list(key, question, def = []) {
      if (scripted) {
        const v = given(key);
        if (Array.isArray(v)) return v.map(String);
        if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
        return def;
      }
      for (;;) {
        const v = await line(`${question}${def.length ? ` [${def.join(', ')}]` : ''} `);
        if (!v && def.length) return def;
        const items = v.split(',').map((s) => s.trim()).filter(Boolean);
        if (items.length) return items;
      }
    },
    close() {
      rl?.close();
    },
  };
}
