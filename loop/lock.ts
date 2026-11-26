// One measure run at a time: two at once would score the same repos and overwrite each other's reports. The lock is a
// file made with O_EXCL holding the owner's pid; a lock whose pid is gone is stale and is taken over.
import { openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// The lock the measure run and a re-read (reread.ts) both take, so neither runs while the other does.
export const runLock = () => process.env.LOOP_LOCK ?? join(import.meta.dirname, '..', 'logs', 'measure.lock');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// The lock, or the pid that holds it.
export function takeLock(path: string): { release: () => void } | { heldBy: number } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return {
        release: () => {
          try {
            if (Number(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path);
          } catch {}
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) return { heldBy: pid };
    unlinkSync(path);
  }
  throw new Error(`couldn't take ${path}`);
}
