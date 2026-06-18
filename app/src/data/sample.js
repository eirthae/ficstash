// ============================================================================
// Sample data for the Phase 0 shell (replaced by real Supabase data in Phase 1).
// Work titles are original placeholders; reader prose is original.
// ============================================================================

export const COVER_PALETTES = [
  ['#7828c8', '#006fee'], // purple → blue (default look)
  ['#481878', '#9353d3'], // deep violet
  ['#0e447a', '#338ef7'], // ocean
  ['#7a1340', '#f54180'], // wine → rose
  ['#0e5a3a', '#17c964'], // forest
  ['#8a4b10', '#f5a524'], // amber/ember
  ['#3a1d6e', '#c20e4d'], // plum → magenta
  ['#143a52', '#0e9c8a'], // teal night
];

export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
export function paletteFor(seed) {
  return COVER_PALETTES[hashStr(seed || '') % COVER_PALETTES.length];
}

const T = (t, k) => ({ t, k });

export const WORKS = [
  {
    id: 'w1', source: 'ao3', title: 'The Space Between Periods', author: 'glasswing',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: 'Two seasons, three time zones, and a secret that lives in hotel hallways. Shane keeps a list of all the cities where no one knows his name. Ilya keeps the room key.',
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Hurt/Comfort', 'freeform'), T('Slow Burn', 'freeform'), T('Pining', 'freeform')],
    words: 84200, chapters: 18, chaptersTotal: 22, status: 'ongoing', updated: '3 days ago',
    progress: 0.62, lastChapter: 11, palette: 0, inHistory: true, bookmarked: true,
  },
  {
    id: 'w2', source: 'ao3', title: 'Offside Hearts', author: 'northern_lights',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: 'A retirement, a farmhouse in Vermont, and twenty years of learning how to be loud about something they spent a decade keeping quiet.',
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Established Relationship', 'freeform'), T('Domestic Fluff', 'freeform'), T('Post-Canon', 'freeform')],
    words: 41800, chapters: 9, chaptersTotal: 9, status: 'complete', updated: 'Mar 2',
    progress: 1, lastChapter: 9, palette: 4, inHistory: true, subscribed: true,
  },
  {
    id: 'w3', source: 'ao3', title: 'Translation Errors', author: 'verbatim',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: "Ilya's English is perfect except for the words that matter most. A study in the things that get lost — and the ones that survive anyway.",
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Angst with a Happy Ending', 'freeform'), T('Language Barrier', 'freeform')],
    words: 22600, chapters: 5, chaptersTotal: 5, status: 'complete', updated: 'Jan 14',
    progress: 0.2, lastChapter: 1, palette: 1, inHistory: true,
  },
  {
    id: 'w4', source: 'ao3', title: 'A Quieter Country', author: 'samovar',
    fandom: 'Game Changers – Rachel Reid', pairing: 'Scott Hunter/Kip Grady',
    summary: 'Between the cameras and the contracts, a captain learns that the bravest thing on the ice is letting someone see you flinch.',
    tags: [T('Scott Hunter/Kip Grady', 'relationship'), T('Coming Out', 'freeform'), T('Found Family', 'freeform')],
    words: 67400, chapters: 14, chaptersTotal: 14, status: 'complete', updated: 'Feb 20',
    progress: 0.05, lastChapter: 1, palette: 5, inHistory: true, bookmarked: true, subscribed: true,
  },
  {
    id: 'w5', source: 'ao3', title: 'Last Call in St. Petersburg', author: 'ferrywoman',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: "The off-season fic that lived on AO3 for two years before it vanished. You saved it the week before. Now it's yours.",
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Summer', 'freeform'), T('Hurt/Comfort', 'freeform')],
    words: 31900, chapters: 7, chaptersTotal: 7, status: 'complete', updated: 'saved Apr 11',
    progress: 0.78, lastChapter: 5, palette: 3, frozen: true, frozenDate: 'Apr 11, 2025', inHistory: true, bookmarked: true,
  },
  {
    id: 'w6', source: 'ao3', title: 'Power Play', author: 'redline',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: 'Enemies-to-lovers, but make it the regular season. A rookie reporter, a leaked photo, and two men who are very bad at lying.',
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Enemies to Lovers', 'freeform'), T('Media', 'freeform'), T('Mutual Pining', 'freeform')],
    words: 12400, chapters: 3, chaptersTotal: 12, status: 'ongoing', updated: 'yesterday',
    progress: 0, lastChapter: 0, palette: 6, unread: true, subscribed: true,
  },
  {
    id: 'wchat', source: 'ao3', title: 'Read Receipts', author: 'after_hours',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: 'A texting fic. Three time zones, one group chat they shouldn’t be in, and a thread that says more than either of them will out loud.',
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Epistolary', 'freeform'), T('Texting', 'freeform'), T('Fluff', 'freeform')],
    words: 9800, chapters: 1, chaptersTotal: 1, status: 'complete', updated: 'Apr 2',
    progress: 0, lastChapter: 0, palette: 2, unread: true,
    // A sample AO3 work skin. NOTE the last rule is a deliberately BAD prose
    // override (#workskin p) — the sanitizer must strip it so prose keeps your
    // reader settings; only the .text/.msg/.who chat classes should style.
    workSkin: "#workskin .text{max-width:94%;margin:16px auto;font-family:-apple-system,'Segoe UI',sans-serif}#workskin .who{font-size:11px;color:#9a9a9f;margin:10px 0 2px 8px}#workskin .msg{display:block;width:fit-content;max-width:76%;padding:8px 13px;margin:4px 0;border-radius:18px;font-size:15px;line-height:1.35}#workskin .them{background:#e9e9eb;color:#111}#workskin .me{background:#0a7cff;color:#fff;margin-left:auto}#workskin .post{max-width:300px;margin:18px auto;border:1px solid #dbdbdb;border-radius:10px;overflow:hidden;background:#fff;color:#111;font-family:-apple-system,sans-serif}#workskin .phead{display:flex;align-items:center;gap:9px;padding:9px 11px}#workskin .pav{width:30px;height:30px;border-radius:50%;background:#1d6e56;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}#workskin .puser{font-size:13px;font-weight:600}#workskin .pimg{display:block;width:100%;height:auto}#workskin .pacts{display:flex;gap:14px;padding:9px 11px 2px;font-size:14px;color:#222}#workskin .plikes{font-size:13px;font-weight:600;padding:2px 11px}#workskin .pcap{font-size:13px;line-height:1.4;padding:3px 11px 11px}#workskin p{line-height:4 !important;color:#c0392b !important}",
  },
];

