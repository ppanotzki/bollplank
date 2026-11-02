// One argument parser for every command. A spec names each flag and its kind:
// 'value' takes the next argument, 'bool' takes none, 'list' takes a comma separated value.
// A value flag followed by nothing or by another flag is a usage error, never a silent true.
export function parse(argv, spec = {}) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    const kind = spec[name];
    if (!kind) return { error: `unknown option --${name}` };
    if (kind === 'bool') {
      opts[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `--${name} needs a value` };
    opts[name] = kind === 'list' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;
    i++;
  }
  return { opts, positional };
}

// Name the required options that are missing, or return null when all are there.
export function missing(opts, names) {
  const missing = names.filter((n) => opts[n] === undefined);
  return missing.length ? `missing ${missing.map((n) => `--${n}`).join(', ')}` : null;
}
