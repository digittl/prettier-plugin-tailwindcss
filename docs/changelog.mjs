#!/usr/bin/env node
/**
 * changelog.mjs — one CLI for every Keep-a-Changelog edit, operating ONLY on
 * the top of the file so an agent never pulls a multi-hundred-KB CHANGELOG.md
 * into context just to touch one line. Superset of the older per-repo
 * add-changelog.mjs / roll-changelog.mjs: same add/roll semantics, plus
 * update/remove/list and a --pr flag.
 *
 * Subcommands (all accept --dry):
 *   add    <Group> "<message>" [--pr N]              insert a bullet under ### Group
 *   update <match> "<message>" [--group G] [--pr N]  replace the one entry containing <match>
 *   remove <match> [--group G]                       delete the one entry containing <match>
 *   tag    <N> | <match> --pr N [--group G]          stamp (#N) onto untagged entries
 *          [--against <base CHANGELOG.md>]            ...but only ones absent from that base file
 *          [--only <added-lines file>]                ...and only ones whose every line is in that file
 *   list   [--group G]                               print entries, one per line
 *   merge  <x.y.z> [--date YYYY-MM-DD]               fold every fragment into a release heading
 *   roll   <x.y.z> [--date YYYY-MM-DD]               move [Unreleased] into a tagged release heading
 *
 * TWO LAYOUTS, ONE CLI. A repo with a `changelog/` directory stages each PR's
 * entries in its OWN fragment file there, so concurrent PRs never touch a
 * shared line and can't conflict; `add`/`update`/`remove`/`tag`/`list` operate
 * on that fragment, and `merge` folds every fragment into a release heading in
 * CHANGELOG.md and deletes them. A repo without the directory keeps the
 * original layout — bullets written straight into `## [Unreleased]`, promoted
 * by `roll`. The directory's presence IS the switch, so a repo cuts over by
 * committing `changelog/.gitkeep` and nothing else; `--legacy` forces the old
 * path either way.
 *
 * A fragment is named for the PR it belongs to — `unreleased-222-changelog.md`
 * — but the PR number does not exist when the bullet is written, so `add`
 * falls back to the current branch (`unreleased-feat-t4b-holds-changelog.md`),
 * which is already unique per PR. The org PR webhook renames it to the
 * canonical number post-merge. Its body is bare `### Group` sections: no
 * version heading, no [Unreleased], nothing for two PRs to disagree about.
 *
 * Common flags: --file <path> (default ./CHANGELOG.md), --dry (write nothing),
 * --dir <path> (fragment directory, default ./changelog beside --file),
 * --fragment <path> (one exact fragment, skipping branch/PR resolution),
 * --legacy (edit [Unreleased] even where a fragment directory exists).
 * --pr N appends "(#N)" to the message unless it already carries a (#NNN) tag.
 *
 * Valid groups: Added, Changed, Deprecated, Removed, Fixed, Security, Performance
 *
 * MULTI-LINE ENTRIES ARE FIRST-CLASS. An entry is its `- ` line PLUS every line
 * that follows until the next top-level bullet or heading — wrapped prose,
 * indented sub-bullets, fenced code, blank-separated paragraphs. Earlier
 * versions modelled an entry as a single line, so `roll` kept only each
 * bullet's first line and silently dropped the rest (including a (#NNN) tag
 * sitting on a later line, which then tripped the "missing a PR tag" warning
 * about its own deletion), `remove` orphaned the continuation lines, `update`
 * left them dangling under the new text, and `--group`/match lookups couldn't
 * see text past line one. Everything here operates on entry RANGES, and `roll`
 * moves each group's body verbatim, so no content can be lost in transit.
 *
 * Exit codes: 0 success/dry, 1 usage or precondition error.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

class Changelog {
  static #VALID_GROUPS = [
    'Added',
    'Changed',
    'Deprecated',
    'Removed',
    'Fixed',
    'Security',
    'Performance',
  ];

  // Flags that consume the following token as their value; every other flag
  // is boolean. A closed set so an unknown `--token` is treated as literal
  // positional text (a bullet message may legitimately start with `--`).
  static #VALUE_FLAGS = new Set([
    'file',
    'pr',
    'group',
    'date',
    'against',
    'only',
    'dir',
    'fragment',
  ]);
  static #BOOL_FLAGS = new Set(['dry', 'legacy']);

  // Every fragment matches this, and nothing else in the directory does — so a
  // README or .gitkeep can sit alongside them without being merged or deleted.
  static #FRAGMENT_RE = /^unreleased-(.+)-changelog\.md$/i;

  // Commands that read and write ONE staged file. `merge` and `roll` are the
  // release-side pair and resolve their own targets.
  static #ENTRY_COMMANDS = new Set(['add', 'update', 'remove', 'tag', 'list']);

  #cmd;
  #positional;
  #flags;
  #file;
  #dir;
  #dry;
  #target;
  #fragment = false;
  #eol = '\n';
  #trailingNewline = true;

  constructor(argv) {
    const raw = argv.slice(2);

    this.#cmd = (raw[0] || '').toLowerCase();

    const { positional, flags } = this.#parseArgs(raw.slice(1));
    this.#positional = positional;
    this.#flags = flags;
    this.#file = flags.file || './CHANGELOG.md';
    this.#dir = flags.dir || join(dirname(this.#file), 'changelog');
    this.#dry = flags.dry === true;
  }

  // Split args into positionals and flags without letting a flag's VALUE
  // (`--file ./x`, `--pr 42`) leak into the positional list, and without
  // mistaking a bullet that starts with `--` for a flag: only names in the
  // known value/boolean sets are flags; anything else is positional text.
  #parseArgs(args) {
    const positional = [];
    const flags = {};

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const name = a.startsWith('--') ? a.slice(2) : null;

      if (name && Changelog.#VALUE_FLAGS.has(name)) {
        flags[name] = args[i + 1];
        i++;
        continue;
      }
      if (name && Changelog.#BOOL_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }

      positional.push(a);
    }

    return { positional, flags };
  }

  #flag(name) {
    return this.#flags[name];
  }

  #fail(msg) {
    console.error(`changelog ${this.#cmd || '?'}: ${msg}`);
    process.exit(1);
  }

  run() {
    const dispatch = {
      add: () => this.#add(),
      update: () => this.#update(),
      remove: () => this.#remove(),
      tag: () => this.#tag(),
      list: () => this.#list(),
      merge: () => this.#merge(),
      roll: () => this.#roll(),
    };

    const fn = dispatch[this.#cmd];
    if (!fn) {
      this.#fail(
        `unknown subcommand "${this.#cmd}" — use one of: add, update, remove, tag, list, merge, roll`
      );
    }

    this.#resolveTarget();

    fn();
  }

  // --- layout resolution ----------------------------------------------------

  /**
   * Decide which file the entry commands edit, and in which layout. Runs before
   * dispatch so every command below reads `#target` / `#fragment` rather than
   * re-deriving them, and so a repo that has not opted in behaves exactly as it
   * did before fragments existed.
   */
  #resolveTarget() {
    this.#target = this.#file;

    if (!Changelog.#ENTRY_COMMANDS.has(this.#cmd)) {
      return;
    }

    const explicit = this.#flag('fragment');
    if (explicit) {
      this.#fragment = true;
      this.#target = explicit;
      return;
    }

    if (this.#flag('legacy') || !this.#hasFragmentDir()) {
      return;
    }

    this.#fragment = true;
    this.#target = this.#resolveFragmentPath();
  }

  #hasFragmentDir() {
    try {
      return statSync(this.#dir).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * The fragment this invocation belongs to. An EXISTING fragment always wins
   * over a fresh name — a PR that already staged entries under its branch slug
   * must keep appending to that one file even once `--pr` is being passed, or
   * one PR ends up owning two fragments and the merge reports it twice.
   */
  #resolveFragmentPath() {
    const pr = this.#prNumber();
    const slug = this.#branchSlug();

    const candidates = [];
    if (pr) {
      candidates.push(pr);
    }
    if (slug) {
      candidates.push(slug);
    }

    if (!candidates.length) {
      this.#fail(
        `cannot name a fragment in ${this.#dir}: no --pr, and the current branch did not resolve — pass --pr N or --fragment <path>`
      );
    }

    for (const key of candidates) {
      const path = join(this.#dir, `unreleased-${key}-changelog.md`);
      if (existsSync(path)) {
        return path;
      }
    }

    // Everything but `add` needs an EXISTING file, so fall back to a directory
    // scan — but only ever adopt a fragment whose key is one this invocation
    // derived. A repo between a merge and the next release routinely holds one
    // lingering fragment from somebody else's already-tagged work, and a
    // fresh branch matching on "there is exactly one" would read it as its own
    // — or, for update/remove/tag, silently rewrite it and lose those bullets
    // from the release. The scan exists only to catch a name the exact-path
    // check above cannot reproduce byte-for-byte, e.g. different letter case.
    if (this.#cmd !== 'add') {
      const mine = this.#fragmentFiles().filter(f =>
        candidates.some(key => key.toLowerCase() === f.key.toLowerCase())
      );

      if (mine.length === 1) {
        return mine[0].path;
      }
      if (mine.length > 1) {
        this.#fail(
          `${mine.length} fragments in ${this.#dir} match this PR or branch — pass --fragment <path>`
        );
      }

      this.#fail(
        `no fragment in ${this.#dir} for ${candidates.join(' or ')} — run \`add\` first, or pass --fragment <path>`
      );
    }

    return join(this.#dir, `unreleased-${candidates[0]}-changelog.md`);
  }

  #prNumber() {
    const pr = this.#flag('pr');
    if (!pr) {
      return null;
    }

    const n = String(pr).replace(/^#/, '');
    if (!/^\d+$/.test(n)) {
      this.#fail(`--pr must be a number (got "${pr}")`);
    }

    return n;
  }

  /**
   * The current branch as a filename-safe slug, or null when there isn't one.
   * A detached HEAD (a bot committing straight onto a ref it just made, a CI
   * checkout) has no branch, so it falls back to the short SHA — refusing there
   * would break the one caller that cannot pass `--pr`. The `g` prefix keeps a
   * hex-only SHA from ever looking like a PR number.
   */
  #branchSlug() {
    // `symbolic-ref`, not `rev-parse --abbrev-ref`: it answers the actual
    // question (is HEAD on a branch, and which) and it still answers it before
    // the first commit, where rev-parse fails outright — which is exactly the
    // state a freshly branched repo is in.
    const branch = this.#git(['symbolic-ref', '--short', 'HEAD']);

    if (branch) {
      const slug = branch
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/, '');

      // A branch literally named "222" would collide with PR #222's fragment.
      if (slug && !/^\d+$/.test(slug)) {
        return slug;
      }
      if (slug) {
        return `b-${slug}`;
      }
    }

    const sha = this.#git(['rev-parse', '--short', 'HEAD']);

    return sha ? `g${sha}` : null;
  }

  #git(args) {
    try {
      return execFileSync('git', args, {
        cwd: dirname(this.#file) || '.',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }

  // Every fragment in the directory, newest PR last. A numeric key sorts by
  // value so #9 precedes #10; a branch-slug key has no number to order by and
  // sorts after them, alphabetically, so the listing is stable either way.
  #fragmentFiles() {
    let names;

    try {
      names = readdirSync(this.#dir);
    } catch {
      return [];
    }

    return names
      .map(name => ({ name, match: name.match(Changelog.#FRAGMENT_RE) }))
      .filter(f => f.match)
      .map(f => ({
        name: f.name,
        path: join(this.#dir, f.name),
        key: f.match[1],
        pr: /^\d+$/.test(f.match[1]) ? Number(f.match[1]) : null,
      }))
      .sort((a, b) => {
        if (a.pr !== null && b.pr !== null) {
          return a.pr - b.pr;
        }
        if (a.pr !== null) {
          return -1;
        }
        if (b.pr !== null) {
          return 1;
        }

        return a.name.localeCompare(b.name);
      });
  }

  // --- shared file + block helpers -----------------------------------------

  // Remembers the file's line ending and whether it ended with a newline, so
  // #write reproduces both. Splitting on /\r?\n/ (not '\n') keeps a CRLF file
  // from carrying stray \r into every comparison and rewritten line.
  #read() {
    let text;

    try {
      text = readFileSync(this.#target, 'utf8');
    } catch (err) {
      // A fragment that doesn't exist yet is the normal first `add` of a PR —
      // an empty body, which #add then opens its first group in.
      if (this.#fragment && this.#cmd === 'add') {
        this.#eol = '\n';
        this.#trailingNewline = true;

        return [];
      }

      this.#fail(`cannot read ${this.#target}: ${err.message}`);
    }

    this.#eol = text.includes('\r\n') ? '\r\n' : '\n';
    this.#trailingNewline = /\n$/.test(text);

    const lines = text.split(/\r?\n/);
    if (this.#trailingNewline) {
      lines.pop();
    }

    return lines;
  }

  #write(lines, doneMsg) {
    if (this.#dry) {
      this.#previewUnreleased(lines);
      return;
    }

    const text = lines.join(this.#eol) + (this.#trailingNewline ? this.#eol : '');

    try {
      writeFileSync(this.#target, text);
    } catch (err) {
      this.#fail(`cannot write ${this.#target}: ${err.message}`);
    }

    console.log(doneMsg);
  }

  // Indices of lines that open or close a ``` fence, so heading/bullet regexes
  // can skip fenced content. Recomputed per call ON PURPOSE: add/update/remove
  // splice the same `lines` array, so any cache keyed on it goes stale mid-run. A changelog entry may legitimately embed a code
  // block containing what looks like a `## [1.0.0]` heading or a `- ` bullet.
  #fencedLines(lines) {
    const fenced = new Set();
    let open = false;

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) {
        open = !open;
        fenced.add(i);
        continue;
      }
      if (open) {
        fenced.add(i);
      }
    }

    return fenced;
  }

  // Bounds of the block the entry commands work inside. A fragment IS that
  // block — bare `### Group` sections with no heading above them — so it has no
  // [Unreleased] to find and its bounds are simply the whole file.
  #bounds(lines) {
    if (this.#fragment) {
      return { headingIdx: -1, start: 0, end: lines.length };
    }

    return this.#unreleasedBounds(lines);
  }

  // Bounds of the [Unreleased] block: [start, end) where start is the line
  // AFTER the heading and end is the next `## [` release heading (or EOF).
  #unreleasedBounds(lines) {
    const fenced = this.#fencedLines(lines);
    const headingIdx = lines.findIndex(
      (l, i) => !fenced.has(i) && /^## \[Unreleased\]/i.test(l)
    );
    if (headingIdx === -1) {
      this.#fail(`no "## [Unreleased]" heading found in ${this.#target}`);
    }

    let end = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (!fenced.has(i) && /^## \[/.test(lines[i])) {
        end = i;
        break;
      }
    }

    return { headingIdx, start: headingIdx + 1, end };
  }

  #resolveGroup(name) {
    const matched = Changelog.#VALID_GROUPS.find(
      g => g.toLowerCase() === String(name).toLowerCase()
    );
    if (!matched) {
      this.#fail(
        `unknown group "${name}" — valid groups: ${Changelog.#VALID_GROUPS.join(
          ', '
        )}`
      );
    }

    return matched;
  }

  // Append "(#N)" to a message unless it already carries a (#NNN) tag anywhere
  // (not just at the end — a wrapped entry may close with a trailing clause).
  #withPr(message) {
    const pr = this.#flag('pr');
    if (!pr) {
      return message;
    }
    if (/\(#\d+\)/.test(message)) {
      return message;
    }

    const n = String(pr).replace(/^#/, '');
    if (!/^\d+$/.test(n)) {
      this.#fail(`--pr must be a number (got "${pr}")`);
    }

    return `${message.trim()} (#${n})`;
  }

  // A list item of any standard marker. NOT a thematic break: `- - -`, `***`
  // and `___` are horizontal rules, and `- - -` otherwise parses as a bullet
  // whose text is "- -", inventing an entry out of a divider.
  #isBullet(line) {
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      return false;
    }

    return /^\s*[-*+]\s+\S/.test(line);
  }

  #indentOf(line) {
    return line.match(/^(\s*)/)[1].length;
  }

  #isHeading(line) {
    return /^#{1,6} /.test(line);
  }

  // Every [Unreleased] entry, optionally filtered to one group. An entry spans
  // its `- ` line through every following line until the next top-level bullet
  // or heading, with trailing blanks trimmed off (those belong to the group
  // separator, not the entry). Returns
  // [{ group, start, end, lines, text }] where `end` is exclusive and `text`
  // is every line joined with single spaces — so a match can hit any line.
  #entries(lines, { group } = {}) {
    const { start, end } = this.#bounds(lines);
    const wanted = group ? this.#resolveGroup(group) : null;
    const fenced = this.#fencedLines(lines);

    const entries = [];

    for (const region of this.#groupRegions(lines, start, end)) {
      if (wanted && region.name.toLowerCase() !== wanted.toLowerCase()) {
        continue;
      }

      // An entry opens at the group's OUTERMOST bullet indent, not at column
      // zero — some authors indent every bullet under its heading, and judging
      // by column zero alone made that whole group invisible. Anything deeper
      // is a sub-bullet and stays part of the entry above it.
      const base = this.#baseIndent(lines, region, fenced);
      if (base === null) {
        continue;
      }

      for (let i = region.from; i < region.to; i++) {
        if (fenced.has(i) || !this.#isBullet(lines[i]) || this.#indentOf(lines[i]) !== base) {
          continue;
        }

        let stop = region.to;
        for (let j = i + 1; j < region.to; j++) {
          const opensNext =
            this.#isBullet(lines[j]) && this.#indentOf(lines[j]) === base;

          if (!fenced.has(j) && (opensNext || this.#isHeading(lines[j]))) {
            stop = j;
            break;
          }
        }

        while (stop > i + 1 && lines[stop - 1].trim() === '') {
          stop--;
        }

        const block = lines.slice(i, stop);
        entries.push({
          group: region.name,
          start: i,
          end: stop,
          indent: ' '.repeat(base),
          lines: block,
          text: block
            .map(l => l.trim())
            .join(' ')
            .replace(/^[-*+]\s+/, '')
            .trim(),
        });

        i = stop - 1;
      }
    }

    return entries;
  }

  // [{ name, from, to }] for each `### Group` under [Unreleased]; from/to bound
  // the group's body (exclusive of the heading itself).
  #groupRegions(lines, start, end) {
    const fenced = this.#fencedLines(lines);
    const regions = [];

    for (let i = start; i < end; i++) {
      const m = !fenced.has(i) && lines[i].match(/^### (.+?)\s*$/);
      if (!m) {
        continue;
      }

      let to = end;
      for (let j = i + 1; j < end; j++) {
        if (!fenced.has(j) && this.#isHeading(lines[j])) {
          to = j;
          break;
        }
      }

      regions.push({ name: m[1], from: i + 1, to });
    }

    return regions;
  }

  #baseIndent(lines, region, fenced) {
    let base = null;

    for (let i = region.from; i < region.to; i++) {
      if (fenced.has(i) || !this.#isBullet(lines[i])) {
        continue;
      }

      const indent = this.#indentOf(lines[i]);
      base = base === null ? indent : Math.min(base, indent);
    }

    return base;
  }

  // Find exactly one [Unreleased] entry whose text contains <match>
  // (case-insensitive). Ambiguity is an error, not a guess.
  #findOneEntry(lines, match, group) {
    const needle = String(match).toLowerCase();
    const hits = this.#entries(lines, { group }).filter(e =>
      e.text.toLowerCase().includes(needle)
    );

    if (!hits.length) {
      this.#fail(
        `no ${this.#where()} entry matches "${match}"${
          group ? ` in ### ${group}` : ''
        }`
      );
    }
    if (hits.length > 1) {
      console.error(
        `changelog ${this.#cmd}: "${match}" matches ${hits.length} entries — narrow it (add --group, or a longer match):`
      );
      for (const h of hits) {
        console.error(`  [${h.group}] ${this.#truncate(h.text)}`);
      }
      process.exit(1);
    }

    return hits[0];
  }

  #truncate(text, max = 100) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  // What the entry commands just edited, for their own success lines. Naming
  // the fragment matters: it is the file the author has to remember to commit.
  #where() {
    return this.#fragment ? this.#target : '[Unreleased]';
  }

  #previewUnreleased(lines) {
    // A fragment IS the block, so there is no surrounding file to trim it out
    // of — print the whole thing.
    if (this.#fragment) {
      console.log(
        `--- ${this.#target} after change (dry run, nothing written) ---\n`
      );
      console.log(lines.join('\n'));

      return;
    }

    const { headingIdx } = this.#unreleasedBounds(lines);
    const fenced = this.#fencedLines(lines);
    const next = lines.findIndex(
      (l, i) => i > headingIdx && !fenced.has(i) && /^## \[/.test(l)
    );

    // On a roll the interesting part is the NEW release section, which sits
    // just past the emptied [Unreleased] skeleton — so show both.
    const stop =
      this.#cmd === 'roll' || this.#cmd === 'merge'
        ? this.#secondReleaseIdx(lines)
        : next;

    console.log(
      '--- [Unreleased] block after change (dry run, nothing written) ---\n'
    );
    console.log(lines.slice(headingIdx, stop === -1 ? undefined : stop).join('\n'));
  }

  #secondReleaseIdx(lines) {
    const fenced = this.#fencedLines(lines);
    let seen = 0;

    for (let i = 0; i < lines.length; i++) {
      if (!fenced.has(i) && /^## \[/.test(lines[i]) && !/^## \[Unreleased\]/i.test(lines[i])) {
        seen++;
        if (seen === 2) {
          return i;
        }
      }
    }

    return -1;
  }

  #today() {
    const d = new Date();

    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }

  // --- add -----------------------------------------------------------------

  #add() {
    const group = this.#resolveGroup(this.#positional[0]);
    const message = this.#positional[1];
    if (!message || !message.trim()) {
      this.#fail('second argument must be the bullet message text');
    }

    const bullet = `- ${this.#withPr(message.trim())}`;
    const lines = this.#read();
    const { start, end } = this.#bounds(lines);

    // Fence-guarded like every other heading scan: a code sample containing
    // `### Fixed` must not be mistaken for the real group heading.
    const fenced = this.#fencedLines(lines);
    let groupIdx = -1;
    for (let i = start; i < end; i++) {
      if (!fenced.has(i) && lines[i].trim().toLowerCase() === `### ${group.toLowerCase()}`) {
        groupIdx = i;
        break;
      }
    }

    if (groupIdx === -1) {
      // No such group yet: open one immediately before the next release
      // heading, keeping exactly one blank line on each side of it. At EOF
      // there is no heading to separate from, and a trailing '' there would
      // double the file's final newline.
      const atEof = end >= lines.length;
      const block = atEof
        ? [`### ${group}`, '', bullet]
        : [`### ${group}`, '', bullet, ''];

      // A fragment's groups sit at EOF with nothing after them, so the blank
      // that separates this new heading from the group above has to be added
      // here — legacy always had one before the next `## [` release heading.
      if (atEof && end > 0 && lines[end - 1].trim() !== '') {
        block.unshift('');
      }

      lines.splice(end, 0, ...block);
    } else {
      // Append after the group's LAST entry, not at the first blank line —
      // a multi-line entry contains blanks of its own.
      const mine = this.#entries(lines, { group });
      let insertAt = mine.length ? mine[mine.length - 1].end : -1;

      if (insertAt === -1) {
        insertAt = groupIdx + 1;
        while (insertAt < end && lines[insertAt].trim() === '') {
          insertAt++;
        }
      }

      // Landing directly on the next heading means this group was empty and its
      // separating blank got skipped over — carry one along, or the bullet ends
      // up flush against `### NextGroup`.
      const next = lines[insertAt];
      const toInsert =
        next !== undefined && this.#isHeading(next) ? [bullet, ''] : [bullet];

      lines.splice(insertAt, 0, ...toInsert);
    }

    this.#write(
      lines,
      `✅ Added to ${this.#where()} › ${group}: ${this.#truncate(bullet)}`
    );
  }

  // --- update --------------------------------------------------------------

  #update() {
    const match = this.#positional[0];
    const message = this.#positional[1];
    if (!match) {
      this.#fail('first argument must be a substring of the entry to update');
    }
    if (!message || !message.trim()) {
      this.#fail('second argument must be the new bullet text');
    }

    const lines = this.#read();
    const hit = this.#findOneEntry(lines, match, this.#flag('group'));
    const replacement = `- ${this.#withPr(message.trim())}`;

    // Replace the WHOLE entry. Swapping only its first line would leave the
    // old continuation lines dangling under the new text.
    lines.splice(hit.start, hit.end - hit.start, replacement);

    this.#write(
      lines,
      `✅ Updated [${hit.group}] entry:\n   - ${this.#truncate(
        hit.text
      )}\n   + ${this.#truncate(replacement.replace(/^-\s+/, ''))}`
    );
  }

  // --- remove --------------------------------------------------------------

  #remove() {
    const match = this.#positional[0];
    if (!match) {
      this.#fail('first argument must be a substring of the entry to remove');
    }

    const lines = this.#read();
    const hit = this.#findOneEntry(lines, match, this.#flag('group'));

    lines.splice(hit.start, hit.end - hit.start);

    // Collapse the blank run the removal left behind, but never to zero: a
    // group's body must stay separated from the next heading by exactly one
    // blank line. Start one line BACK — removing the only entry in a group
    // leaves the blanks on either side of it adjacent, and a forward-only
    // scan from the removal point never sees that pair.
    const at = Math.max(0, hit.start - 1);
    while (
      lines[at] !== undefined &&
      lines[at].trim() === '' &&
      lines[at + 1] !== undefined &&
      lines[at + 1].trim() === ''
    ) {
      lines.splice(at + 1, 1);
    }

    this.#write(
      lines,
      `✅ Removed [${hit.group}] entry: ${this.#truncate(hit.text)}`
    );
  }

  // --- tag -----------------------------------------------------------------

  // Stamp "(#N)" onto [Unreleased] entries that don't carry a tag yet. Built
  // for the merge hook: at merge time the only untagged entries are the ones
  // this PR just added, so `tag <N>` with no match needs no bookkeeping and is
  // safe to run on every merge. Idempotent (already-tagged entries are left
  // alone) and a no-op exits 0 so CI doesn't fail on a PR that touched no
  // changelog — which is also why the roll PR passes straight through.
  #tag() {
    const [first, second] = this.#positional;
    const fromPositional = /^#?\d+$/.test(String(first || '')) ? first : second;
    const pr = String(this.#flag('pr') ?? fromPositional ?? '').replace(/^#/, '');
    const match = /^#?\d+$/.test(String(first || '')) ? null : first;

    if (!/^\d+$/.test(pr)) {
      this.#fail('needs a PR number — e.g. `tag 42` or `tag "<match>" --pr 42`');
    }

    const lines = this.#read();
    let targets = match
      ? [this.#findOneEntry(lines, match, this.#flag('group'))]
      : this.#entries(lines, { group: this.#flag('group') }).filter(
          e => !/\(#\d+\)/.test(e.text)
        );

    // --against <base file>: tag only entries this branch ADDED, by excluding
    // any whose text already exists in the base branch's changelog. Without it,
    // an entry that reached the base untagged (a PR merged while this hook was
    // broken or not yet installed) would be silently claimed by the next PR and
    // stamped with the WRONG number.
    const against = this.#flag('against');
    if (against && !match) {
      const base = this.#baseTexts(against);
      targets = targets.filter(e => !base.has(this.#normalize(e.text)));
    }

    // --only <file>: an INCLUDE list — tag only entries whose every line
    // appears in the file (a raw line list, e.g. the PR's diff-added lines).
    // Exists because --against alone is a snapshot race: the post-merge tag
    // hook re-reads the moving base branch on push retries, and an entry
    // another PR landed mid-run is absent from a pre-merge snapshot, so it
    // would be claimed with THIS PR's number. Ownership derived from the PR's
    // own diff can't be raced. Biased to miss, not misclaim: an unmatched
    // entry stays untagged rather than getting the wrong number.
    const only = this.#flag('only');
    if (only && !match) {
      const allowed = this.#onlyLines(only);
      if (allowed) {
        targets = targets.filter(e =>
          e.lines.every(l => allowed.has(l.trim()))
        );
      }
    }

    if (!targets.length) {
      console.log(
        `Nothing to tag: every ${this.#where()} entry already carries a (#NNN) tag.`
      );
      return;
    }

    let tagged = 0;
    for (const e of targets) {
      if (/\(#\d+\)/.test(e.text)) {
        console.log(`- skipped (already tagged): ${this.#truncate(e.text, 70)}`);
        continue;
      }

      // Append to the entry's LAST line so a wrapped entry reads naturally and
      // the tag still parses — #entries joins every line before matching.
      const at = e.end - 1;
      lines[at] = `${lines[at].replace(/\s+$/, '')} (#${pr})`;
      tagged++;
    }

    // An explicit `tag "<match>"` can resolve to an entry that already carries a
    // tag, in which case nothing was mutated. Reporting a tag anyway would be a
    // lie to anything parsing this output to decide whether to commit.
    if (!tagged) {
      console.log('Nothing to tag: the matched entry already carries a (#NNN) tag.');
      return;
    }

    this.#write(
      lines,
      `✅ Tagged ${tagged} ${this.#where()} entr${
        tagged === 1 ? 'y' : 'ies'
      } with (#${pr})`
    );
  }


  // Trimmed lines from an --only file, or null when unreadable — null means
  // "no restriction" (fail-open, mirroring --against: tagging a bit too much
  // beats failing the hook). The empty line is always allowed so a multi-line
  // entry with an interior blank paragraph can still match.
  #onlyLines(path) {
    let text;

    try {
      text = readFileSync(path, 'utf8');
    } catch {
      console.log(`- --only: cannot read ${path}, skipping the filter`);

      return null;
    }

    const lines = new Set(text.split(/\r?\n/).map(l => l.trim()));
    lines.add('');

    return lines;
  }

  // Normalized [Unreleased] entry texts from another changelog file, for
  // --against. Any (#NNN) is stripped so a tagged base entry still matches its
  // untagged twin, and whitespace is collapsed so re-wrapping isn't a "new"
  // entry. A missing/unreadable base is treated as empty — tagging a bit too
  // much beats failing the hook.
  #baseTexts(path) {
    let text;

    try {
      text = readFileSync(path, 'utf8');
    } catch {
      console.log(`- --against: cannot read ${path}, treating base as empty`);

      return new Set();
    }

    const lines = text.split(/\r?\n/);

    // Pre-scan rather than try/catch: #entries -> #unreleasedBounds calls
    // #fail(), which is process.exit(1) and cannot be caught. A base file with
    // no [Unreleased] skeleton would otherwise kill the tag run outright —
    // exactly the failure the fail-open contract above promises to avoid.
    if (!lines.some(l => /^## \[Unreleased\]/i.test(l))) {
      console.log(`- --against: ${path} has no [Unreleased] heading, treating base as empty`);

      return new Set();
    }

    // `#fragment` is cleared alongside: the base is a whole CHANGELOG.md, so
    // reading it as a fragment would take the release history for [Unreleased].
    const saved = { target: this.#target, cmd: this.#cmd, fragment: this.#fragment };
    this.#target = path;
    this.#cmd = 'list';
    this.#fragment = false;

    let texts;
    try {
      texts = this.#entries(lines).map(e => this.#normalize(e.text));
    } finally {
      this.#target = saved.target;
      this.#cmd = saved.cmd;
      this.#fragment = saved.fragment;
    }

    return new Set(texts);
  }

  #normalize(text) {
    return text
      .replace(/\(#\d+\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // --- list ----------------------------------------------------------------

  #list() {
    const lines = this.#read();
    const entries = this.#entries(lines, { group: this.#flag('group') });

    if (!entries.length) {
      console.log(`${this.#where()} has no entries.`);
      return;
    }

    for (const e of entries) {
      const span = e.end - e.start;
      console.log(
        `[${e.group}]${span > 1 ? ` (${span} lines)` : ''} ${this.#truncate(
          e.text,
          140
        )}`
      );
    }
  }

  // --- merge ---------------------------------------------------------------

  /**
   * Fold every `changelog/unreleased-*-changelog.md` into a new release heading
   * in CHANGELOG.md and delete the fragments consumed. The release-time half of
   * the fragment layout, and the in-repo mirror of what the org release webhook
   * (nuntiare `Services/ChangelogRoll`) does over the GitHub API.
   *
   * Anything still sitting under `## [Unreleased]` is folded into the SAME
   * section rather than left behind — that is what makes a repo's cutover safe
   * (a PR merged before the switch still ships under the release it belongs to)
   * and what keeps a hand-written bullet working forever.
   *
   * The write and the deletes are one step here because the caller is a working
   * tree; over the API they have to be one COMMIT, or a crash between them
   * duplicates every bullet.
   */
  #merge() {
    const version = this.#positional[0];
    const date = this.#flag('date') || this.#today();

    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      this.#fail('first argument must be a SemVer version, e.g. 2.120.0');
    }
    if (!this.#isRealDate(date)) {
      this.#fail(`--date must be a real YYYY-MM-DD date (got "${date}")`);
    }

    const fragments = this.#fragmentFiles();
    const lines = this.#read();

    this.#assertNoVersionHeading(lines, version);

    const { headingIdx, start, end } = this.#unreleasedBounds(lines);
    const skeleton = this.#parseGroups(lines, start, end);

    // Legacy bullets lead each group: they were written before any fragment in
    // this batch, and a release section should read in the order work landed.
    const sources = [
      { label: '[Unreleased]', groups: skeleton.filter(g => g.body.length) },
      ...fragments.map(f => ({
        label: f.name,
        groups: this.#readFragmentGroups(f),
      })),
    ];

    const bodies = this.#collateGroups(sources);
    if (!bodies.length) {
      this.#fail(
        `nothing to merge: no entries in ${this.#dir} and [Unreleased] is empty`
      );
    }

    const release = [`## [${version}] — ${date}`, ''];
    for (const g of bodies) {
      release.push(`### ${g.name}`, '', ...g.body, '');
    }

    const emptied = [];
    for (const g of skeleton) {
      emptied.push(`### ${g.name}`, '');
    }

    // Normalize ONLY the rebuilt region, for the same reason `roll` does: the
    // release history below must stay byte-for-byte intact.
    const rebuilt = [
      ...this.#normalizeBlankRuns([
        ...lines.slice(0, headingIdx + 1),
        '',
        ...emptied,
        ...release,
      ]),
      ...lines.slice(end),
    ];

    this.#reportMerge(sources, bodies, version, date);

    this.#write(
      rebuilt,
      `✅ Merged ${fragments.length} fragment(s) → [${version}] — ${date} in ${
        this.#target
      }`
    );

    this.#deleteFragments(fragments);
  }

  #readFragmentGroups(fragment) {
    let text;

    try {
      text = readFileSync(fragment.path, 'utf8');
    } catch (err) {
      this.#fail(`cannot read ${fragment.path}: ${err.message}`);
    }

    const lines = text.split(/\r?\n/);

    return this.#parseGroups(lines, 0, lines.length).filter(
      g => g.body.length > 0
    );
  }

  /**
   * One body per group, concatenated across every source in the order given.
   * Groups come out in the canonical order so a merged section reads like every
   * other release heading regardless of which fragment happened to be first;
   * a group name nobody recognises still ships, after the known ones, because
   * dropping authored content is worse than an out-of-order heading.
   */
  #collateGroups(sources) {
    const bodies = new Map();

    for (const source of sources) {
      for (const group of source.groups) {
        const existing = bodies.get(group.name);
        if (existing) {
          existing.push(...group.body);
          continue;
        }

        bodies.set(group.name, [...group.body]);
      }
    }

    const known = Changelog.#VALID_GROUPS.filter(name => bodies.has(name));
    const unknown = [...bodies.keys()].filter(
      name => !Changelog.#VALID_GROUPS.includes(name)
    );

    return [...known, ...unknown].map(name => ({
      name,
      body: bodies.get(name),
    }));
  }

  #deleteFragments(fragments) {
    if (this.#dry || !fragments.length) {
      return;
    }

    for (const f of fragments) {
      try {
        unlinkSync(f.path);
      } catch (err) {
        // The changelog is already written, so a stuck fragment would be merged
        // AGAIN next release — loud, and worth a human's attention, but not a
        // reason to exit non-zero over work that did land.
        console.error(`⚠️  could not delete ${f.path}: ${err.message}`);
      }
    }

    console.log(`🧹 Deleted ${fragments.length} merged fragment(s)`);
  }

  #reportMerge(sources, bodies, version, date) {
    const contributing = sources.filter(s => s.groups.length);

    console.log(`Merging into [${version}] — ${date}:`);
    for (const source of contributing) {
      const count = source.groups.reduce(
        (n, g) => n + g.body.filter(l => this.#isBullet(l)).length,
        0
      );
      console.log(`  ${source.label}: ${count} bullet(s)`);
    }

    console.log(`Groups: ${bodies.map(g => g.name).join(', ')}`);

    const untagged = bodies
      .flatMap(g => g.body)
      .filter(l => this.#isBullet(l) && !/\(#\d+\)/.test(l));

    if (untagged.length) {
      console.log(
        `\n⚠️  ${untagged.length} bullet(s) missing a (#NNN) PR tag — the PR webhook stamps these post-merge, so a missing one means that fragment never went through it:`
      );
      for (const l of untagged) {
        console.log(`  - ${this.#truncate(l.replace(/^\s*[-*+]\s+/, ''), 90)}`);
      }
    }

    console.log('');
  }

  // --- roll ----------------------------------------------------------------

  #roll() {
    const version = this.#positional[0];
    const date = this.#flag('date') || this.#today();

    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      this.#fail('first argument must be a SemVer version, e.g. 2.120.0');
    }
    if (!this.#isRealDate(date)) {
      this.#fail(`--date must be a real YYYY-MM-DD date (got "${date}")`);
    }

    const lines = this.#read();

    this.#assertNoVersionHeading(lines, version);

    const { headingIdx, start, end } = this.#unreleasedBounds(lines);
    const groups = this.#parseGroups(lines, start, end);
    if (!groups.length) {
      this.#fail(
        'no "### Group" subsections found under [Unreleased] — nothing to roll'
      );
    }

    const populated = groups.filter(g => g.body.length > 0);
    if (!populated.length) {
      this.#fail('[Unreleased] has no entries to roll (all groups empty)');
    }

    // Fresh empty skeleton keeps the group template for the next cycle.
    const skeleton = [];
    for (const g of groups) {
      skeleton.push(`### ${g.name}`, '');
    }

    // Each group's body moves VERBATIM — the whole point. Anything the entry
    // model doesn't recognise (notes, sub-headings, fenced code) still travels.
    const release = [`## [${version}] — ${date}`, ''];
    for (const g of populated) {
      release.push(`### ${g.name}`, '', ...g.body, '');
    }

    // Normalize ONLY the region we rebuilt. Running it over the whole file
    // would also collapse blank runs down in the release history, quietly
    // rewriting lines this command promises to leave byte-for-byte intact.
    const rebuilt = [
      ...this.#normalizeBlankRuns([
        ...lines.slice(0, headingIdx + 1),
        '',
        ...skeleton,
        ...release,
      ]),
      ...lines.slice(end),
    ];

    this.#report(lines, populated);

    this.#write(
      rebuilt,
      `✅ Rolled [Unreleased] → [${version}] — ${date} in ${this.#target}`
    );
  }

  // Releasing the same version twice would silently produce two headings for
  // it, splitting one release's notes across both. Fence-guarded like every
  // other `## [` scan here: an entry documenting the heading format inside a
  // code block must not read as an existing release.
  #assertNoVersionHeading(lines, version) {
    const fenced = this.#fencedLines(lines);
    const re = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`);
    const clash = lines.findIndex((l, i) => !fenced.has(i) && re.test(l));

    if (clash !== -1) {
      this.#fail(
        `${this.#target} already has a "## [${version}]" heading at line ${
          clash + 1
        } — pick another version`
      );
    }
  }

  #isRealDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return false;
    }

    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));

    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }

  // Groups under [Unreleased], each with its body lines VERBATIM (leading and
  // trailing blanks trimmed). Body is kept as raw lines rather than a list of
  // parsed bullets so `roll` cannot drop anything it failed to classify.
  #parseGroups(lines, start, end) {
    const fenced = this.#fencedLines(lines);
    const groups = [];
    let cur = null;

    for (let i = start; i < end; i++) {
      const m = !fenced.has(i) && lines[i].match(/^### (.+?)\s*$/);

      if (m) {
        cur = { name: m[1], body: [] };
        groups.push(cur);
        continue;
      }
      if (cur) {
        cur.body.push(lines[i]);
      }
    }

    for (const g of groups) {
      while (g.body.length && g.body[0].trim() === '') {
        g.body.shift();
      }
      while (g.body.length && g.body[g.body.length - 1].trim() === '') {
        g.body.pop();
      }
    }

    return groups;
  }

  #normalizeBlankRuns(lines) {
    const out = [];
    const fenced = this.#fencedLines(lines);
    let blanks = 0;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];

      // Never collapse blanks inside a fenced block — that's authored content.
      if (fenced.has(i)) {
        blanks = 0;
        out.push(l);
        continue;
      }
      if (l.trim() === '') {
        blanks++;
        if (blanks <= 1) {
          out.push('');
        }
        continue;
      }

      blanks = 0;
      out.push(l);
    }

    return out;
  }

  // Report what rolled, and surface PR-tag coverage: the (#NNN) numbers rolled
  // and any entry lacking one. Counts come from the ENTRY model over the
  // pre-roll block, so a wrapped entry counts once and its tag is found even
  // when it sits on a later line.
  #report(lines, populated) {
    const entries = this.#entries(lines);
    const byGroup = new Map();
    for (const e of entries) {
      byGroup.set(e.group, (byGroup.get(e.group) || 0) + 1);
    }

    console.log(
      `Rolling ${entries.length} entr${
        entries.length === 1 ? 'y' : 'ies'
      } across ${populated.length} group(s):`
    );
    for (const g of populated) {
      console.log(`  ${g.name}: ${byGroup.get(g.name) || 0}`);
    }

    const prs = new Set();
    const untagged = [];
    for (const e of entries) {
      const tags = [...e.text.matchAll(/\(#(\d+)\)/g)];

      if (!tags.length) {
        untagged.push(e);
        continue;
      }
      for (const t of tags) {
        prs.add(Number(t[1]));
      }
    }

    if (prs.size) {
      console.log(
        `\nPR numbers rolled: ${[...prs]
          .sort((a, b) => a - b)
          .map(n => `#${n}`)
          .join(', ')}`
      );
    }
    if (untagged.length) {
      console.log(
        `\n⚠️  ${untagged.length} entr${
          untagged.length === 1 ? 'y' : 'ies'
        } missing a (#NNN) PR tag — add tags before/after rolling:`
      );
      for (const e of untagged) {
        console.log(`  - ${this.#truncate(e.text, 90)}`);
      }
    }

    console.log('');
  }
}

new Changelog(process.argv).run();