// Demo chapter bodies for sample works that need real HTML in the reader (the
// reader normally falls back to sample prose). Used by fetchChapters when there's
// no Supabase, so the chatfic styling can be previewed end-to-end.
export const DEMO_CHAPTERS = {
  wchat: [{
    n: 1, title: 'Read Receipts', words: 9800,
    content: '<p>Ilya didn\'t answer for six minutes. Shane watched the three dots appear, vanish, appear again, and tried to remember how to breathe like a person who wasn\'t waiting.</p>'
      + '<div class="text"><div class="who">Ilya</div>'
      + '<span class="msg them">you\'re up late</span>'
      + '<span class="msg them">or early. i can never tell with you anymore</span>'
      + '<span class="msg me">couldn\'t sleep. the trade rumours again</span>'
      + '<span class="msg them">come to Boston. problem solved</span>'
      + '<span class="msg me">you\'re impossible</span>'
      + '<span class="msg me">…what time is your flight</span></div>'
      + '<p>He hit send before he could think better of it. Two hours later, a notification:</p>'
      + '<div class="post"><div class="phead"><span class="pav">IR</span><span class="puser">ilya.rozanov</span></div>'
      + '<img class="pimg" alt="a lake at sunrise" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 4 3%27%3E%3Crect width=%274%27 height=%273%27 fill=%27%231d6e56%27/%3E%3Ctext x=%272%27 y=%271.75%27 font-size=%270.4%27 fill=%27white%27 text-anchor=%27middle%27%3Ephoto%3C/text%3E%3C/svg%3E">'
      + '<img class="pimg" alt="the rink, empty" src="https://i.imgur.com/linkrotted.jpg">'
      + '<div class="pacts"><span>♡</span><span>○</span><span>➤</span></div>'
      + '<div class="plikes">1,247 likes</div>'
      + '<div class="pcap"><b>ilya.rozanov</b> offseason hits different when someone keeps stealing the blanket 🏒</div></div>'
      + '<p>Shane stared at it for a long time, then finally let himself smile.</p>',
  }],
};

