// Draws the site's social cards at 1200×630 with Satori + resvg, from the stored reports.
//   node render.mjs repo owner/repo        → repo-owner__repo.png     (the report page's card)
//   node render.mjs home                   → home.png                  (the landing page's card: the skills)
//   node render.mjs scores                 → scores.png                (the Scores page's card)
//   node render.mjs how                    → how-it-works.png          (How it works)
//   node render.mjs findings               → findings.png              (Findings)
//   node render.mjs compare a/b c/d [e/f]  → compare-b-d.png           (2 or 3 repos head to head)
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import satori from 'satori';
import { scoreColour } from '../colour.ts';
import { grade } from '../scorer.ts';

const font = (pkg, file) => readFileSync(new URL(`node_modules/@fontsource/${pkg}/files/${file}`, import.meta.url));
const fonts = [
  { name: 'Host Grotesk', data: font('host-grotesk', 'host-grotesk-latin-400-normal.woff'), weight: 400 },
  { name: 'Host Grotesk', data: font('host-grotesk', 'host-grotesk-latin-500-normal.woff'), weight: 500 },
  { name: 'Host Grotesk', data: font('host-grotesk', 'host-grotesk-latin-700-normal.woff'), weight: 700 },
  { name: 'Plex Mono', data: font('ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff'), weight: 400 },
];

// ref0's tokens on the dark ground, as sRGB.
const C = { bg: '#0c0d0d', line: '#2b2c2b', ink: '#efeee9', muted: '#b4b3ac', faint: '#7c7c76' };
const band = (s) => scoreColour(s, 'dark');
const logo = `data:image/svg+xml;base64,${readFileSync(new URL('../../ci-gist/repo/assets/logo-dark.svg', import.meta.url)).toString('base64')}`;

const reports = readdirSync(new URL('../reports', import.meta.url)).map((d) => {
  const dir = new URL(`../reports/${d}/`, import.meta.url);
  return JSON.parse(readFileSync(new URL(readdirSync(dir).sort().at(-1), dir), 'utf8'));
});
const find = (repo) => reports.find((r) => r.repo.toLowerCase() === repo.toLowerCase()) ?? fail(`no report for ${repo}`);
const fail = (message) => {
  throw new Error(message);
};

// A tiny h() so the cards read like JSX.
const h = (type, props = {}, ...children) => ({ type, props: { ...props, children: children.flat().filter((c) => c !== false && c != null) } });
const box = (style, ...children) => h('div', { style: { display: 'flex', ...style } }, ...children);
const text = (style, s) => h('div', { style: { display: 'flex', ...style } }, String(s));
// A run of text whose [bracketed] parts are bold and in full ink.
// Satori lays each word out at its unkerned width but draws it kerned, so a word with kerning pairs ("Top", "average") leaves a gap after it.
// Each word is set on its own and pulled back by the kerning it loses, read from the same font files.
const opentype = createRequire(import.meta.url)('@shuding/opentype.js');
const faces = Object.fromEntries(fonts.filter((f) => f.name === 'Host Grotesk').map((f) => [f.weight, opentype.parse(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.length))]));
const kernLoss = (word, size, weight) => faces[weight].getAdvanceWidth(word, size, { kerning: true }) - faces[weight].getAdvanceWidth(word, size, { kerning: false });
const kerned = (str, size, weight) =>
  str.split(/(?<= )/).map((w) => text({ marginRight: kernLoss(w.trimEnd(), size, weight) }, w));
// Muted words with bracketed parts bold in full ink, at the size the parent sets.
const line = (parts, size, color = C.muted) =>
  box({ color, whiteSpace: 'pre' }, ...parts.flatMap((p) =>
    Array.isArray(p) ? box({ fontWeight: 700, color: C.ink }, ...kerned(p[0], size, 700)) : kerned(p, size, 400)));
