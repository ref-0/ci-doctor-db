// The published scorer, @ref0/ci-doctor, from a ci-doctor checkout's source rather than from npm: the loop runs
// what's on ci-doctor's `main`, so a scorer or calibration change there is checked against every stored report before
// it's released, and npm has only releases. Node runs the TypeScript as it is, so there's nothing to build or install.
// CI_DOCTOR_SCORER names the checkout's scorer/src; the default is the loop's own checkout of `main`, at
// ~/ref0-work/ci-doctor-next, which loop/measure.ts creates once and fast-forwards each night.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCORER_SRC = process.env.CI_DOCTOR_SCORER ?? join(homedir(), 'ref0-work', 'ci-doctor-next', 'scorer', 'src');

const scorer = await import(pathToFileURL(join(SCORER_SRC, 'index.ts')).href);

export const { scoreRepo, scoreOf, inputsOf, grade, band, sizeClass, expectedWait, expectedMinutesPerMergedPr, expectedVcpuMinutesPerMergedPr, BYTES_PER_LINE, CODE_EXT, MAX_SOURCE_FILE, SKIP } = scorer;