export const TRACKED_TAGS = [
  { id: 't1', name: 'Shane Hollander/Ilya Rozanov', kind: 'relationship', count: 47, fresh: 6, palette: 0 },
  { id: 't2', name: 'Hurt/Comfort', kind: 'freeform', count: 31, fresh: 2, palette: 4 },
  { id: 't3', name: 'Slow Burn', kind: 'freeform', count: 28, fresh: 0, palette: 2 },
  { id: 't4', name: 'Heated Rivalry – Rachel Reid', kind: 'fandom', count: 53, fresh: 3, palette: 1 },
  { id: 't5', name: 'Post-Canon', kind: 'freeform', count: 19, fresh: 0, palette: 5 },
  { id: 't6', name: 'Scott Hunter/Kip Grady', kind: 'relationship', count: 22, fresh: 1, palette: 3 },
];

export const SUGGESTIONS = [
  {
    id: 's1', source: 'ao3', title: 'Glove Side, High', author: 'tapewheel',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: "Shane gets traded. Ilya gets a phone number he isn't supposed to use. A long-distance fic told entirely in the spaces between road trips.",
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Long Distance', 'freeform'), T('Slow Burn', 'freeform'), T('Mind the Tags', 'warning')],
    words: 58300, chapters: 12, chaptersTotal: 12, status: 'complete', updated: '6 days ago', palette: 2,
  },
  {
    id: 's2', source: 'ao3', title: 'The Year Without a Cup', author: 'overtime',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: 'An injury fic. The season ends early for one of them, and the other has to decide what winning was ever actually for.',
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Hurt/Comfort', 'freeform'), T('Recovery', 'freeform')],
    words: 39100, chapters: 8, chaptersTotal: 8, status: 'complete', updated: '1 week ago', palette: 7,
  },
  {
    id: 's3', source: 'ao3', title: 'Neutral Zone', author: 'bluelines',
    fandom: 'Heated Rivalry – Rachel Reid', pairing: 'Shane Hollander/Ilya Rozanov',
    summary: 'They agree to be nothing to each other during the playoffs. It lasts exactly one game.',
    tags: [T('Shane Hollander/Ilya Rozanov', 'relationship'), T('Friends With Benefits', 'freeform'), T('Feelings Realization', 'freeform')],
    words: 14700, chapters: 4, chaptersTotal: 6, status: 'ongoing', updated: '2 days ago', palette: 6,
  },
];

export const NEW_CHAPTERS = [
  { id: 'c1', day: 'Today', workId: 'w6', title: 'Power Play', author: 'redline', fandom: 'Heated Rivalry – Rachel Reid', chapter: 'Ch. 3 — Press Box', words: 4100, time: '2h ago', palette: 6, fetched: true, fresh: true },
  { id: 'c2', day: 'Today', workId: 'w1', title: 'The Space Between Periods', author: 'glasswing', fandom: 'Heated Rivalry – Rachel Reid', chapter: 'Ch. 18 — Vermont, July', words: 5200, time: '5h ago', palette: 0, fetched: true, fresh: true },
  { id: 'c3', day: 'Yesterday', workId: 'w1', title: 'The Space Between Periods', author: 'glasswing', fandom: 'Heated Rivalry – Rachel Reid', chapter: 'Ch. 17 — The Long Flight', words: 3900, time: '1d ago', palette: 0, fetched: true },
  { id: 'c4', day: 'This week', workId: 'w3', title: 'Translation Errors', author: 'verbatim', fandom: 'Heated Rivalry – Rachel Reid', chapter: 'Ch. 5 — Epilogue', words: 2600, time: '3d ago', palette: 1, fetched: true },
];