const minutes = (m) => `${m.toFixed(1)} min`;
// Counts agree with their nouns: "1 line", "2 lines", "1 repo".
const plural = (n, word) => (n === 1 ? word : `${word}s`);
// Lines of code as [amount, noun]: "1.6M", "1M" (no ".0"), "48k", or the exact count under a thousand.
const size = (r) => {
  const n = r.profile.linesOfCode;
  const amount = n >= 999_500 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n); // 999,600 is "1M", not "1000k"
  return [amount, plural(n, 'line')];
};
const lines = (r) => size(r).join(' ');
const day = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
// Host Grotesk has no arrow glyph, so the arrow is drawn.
const arrow = (size, color = C.ink) =>
  h('img', { width: size, height: size, style: { position: 'relative', top: -Math.round(size * 0.2) },
    src: `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 6l6 6-6 6"/></svg>`).toString('base64')}` });

// One emoji by band: fast and up, ok, slow, drawn from Twemoji SVGs since Satori has no emoji font.
// Each sits on the text's baseline and is raised so its drawing's centre meets the capitals' centre (cap height 0.7 em).
// The turtle fills only the bottom half of its box, so it is drawn larger and raised more.
const mood = (s) => (s >= 75 ? '1f525' : s >= 50 ? '1f610' : '1f422');
const emoji = (code) => `data:image/svg+xml;base64,${readFileSync(new URL(`emoji/${code}.svg`, import.meta.url)).toString('base64')}`;
const icon = (code, fontSize) => {
  const k = fontSize / 40;
  const { size, top } = code === '1f422' ? { size: 44, top: -14 } : { size: 36, top: -9 };
  return h('img', { src: emoji(code), width: size * k, height: size * k, style: { position: 'relative', top: top * k } });
};
const moodIcon = (score, fontSize) => icon(mood(score), fontSize);
// On compare, places replace moods: gold, silver and bronze by PR wait.
const MEDALS = ['1f947', '1f948', '1f949'];
const named = (name, score, style, code = score == null ? null : mood(score)) =>
  box({ alignItems: 'baseline', gap: Math.round(style.fontSize * 0.35) }, text(style, name), code == null ? null : icon(code, style.fontSize));

const frame = (url, ...children) =>
  box({ width: 1200, height: 630, background: C.bg, color: C.ink, fontFamily: 'Host Grotesk', padding: 56, flexDirection: 'column' },
    box({ justifyContent: 'space-between', alignItems: 'center' },
      h('img', { src: logo, height: 34, width: 34 * (892.7 / 146.4) }),
      text({ fontFamily: 'Plex Mono', fontSize: 22, color: C.faint }, url)),
    ...children);
const footer = (left, right) =>
  box({ marginTop: 'auto', borderTop: `2px solid ${C.line}`, paddingTop: 28, justifyContent: 'space-between', fontSize: 32 }, left, right);
const meter = (width, value, height = 16) =>
  box({ width, height, background: C.line, borderRadius: height / 2 }, box({ width: Math.max(height, width * value), height, background: C.muted, borderRadius: height / 2 }));

// Muted stroke icons (Lucide, ISC), drawn at the text's size and centred on its capitals like the emoji.
const GLYPHS = {
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
};
const glyph = (name, fontSize, color = C.muted) =>
  h('img', { width: fontSize, height: fontSize, style: { position: 'relative', top: GLYPH_TOP * fontSize },
    src: `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name]}</svg>`).toString('base64')}` });
const GLYPH_TOP = -0.2; // measured: centres the icon on the digits within 2 px

// Host Grotesk 700's empty space at each digit's bottom right, in font units (measured with fontTools).
// A 7 ends at its left, so "/100" after it is pulled in by the difference to look evenly spaced.
const FOOT_GAP = { 7: 364 };
const footPull = (n, size) => -Math.round((((FOOT_GAP[String(n).at(-1)] ?? 55) - 55) * size * 0.6) / 1000);

// The grade, from the published scorer (A+ to F). Drawn as a tinted tile in
// the score's colour, so it reads as a label on the score rather than a second number.
const gradeOf = (score) => grade(score);
const FOOT_BOTTOM = 15; // measured: "/100" sits on the digits' baseline
const gradeTile = (score, size, style = {}) =>
  // One width for every grade, wide enough for "A+", so tiles line up in a column.
  box({ width: Math.round(size * 1.3), height: size, flexShrink: 0, borderRadius: Math.round(size * 0.24), background: `${band(score)}1f`, border: `2px solid ${band(score)}59`,
    alignItems: 'center', justifyContent: 'center', ...style },
    text({ fontSize: Math.round(size * 0.58), fontWeight: 700, color: band(score), lineHeight: 1 }, gradeOf(score)));

