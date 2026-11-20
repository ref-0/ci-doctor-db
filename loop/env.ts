// The environment the measure job runs with and gives its children. With NODE_DEBUG=child_process Node prints each
// spawn's options, env and all, to stderr, and that env holds GH_TOKEN; an inspector can read it from memory. So the
// job refuses to start with either set, and its children get an env without them. The token goes only in GH_TOKEN,
// never in argv or a log.
// Flags that open an inspector; --inspect-port and the like only configure one.
const DEBUG_FLAG = /^--(inspect(-brk|-wait)?|debug(-brk)?)(=|$)/;

// Why the job won't run in this env, or nothing.
export function debugSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  const why: string[] = [];
  for (const k of ['NODE_DEBUG', 'NODE_DEBUG_NATIVE']) if (env[k]) why.push(`${k} is set`);
  const flags = (env.NODE_OPTIONS ?? '').split(/\s+/).filter((f) => DEBUG_FLAG.test(f));
  if (flags.length) why.push(`NODE_OPTIONS has ${flags.join(' ')}`);
  if (process.execArgv.some((f) => DEBUG_FLAG.test(f))) why.push(`node was started with ${process.execArgv.filter((f) => DEBUG_FLAG.test(f)).join(' ')}`);
  return why;
}

// process.env without the debug settings, plus `extra`.
export function childEnv(extra: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.NODE_DEBUG;
  delete out.NODE_DEBUG_NATIVE;
  const options = (env.NODE_OPTIONS ?? '').split(/\s+/).filter((f) => f && !DEBUG_FLAG.test(f)).join(' ');
  if (options) out.NODE_OPTIONS = options;
  else delete out.NODE_OPTIONS;
  return { ...out, ...extra };
}