export const NEW_MATCHES = [
  { id: 'm1', day: 'Today', tag: 'Shane Hollander/Ilya Rozanov', title: 'Glove Side, High', author: 'tapewheel', fandom: 'Heated Rivalry – Rachel Reid', summary: 'A long-distance fic told entirely in the spaces between road trips.', words: 58300, status: 'complete', time: '4h ago', palette: 2 },
  { id: 'm2', day: 'Today', tag: 'Hurt/Comfort', title: 'The Year Without a Cup', author: 'overtime', fandom: 'Heated Rivalry – Rachel Reid', summary: 'An injury fic about what winning was ever actually for.', words: 39100, status: 'complete', time: '8h ago', palette: 7 },
  { id: 'm3', day: 'This week', tag: 'Shane Hollander/Ilya Rozanov', title: 'Neutral Zone', author: 'bluelines', fandom: 'Heated Rivalry – Rachel Reid', summary: 'They agree to be nothing to each other during the playoffs.', words: 14700, status: 'ongoing', time: '2d ago', palette: 6 },
];

export const CHAPTERS = [
  { n: 1, title: 'First Period', words: 4200, state: 'done' },
  { n: 2, title: 'Road Game', words: 3800, state: 'done' },
  { n: 3, title: 'A Place to Land', words: 5100, state: 'done' },
  { n: 4, title: 'The Quiet Car', words: 4600, state: 'done' },
  { n: 5, title: 'Overtime', words: 5500, state: 'done' },
  { n: 6, title: 'Three Time Zones', words: 4900, state: 'done' },
  { n: 7, title: 'Hotel Hallways', words: 4100, state: 'done' },
  { n: 8, title: 'A List of Cities', words: 3700, state: 'done' },
  { n: 9, title: 'Trade Deadline', words: 6200, state: 'done' },
  { n: 10, title: 'Static', words: 4400, state: 'done' },
  { n: 11, title: 'The Long Flight', words: 3900, state: 'done' },
  { n: 12, title: 'Glove Side', words: 4800, state: 'done' },
  { n: 13, title: 'Off-Season', words: 5300, state: 'idle' },
  { n: 14, title: 'Vermont, July', words: 5200, state: 'idle' },
  { n: 15, title: 'What the Cameras Missed', words: 4700, state: 'failed' },
  { n: 16, title: 'Loud', words: 4100, state: 'idle' },
  { n: 17, title: 'The Long Way Home', words: 3900, state: 'idle' },
  { n: 18, title: 'Vermont, July', words: 5200, state: 'idle' },
];

export const READER_PARAS = [
  'The arena emptied the way it always did — in a slow tide of noise that thinned to footsteps, then to nothing, until the only sound left was the building cooling around them. Shane sat on the bench long after the lights over the ice had been cut to half, lacing and unlacing the same skate, because leaving meant the night was over and the night being over meant tomorrow.',
  "Across the rink, a door opened and did not close. He didn't look up. He had spent three seasons teaching himself not to look up at exactly that sound, and he was good at it now, the way a person can be good at holding their breath.",
  '"You\'re going to ruin those laces," Ilya said. His voice carried in the empty bowl of the arena, too loud, the way it always was when he forgot to be careful. He never forgot to be careful in front of cameras. It was only here, in the in-between hours, that he let the volume come back.',
  'Shane finally looked up. Ilya was leaning against the boards in his travel suit, tie already gone, collar open, looking like a man who had somewhere better to be and had chosen this instead. He had a hotel key card in his hand. He was turning it over and over between two fingers, and Shane watched it catch the half-light, and understood that this was the question being asked.',
  '"We have a flight," Shane said. It wasn\'t an answer. They both knew it wasn\'t an answer.',
  '"We have four hours," Ilya corrected. "You have a list, yes? Of cities." He smiled, and it was the private one, the one that never made it to television. "Add this one."',
  'There was a list. Shane had never told him about the list, but of course Ilya knew. Ilya knew the shape of every secret Shane kept, because most of them were the same secret wearing different cities like coats. Montreal. Boston. A hotel in Denver with a view of the mountains neither of them had looked at. The places where, for a few hours, no one knew his name well enough to need anything from it.',
  'He stood. His knees complained — twenty-nine felt older in the spring than it had any right to — and he crossed the ice in his shoes, which you were never supposed to do, which was somehow the most reckless thing he had done all season and also the least.',
];