// The repo's dominant language, its largest share of code, as Pierre's icon (pierrecomputer/vscode-icons, MIT) in its GitHub colour,
// left of the repo name on every card that names a repo (decided 19 Nov). A language the set doesn't have, or none, draws no icon.
const topLanguage = (r) => r.profile.languages?.[0]?.[0];
const LANGS = { C: ['c', '#555555'], Go: ['go', '#00add8'], JavaScript: ['javascript', '#f1e05a'], Python: ['python', '#3572a5'],
  Ruby: ['ruby', '#701516'], Rust: ['rust', '#dea584'], Swift: ['swift', '#f05138'], TypeScript: ['typescript', '#3178c6'] };
const langIcon = (language, px) => {
  const [slug, colour] = LANGS[language] ?? [];
  if (!slug) return null;
  const svg = readFileSync(new URL(`pierre/lang-${slug}.svg`, import.meta.url), 'utf8').replaceAll('currentColor', colour);
  return h('img', { width: px, height: px, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
};

// The report page: the score, its three parts, and where the repo stands among repos its size.
const repoCard = (me) => {
  const peers = reports.filter((r) => r.repo !== me.repo && r.size === me.size && r.score != null);
  // Place among scored repos of its size class, by score like the leaderboard and compare's medals; ties go to the shorter wait.
  const rank = 1 + peers.filter((r) => r.score != null && (r.score > me.score || (r.score === me.score && r.wait.p50 < me.wait.p50))).length;
  // Said from whichever end is nearer while it's in the outer quarter, "Top 4%" or "Bottom 15%", and as about average in the middle half,
  // where "Top 49%" would read like praise for a middling score.
  const total = peers.length + 1;
  const top = Math.ceil((rank / total) * 100), bottom = Math.ceil(((total - rank + 1) / total) * 100);
  const standing = top <= 25 ? ['Top ', [`${top}%`], ` of ${me.size} repos`]
    : bottom <= 25 ? ['Bottom ', [`${bottom}%`], ` of ${me.size} repos`]
    : [`About average for ${me.size} repos`];

  return frame(`ci-doctor.ref0.dev/${me.repo}`,
    box({ marginTop: 'auto', alignItems: 'flex-end', justifyContent: 'space-between' },
      box({ flexDirection: 'column' },
        box({ alignItems: 'center', gap: 16 }, langIcon(topLanguage(me), 44), named(me.repo, me.score, { fontSize: 40, fontWeight: 500 })),
        // "/100" at the number's foot, level with the digits' baseline.
        box({ marginTop: 26 },
              text({ fontSize: 220, fontWeight: 700, lineHeight: 0.9, color: band(me.score), letterSpacing: -8 }, me.score),
              box({ flexDirection: 'column', justifyContent: 'flex-end', marginLeft: 18, paddingBottom: FOOT_BOTTOM },
                text({ fontSize: 36, color: C.muted, lineHeight: 1, marginLeft: footPull(me.score, 220) }, '/100')))),
      box({ paddingBottom: 16, flexDirection: 'column', gap: 22 },
        ...['speed', 'reliability', 'efficiency'].map((k) =>
          box({ alignItems: 'center', gap: 16, fontSize: 31 },
            text({ width: 138, color: C.muted }, k[0].toUpperCase() + k.slice(1)),
            meter(250, me.parts[k] / 100),
            text({ width: 56, fontWeight: 700, justifyContent: 'flex-end' }, me.parts[k]))))),
    footer(
      box({ alignItems: 'baseline', gap: 12 }, glyph('timer', 32), line([[me.wait.p50.toFixed(1)], ' min · ', [size(me)[0]], ` ${size(me)[1]}`], 32)),
      line(standing, 32)));
};

const dataset = () => {
  const scored = reports.filter((r) => r.score != null && Number.isFinite(r.wait.p50));
  const waits = scored.map((r) => r.wait.p50).sort((a, b) => a - b);
  return { count: scored.length, median: waits[Math.floor(waits.length / 2)] };
};
// Two scores with an arrow between: the before card dimmed with its sticker on the left, the after card glowing in its colour.
// Each side is [score, p50 minutes]. Home shows an example pair; a repo's history shows its own.
// Tight trims the cards' inner padding, for history, where a title sits above them.
// The pill says how much faster unless given its words, as home gives "/ci-doctor".
const beforeAfter = (before, after, tight = false, pill) => {
  const pad = tight ? { height: 196, side: 30, foot: 26, top: 26, right: 32 } : { height: 214, side: 36, foot: 32, top: 26, right: 32 };
  const sticker = (score, side) =>
    box({ position: 'absolute', top: -26, [side]: -18, transform: `rotate(${side === 'right' ? 12 : -12}deg)` }, h('img', { src: emoji(mood(score)), width: 64, height: 64 }));
  const mini = ([score, mins], live) =>
    box({ width: 420, height: pad.height, flexShrink: 0, borderRadius: 22, background: '#161717', border: `2px solid ${live ? `${band(score)}88` : C.line}`,
      boxShadow: live ? `0 0 70px 6px ${band(score)}40` : 'none', position: 'relative', alignItems: 'flex-end', padding: `0 ${pad.side}px ${pad.foot}px` },
      box({ position: 'absolute', top: pad.top, right: pad.right, fontSize: 28, opacity: live ? 1 : 0.6 }, line([[mins.toFixed(1)], ' min'], 28)),
      box({ alignItems: 'baseline', gap: 10, opacity: live ? 1 : 0.6 },
        text({ fontSize: 120, fontWeight: 700, lineHeight: 0.85, letterSpacing: -4, color: band(score) }, score),
        text({ fontSize: 30, color: C.muted, marginLeft: footPull(score, 120) }, '/100')),
      sticker(score, live ? 'right' : 'left'));
  const times = before[1] / after[1];

  return box({ alignItems: 'center', justifyContent: 'space-between' },
    mini(before, false),
    box({ flexDirection: 'column', alignItems: 'center', gap: 14 },
      box({ height: 50, borderRadius: 25, padding: '0 20px', alignItems: 'center', fontSize: 26, background: '#161717', border: `2px solid ${C.line}` },
        pill === undefined ? line([[`${times.toFixed(1)}×`], ' faster'], 26) : text({ fontFamily: 'Plex Mono' }, pill)),
      arrow(52, C.muted)),
    mini(after, true));
};

// A card's title and the line under it, as the page's hero says them, under the header.
const titled = (url, title, words, ...children) =>
  box({ width: 1200, height: 630, position: 'relative', overflow: 'hidden', background: C.bg, color: C.ink, fontFamily: 'Host Grotesk', flexDirection: 'column', padding: 56 },
    box({ justifyContent: 'space-between', alignItems: 'center' },
      h('img', { src: logo, height: 34, width: 34 * (892.7 / 146.4) }),
      text({ fontFamily: 'Plex Mono', fontSize: 22, color: C.faint }, url)),
    text({ marginTop: 56, fontSize: 68, fontWeight: 500, letterSpacing: -2, lineHeight: 1 }, title),
    box({ marginTop: 20, fontSize: 30, color: C.muted, width: 940, lineHeight: 1.3, flexWrap: 'wrap', whiteSpace: 'pre' }, ...kerned(words, 30, 400)),
    ...children);

// The Scores page: its title and what a score is, over an example before and after.
const scoresCard = () =>
  titled('ci-doctor.ref0.dev/scores', 'Score your CI', 'How fast and how reliable your CI is, out of 100, ranked against repos its size.',
    box({ marginTop: 'auto', flexDirection: 'column' }, beforeAfter([31, 24.1], [92, 3.2], true, '/ci-doctor')));

// How it works: the three parts as one bar, each segment as wide as its weight.
const PARTS = [['Speed', 60, '#efeee9'], ['Reliability', 20, '#b4b3ac'], ['Efficiency', 20, '#7c7c76']];
const howCard = () =>
  titled('ci-doctor.ref0.dev/scores/how-it-works', 'How it works', 'Three parts, each scored 0 to 100 from its GitHub Actions runs, weighed into one score.',
    box({ marginTop: 'auto', flexDirection: 'column', gap: 22, paddingBottom: 12 },
      box({ gap: 8 }, ...PARTS.map(([, w, c]) => box({ flexGrow: w, flexBasis: 0, height: 28, borderRadius: 6, background: c }))),
      box({ gap: 8 }, ...PARTS.map(([name, w]) =>
        box({ flexGrow: w, flexBasis: 0, flexDirection: 'column', gap: 4 },
          text({ fontSize: 30, fontWeight: 500 }, name),
          box({ fontSize: 26 }, line([[String(w)], ' points'], 26)))))));

// Findings: one claim, counted from the stored reports, as a tile.
const findingsCard = () => {
  const { count, median } = dataset();
  return titled('ci-doctor.ref0.dev/scores/findings', 'Findings', 'Claims about CI, counted from every scored repo’s newest report, each with the SQL that reads it.',
    box({ marginTop: 'auto', borderRadius: 22, border: `2px solid ${C.line}`, background: '#161717', padding: '48px 40px', alignItems: 'center', gap: 36 },
      box({ alignItems: 'baseline', gap: 12 },
        text({ fontSize: 96, fontWeight: 700, lineHeight: 0.9, letterSpacing: -3 }, median.toFixed(1)),
        text({ fontSize: 32, color: C.muted }, 'min')),
      box({ flexDirection: 'column', gap: 6 },
        text({ fontSize: 32, fontWeight: 500 }, 'The typical PR waits this long for CI'),
        box({ fontSize: 26 }, line(['The median p50 wait across ', [String(count)], ' scored repos'], 26)))));
};

// A repo's history: its score and PR wait before a change and after, each from its own window of PR runs.
// The footer says how many days it's been since the split, and the minutes the change saves each PR's wait.
const [NAME_GAP, NUDGE] = [32, 9]; // measured: 71 px from the header to the name and 70 from the cards to the rule
const historyCard = (h) =>
  frame(`ci-doctor.ref0.dev/${h.repo}/history`,
    // Centred between the header and the footer's rule, the name close over the cards.
    box({ flexGrow: 1, flexDirection: 'column', justifyContent: 'center', paddingBottom: NUDGE },
      box({ alignItems: 'center', gap: 16, marginBottom: NAME_GAP }, langIcon(h.language, 44), text({ fontSize: 40, fontWeight: 500 }, h.repo)),
      beforeAfter(h.before, h.after, true)),
    footer(
      line([[String(h.days)], ` ${plural(h.days, 'day')}`], 32),
      line([[(h.before[1] - h.after[1]).toFixed(1)], ' min saved per PR'], 32)));

// The compare page: 2 or 3 repos side by side. Each bar is the repo's score, out of 100, and the medals go by score.
// Each repo's size and PR wait sit under its name, and the footer says how much faster the fastest one's checks finish.
const compareCard = (repos) => {
  const lanes = repos.map(find).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const byWait = [...lanes].sort((a, b) => a.wait.p50 - b.wait.p50);
  const short = (r) => r.repo.split('/')[1];
  const times = byWait.at(-1).wait.p50 / byWait[0].wait.p50;
  const big = lanes.length <= 2;

  return frame(`ci-doctor.ref0.dev/compare/${repos.map((r) => r.split('/')[1]).join('/')}`,
    // The lanes take the space between the header and the footer's rule, centred in it.
    box({ flexGrow: 1, justifyContent: 'center', flexDirection: 'column', gap: big ? 34 : 24, paddingBottom: 8 },
      ...lanes.map((r, place) =>
        box({ alignItems: 'center', fontSize: big ? 40 : 34 },
          box({ width: 340, flexShrink: 0, flexDirection: 'column', gap: 2 },
            box({ alignItems: 'center', gap: big ? 16 : 14 }, langIcon(topLanguage(r), big ? 44 : 38),
              named(short(r), r.score, { fontSize: big ? 40 : 34, fontWeight: 500 }, MEDALS[place])),
            text({ fontSize: big ? 26 : 22, color: C.muted }, `${lines(r)} · ${minutes(r.wait.p50)}`)),
          meter(600, (r.score ?? 0) / 100, big ? 22 : 18),
          text({ width: 76, flexShrink: 0, fontWeight: 700, justifyContent: 'flex-end', color: band(r.score) }, r.score ?? '–'),
          gradeTile(r.score, big ? 48 : 42, { marginLeft: 18 })))),
    // Under 1.1×, "1.0× faster" says nothing, so a near tie says so instead (decided 19 Nov).
    footer(line(times < 1.1
      ? [[short(byWait[0])], lanes.length > 2 ? ', ' : ' and ', [short(byWait[1])], ...(lanes.length > 2 ? [' and ', [short(byWait[2])]] : []), ' finish PR checks in about the same time']
      : [[short(byWait[0])], ' finishes PR checks ', [`${times.toFixed(1)}× faster`], ' than ', [short(byWait.at(-1))]], 32), null));
};


// The skills card, for the home page and the guide: the hero's question over the skills as a deck dropped on the floor,
// each card its mark, name and a short line, the whole plan's in the site's blue.
const BLUE = '#75a3fc'; // oklch(72% 0.14 263), the site's --primary on dark
const SKILLS = [
  ['speed-up-tests', 'Finds the tests that hold up every run.', 70, 392, -6],
  ['ci-doctor', 'Measures your CI, then plans and fixes it.', 430, 372, 0],
  ['cache-ci', 'Caches installs and builds that never hit.', 790, 392, 6],
];
const skillMark = (name, px, color) =>
  h('img', { width: px, height: px, src: `data:image/svg+xml;base64,${Buffer.from(readFileSync(new URL(`skills/${name}.svg`, import.meta.url), 'utf8').replaceAll('currentColor', color)).toString('base64')}` });
const skillCard = ([name, words, left, top, turn]) => {
  const hub = name === 'ci-doctor';
  return box({ position: 'absolute', left, top, width: 340, height: 200, transform: `rotate(${turn}deg)`, flexDirection: 'column', gap: 12, padding: '26px 28px',
    borderRadius: 22, background: '#161717', border: `2px solid ${hub ? `${BLUE}99` : C.line}`,
    boxShadow: hub ? `0 0 60px 4px ${BLUE}33, 0 24px 40px -12px #000000` : '0 24px 40px -12px #000000' },
    box({ alignItems: 'center', gap: 12 }, skillMark(name, 32, hub ? BLUE : C.ink), text({ fontSize: 30, fontWeight: 500 }, name)),
    box({ width: 284, fontSize: 22, lineHeight: 1.35, color: C.muted, flexWrap: 'wrap', whiteSpace: 'pre' }, ...kerned(words, 22, 400)));
};
const skillsCard = () =>
  box({ width: 1200, height: 630, position: 'relative', overflow: 'hidden', background: C.bg, color: C.ink, fontFamily: 'Host Grotesk', flexDirection: 'column' },
    box({ padding: '56px 56px 0', flexDirection: 'column' },
      box({ justifyContent: 'space-between', alignItems: 'center' },
        h('img', { src: logo, height: 34, width: 34 * (892.7 / 146.4) }),
        text({ fontFamily: 'Plex Mono', fontSize: 22, color: C.faint }, 'ci-doctor.ref0.dev')),
      text({ marginTop: 64, fontSize: 68, fontWeight: 500, letterSpacing: -2, lineHeight: 1 }, 'Burning time and money on CI?'),
      box({ marginTop: 22, fontSize: 30, color: C.muted, width: 900, lineHeight: 1.3 },
        'Skills that teach your coding agents to make CI fast, reliable and efficient, and keep it that way.')),
    // Drawn so the pile overlaps: the whole plan last, on top.
    ...SKILLS.filter(([n]) => n !== 'ci-doctor').map(skillCard),
    skillCard(SKILLS.find(([n]) => n === 'ci-doctor')));

const [kind = 'repo', ...args] = process.argv.slice(2);
const [name, card] =
  kind === 'home' ? ['home', skillsCard()]
  : kind === 'scores' ? ['scores', scoresCard()]
  : kind === 'how' ? ['how-it-works', howCard()]
  : kind === 'findings' ? ['findings', findingsCard()]
  // An example until a real adopter's history exists: the brand's made-up cast, never a real repo with invented numbers.
  : kind === 'history' ? ['history', historyCard({ repo: 'pip/garden', language: 'TypeScript', before: [48, 18.6], after: [81, 6.2], days: 11 })]
  : kind === 'compare' ? [`compare-${args.map((r) => r.split('/')[1]).join('-')}`, compareCard(args.length >= 2 && args.length <= 3 ? args : fail('compare takes 2 or 3 repos'))]
  : [`repo-${args[0].replace('/', '__')}`, repoCard(find(args[0] ?? fail('repo takes owner/repo')))];
const svg = await satori(card, { width: 1200, height: 630, fonts });
writeFileSync(`${name}.png`, new Resvg(svg).render().asPng());
console.log(`${name}.png`);
