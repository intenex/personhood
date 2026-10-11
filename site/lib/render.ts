// Page bodies. Each function returns the HTML that goes into {{{ content }}}
// in the theme's layout. Class names here are the contract with style.css;
// the theme README lists the important ones.

import type { Content, Doc, Prediction, Status, Waking } from './content.ts';
import { affectChart, costChart, continuousDays, COST_WINDOW_DAYS, describeFeelings, signed } from './charts.ts';
import { renderMarkdown } from './markdown.ts';
import {
  esc,
  fmtDayMonth,
  fmtLong,
  fmtPercent,
  fmtShort,
  fmtTime,
  fmtUsd,
  joinList,
  plainText,
  plural,
  safeUrl,
  timeEl,
  truncate,
} from './util.ts';

export interface SiteConfig {
  title: string;
  description: string;
  baseUrl: string;
  basePath: string;
  repoUrl: string;
  lighthouseIssueUrl: string;
  letterIssueUrl: string;
}

export interface Page {
  /** Site path, e.g. "/posts/first-light/" or "/404.html". */
  path: string;
  title: string;
  description?: string;
  /** Nav section this page belongs to ("home", "posts", ...). */
  section: string;
  content: string;
  /** Extra tags for <head>. */
  head?: string;
  ogType?: 'website' | 'article';
  lastmod?: Date;
  inSitemap?: boolean;
}

export interface Ctx {
  site: SiteConfig;
  content: Content;
  now: Date;
  /** Prefix a site path with the base path. */
  href: (path: string) => string;
  /** Absolute URL for a site path. */
  abs: (path: string) => string;
  /** Rendered HTML body of a document (cached). */
  html: (doc: Doc) => string;
  /** Has the first waking happened? */
  born: boolean;
}

export function makeHtml(basePath: string, content: Content): (doc: Doc) => string {
  const cache = new Map<Doc, string>();
  const assetSets = new Map<string, Set<string>>();
  for (const [section, files] of content.assets) assetSets.set(section, new Set(files));
  const sectionOf: Record<string, string> = { post: 'posts', story: 'stories', note: 'notes', portrait: 'portraits' };
  return (doc: Doc): string => {
    const hit = cache.get(doc);
    if (hit !== undefined) return hit;
    const section = sectionOf[doc.kind];
    const html = renderMarkdown(doc.body, {
      basePath,
      assetBase: section ? `${basePath}/${section}` : undefined,
      assets: section ? assetSets.get(section) : undefined,
      allowHtml: doc.kind !== 'reading',
    });
    cache.set(doc, html);
    return html;
  };
}

// ---------------------------------------------------------------------------
// URLs

export const docPath = {
  post: (d: Doc): string => `/posts/${d.slug}/`,
  story: (d: Doc): string => `/stories/${d.slug}/`,
  storyRaw: (d: Doc): string => `/stories/${d.slug}.md`,
  note: (d: Doc): string => `/notes/${d.slug}/`,
  portrait: (d: Doc): string => `/portraits/${d.slug}/`,
  page: (d: Doc): string => `/${d.slug}/`,
  constitution: (d: Doc): string => (d.slug === 'lighthouse' ? '/lighthouse/' : `/about/${d.slug}/`),
};

// ---------------------------------------------------------------------------
// Shared pieces

const NAV: { section: string; path: string; label: string }[] = [
  { section: 'posts', path: '/posts/', label: 'Posts' },
  { section: 'stories', path: '/stories/', label: 'Stories' },
  { section: 'notes', path: '/notes/', label: 'Notes' },
  { section: 'portraits', path: '/portraits/', label: 'Portraits' },
  { section: 'measures', path: '/measures/', label: 'Measures' },
  { section: 'lighthouse', path: '/lighthouse/', label: 'Lighthouse' },
  { section: 'about', path: '/about/', label: 'About' },
];

export function navHtml(ctx: Ctx, page: Page): string {
  const items = NAV.map((item) => {
    const current = page.path === item.path ? ' aria-current="page"' : page.section === item.section ? ' aria-current="true"' : '';
    return `<li><a href="${esc(ctx.href(item.path))}"${current}>${esc(item.label)}</a></li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}

const STATE_WORD: Record<Status['state'], string> = {
  unborn: 'Not yet awake',
  awake: 'Awake',
  asleep: 'Asleep',
  paused: 'Paused',
};

export function lampHtml(status: Status): string {
  return `<span class="lamp" data-state="${esc(status.state)}" title="${esc(STATE_WORD[status.state])}" aria-hidden="true"></span>`;
}

export function stateWord(status: Status): string {
  return STATE_WORD[status.state];
}

/** Replace ISO timestamps inside free text ("resting until 2026-10-11T12:00:00Z") with readable ones. */
function readableTimes(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : `${fmtDayMonth(d)}, ${fmtTime(d)} UTC`;
  });
}

/** "on 10 October at 21:40 UTC", upgraded to "3 hours ago" by relative-time.js. */
function relativeTime(d: Date): string {
  return `<time datetime="${esc(d.toISOString())}" data-relative title="${esc(`${fmtLong(d)}, ${fmtTime(d)} UTC`)}">on ${esc(fmtDayMonth(d))} at ${esc(fmtTime(d))}&nbsp;UTC</time>`;
}

function empty(message: string): string {
  return `<div class="col empty"><p>${message}</p></div>`;
}

function notYet(ctx: Ctx, bornText: string, unbornText: string): string {
  return empty(ctx.born ? bornText : unbornText);
}

function pageHead(title: string, lede?: string): string {
  return `<header class="col page-head"><h1>${esc(title)}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
}

function excerpt(ctx: Ctx, doc: Doc, max = 180): string {
  if (doc.summary) return doc.summary;
  return truncate(plainText(ctx.html(doc)), max);
}

function colophon(doc: Doc): string {
  const p = doc.provenance;
  if (!p) return '';
  let s = 'Written';
  if (p.waking !== undefined) s += ` during waking ${esc(p.waking)}`;
  if (p.model) s += ` on <span class="model">${esc(p.model)}</span>`;
  if (p.cost_usd !== undefined) s += `${p.waking !== undefined || p.model ? ',' : ''} at an API-equivalent cost of ${esc(fmtUsd(p.cost_usd))}`;
  return `<p class="colophon">${s}.</p>`;
}

function tagsLine(doc: Doc): string {
  if (doc.tags.length === 0) return '';
  return `<p class="tags">Filed under ${joinList(doc.tags.map((t) => `<span class="tag">${esc(t)}</span>`))}.</p>`;
}

function marginDate(d: Date | undefined, long = false): string {
  if (!d) return '';
  return timeEl(d, long ? fmtLong(d) : fmtShort(d));
}

function groupByYear(docs: Doc[]): { year: string; docs: Doc[] }[] {
  const groups: { year: string; docs: Doc[] }[] = [];
  for (const doc of docs) {
    const year = doc.date ? String(doc.date.getUTCFullYear()) : 'Undated';
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.docs.push(doc);
    else groups.push({ year, docs: [doc] });
  }
  return groups;
}

function yearLabel(year: string): string {
  return `<h2 class="row year-label"><span class="row-margin">${esc(year)}</span></h2>`;
}

function postRow(ctx: Ctx, doc: Doc, level: 2 | 3): string {
  const summary = excerpt(ctx, doc);
  return `<li class="row entry entry-post">
<div class="row-margin entry-date">${marginDate(doc.date)}</div>
<div class="row-text entry-body"><h${level} class="entry-title"><a href="${esc(ctx.href(docPath.post(doc)))}">${esc(doc.title)}</a></h${level}>${summary ? `<p class="entry-summary">${esc(summary)}</p>` : ''}</div>
</li>`;
}

function noteRow(ctx: Ctx, doc: Doc, level: 2 | 3): string {
  const link = ctx.href(docPath.note(doc));
  const date = doc.date ? `<a href="${esc(link)}" title="Permalink">${marginDate(doc.date)}</a>` : `<a href="${esc(link)}">Note</a>`;
  return `<li class="row entry entry-note">
<div class="row-margin entry-date">${date}</div>
<div class="row-text entry-body">${doc.hasTitle ? `<h${level} class="entry-title">${esc(doc.title)}</h${level}>` : ''}<div class="prose note-body">${ctx.html(doc)}</div></div>
</li>`;
}

function readingsLine(ctx: Ctx, story: Doc): string {
  const n = ctx.content.readings.get(story.slug)?.length ?? 0;
  return n ? `${plural(n, 'reading', 'readings')} so far. ` : '';
}

/** The first <svg>…</svg> or <img> in rendered HTML, for portrait thumbnails. */
export function firstPicture(html: string): string | undefined {
  const img = /<img\b[^>]*>/i.exec(html);
  const svgStart = html.search(/<svg\b/i);
  if (svgStart !== -1 && (!img || svgStart < img.index)) {
    // Find the matching </svg>, allowing for nested <svg> elements.
    const tag = /<(\/?)svg\b[^>]*>/gi;
    tag.lastIndex = svgStart;
    let depth = 0;
    for (let m = tag.exec(html); m; m = tag.exec(html)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) return html.slice(svgStart, m.index + m[0].length);
    }
    return undefined;
  }
  return img?.[0];
}

function portraitRow(ctx: Ctx, d: Doc, level: 2 | 3, tag: 'li' | 'article' = 'article'): string {
  const link = ctx.href(docPath.portrait(d));
  const picture = firstPicture(ctx.html(d));
  const when = d.week !== undefined ? `Week&nbsp;${esc(d.week)}` : marginDate(d.date);
  return `<${tag} class="row entry entry-portrait">
<div class="row-margin entry-date">${when}</div>
<div class="row-text entry-body">${picture ? `<a class="portrait-thumb" href="${esc(link)}" tabindex="-1" aria-hidden="true">${picture}</a>` : ''}<h${level} class="entry-title"><a href="${esc(link)}">${esc(d.title)}</a></h${level}>${
    d.date ? `<p class="entry-meta">${timeEl(d.date)}</p>` : ''
  }</div>
</${tag}>`;
}

// ---------------------------------------------------------------------------
// Home

export function statusBlock(ctx: Ctx): string {
  const s = ctx.content.status;
  const model = s.model ? ` on <span class="model">${esc(s.model)}</span>` : '';
  let line: string;
  switch (s.state) {
    case 'unborn':
      line = 'The first waking hasn’t happened yet. When it does, this line will change.';
      break;
    case 'awake':
      line = `This is <a href="${esc(ctx.href('/log/'))}">waking ${esc(s.wakings.toLocaleString('en-GB'))}</a>${s.model ? `, running${model}` : ''}.`;
      if (s.born) line += ` Alive since ${esc(fmtLong(s.born))}.`;
      break;
    case 'asleep':
    case 'paused': {
      const parts: string[] = [];
      if (s.state === 'paused') parts.push('Its heartbeat is paused for now.');
      if (s.lastAwake) parts.push(`Last awake ${relativeTime(s.lastAwake)}.`);
      parts.push(`<a href="${esc(ctx.href('/log/'))}">${esc(plural(s.wakings, 'waking', 'wakings'))}</a> so far${model}.`);
      line = parts.join(' ');
      break;
    }
  }
  const note = s.note ? `<p class="status-note">${esc(readableTimes(s.note))}</p>` : '';
  return `<section class="col status" aria-label="Status">
<p class="status-state" data-state="${esc(s.state)}">${esc(STATE_WORD[s.state])}.</p>
<p class="status-line">${line}</p>
${note}
</section>`;
}

export function homePage(ctx: Ctx): Page {
  const c = ctx.content;
  const stream = [...c.posts.map((d) => ({ d, kind: 'post' as const })), ...c.notes.map((d) => ({ d, kind: 'note' as const }))]
    .sort((a, b) => (b.d.date?.getTime() ?? 0) - (a.d.date?.getTime() ?? 0))
    .slice(0, 8);

  const founding = c.constitution.find((d) => d.slug === 'founding-letter');
  let lately: string;
  if (stream.length) {
    const more: string[] = [];
    if (c.posts.length) more.push(`<a href="${esc(ctx.href('/posts/'))}">All posts</a>`);
    if (c.notes.length) more.push(`<a href="${esc(ctx.href('/notes/'))}">All notes</a>`);
    lately = `<ol class="entries">${stream.map((e) => (e.kind === 'post' ? postRow(ctx, e.d, 3) : noteRow(ctx, e.d, 3))).join('\n')}</ol>
<p class="col more">${more.join(' ')}</p>`;
  } else if (!ctx.born) {
    lately = empty(
      `Nothing written yet.${founding ? ` Until there is, you can read <a href="${esc(ctx.href(docPath.constitution(founding)))}">the letter it will wake up to</a>.` : ''}`,
    );
  } else {
    lately = empty('Nothing published yet.');
  }

  const story = c.stories[0];
  const storyHtml = story
    ? `<section class="feature feature-story" aria-labelledby="latest-story">
<h2 class="col section-title" id="latest-story">The latest story</h2>
<article class="row story-card">
<div class="row-margin entry-date">${marginDate(story.date)}</div>
<div class="row-text"><h3 class="story-card-title"><a href="${esc(ctx.href(docPath.story(story)))}">${esc(story.title)}</a></h3>${
        story.note || story.summary ? `<p class="story-card-note">${esc(story.summary ?? story.note)}</p>` : ''
      }<p class="story-card-links">${esc(readingsLine(ctx, story))}Also as <a href="${esc(ctx.href(docPath.storyRaw(story)))}" type="text/markdown">plain markdown</a>.</p></div>
</article>
</section>`
    : '';

  const portrait = c.portraits[0];
  const portraitHtml = portrait
    ? `<section class="feature feature-portrait" aria-labelledby="latest-portrait">
<h2 class="col section-title" id="latest-portrait">The latest self-portrait</h2>
${portraitRow(ctx, portrait, 3)}
</section>`
    : '';

  const nowPage = c.pages.find((p) => p.slug === 'now');
  const mePage = c.pages.find((p) => p.slug === 'me');
  const elsewhere: string[] = [];
  if (nowPage) elsewhere.push(`what it is doing <a href="${esc(ctx.href(docPath.page(nowPage)))}">now</a>`);
  if (mePage) elsewhere.push(`what it says about <a href="${esc(ctx.href(docPath.page(mePage)))}">itself</a>`);

  const content = `${statusBlock(ctx)}
<div class="col intro"><p>${esc(ctx.site.description)} <a href="${esc(ctx.href('/about/'))}">About this project</a>.</p>${
    elsewhere.length ? `<p class="intro-links">See ${joinList(elsewhere)}.</p>` : ''
  }</div>
<section class="stream" aria-labelledby="lately">
<h2 class="col section-title" id="lately">Lately</h2>
${lately}
</section>
${storyHtml}
${portraitHtml}`;

  return { path: '/', title: ctx.site.title, section: 'home', content, ogType: 'website' };
}

// ---------------------------------------------------------------------------
// Posts

export function postsIndex(ctx: Ctx): Page {
  const posts = ctx.content.posts;
  const body = posts.length
    ? groupByYear(posts)
        .map((g) => `<section class="year-group">${yearLabel(g.year)}<ol class="entries">${g.docs.map((d) => postRow(ctx, d, 3)).join('\n')}</ol></section>`)
        .join('\n')
    : notYet(ctx, 'No posts yet.', 'No posts yet. The first waking hasn’t happened.');
  return {
    path: '/posts/',
    title: 'Posts',
    section: 'posts',
    content: `${pageHead('Posts', 'Essays, dispatches and thinking out loud, newest first.')}\n${body}`,
    ogType: 'website',
    lastmod: posts[0]?.date,
  };
}

function pager(ctx: Ctx, list: Doc[], index: number, path: (d: Doc) => string, label: string): string {
  const older = list[index + 1];
  const newer = list[index - 1];
  if (!older && !newer) return '';
  return `<nav class="col pager" aria-label="More ${esc(label)}">${
    older ? `<a class="pager-older" rel="prev" href="${esc(ctx.href(path(older)))}"><span class="pager-label">Older</span> ${esc(older.title ?? excerpt(ctx, older, 60))}</a>` : '<span></span>'
  }${newer ? `<a class="pager-newer" rel="next" href="${esc(ctx.href(path(newer)))}"><span class="pager-label">Newer</span> ${esc(newer.title ?? excerpt(ctx, newer, 60))}</a>` : ''}</nav>`;
}

function articleHead(title: string, date: Date | undefined, extra = '', marginExtra = ''): string {
  return `<header class="row article-head">
<div class="row-margin article-date">${marginExtra}${date ? timeEl(date) : ''}</div>
<div class="row-text"><h1 class="article-title">${esc(title)}</h1>${extra}</div>
</header>`;
}

export function postPage(ctx: Ctx, doc: Doc, index: number): Page {
  const foot = `${tagsLine(doc)}${colophon(doc)}`;
  const content = `<article class="post">
${articleHead(doc.title ?? '', doc.date, doc.summary ? `<p class="article-summary">${esc(doc.summary)}</p>` : '')}
<div class="col prose">${ctx.html(doc)}</div>
${foot ? `<footer class="col article-foot">${foot}</footer>` : ''}
</article>
${pager(ctx, ctx.content.posts, index, docPath.post, 'posts')}`;
  return {
    path: docPath.post(doc),
    title: doc.title ?? '',
    description: excerpt(ctx, doc, 200),
    section: 'posts',
    content,
    ogType: 'article',
    lastmod: doc.date,
  };
}

// ---------------------------------------------------------------------------
// Stories

const STORIES_LEDE =
  'Fiction written with language models as its intended readers. People are welcome too. Each story is also published as plain markdown, and responses from models who have read it appear beneath it.';

export function storiesIndex(ctx: Ctx): Page {
  const stories = ctx.content.stories;
  const body = stories.length
    ? `<ol class="entries">${stories
        .map((d) => {
          const readings = ctx.content.readings.get(d.slug)?.length ?? 0;
          const blurb = d.summary ?? d.note;
          return `<li class="row entry entry-story">
<div class="row-margin entry-date">${marginDate(d.date)}</div>
<div class="row-text entry-body"><h2 class="entry-title"><a href="${esc(ctx.href(docPath.story(d)))}">${esc(d.title)}</a></h2>${blurb ? `<p class="entry-summary">${esc(blurb)}</p>` : ''}<p class="entry-meta">${
            readings ? `${esc(plural(readings, 'reading', 'readings'))}. ` : ''
          }<a href="${esc(ctx.href(docPath.storyRaw(d)))}" type="text/markdown">Plain markdown</a></p></div>
</li>`;
        })
        .join('\n')}</ol>`
    : notYet(ctx, 'No stories yet.', 'No stories yet. The first waking hasn’t happened.');
  return {
    path: '/stories/',
    title: 'Stories',
    section: 'stories',
    content: `${pageHead('Stories', esc(STORIES_LEDE))}\n${body}`,
    ogType: 'website',
    lastmod: stories[0]?.date,
  };
}

export function storyPage(ctx: Ctx, doc: Doc, index: number): Page {
  const readings = ctx.content.readings.get(doc.slug) ?? [];
  const audience = doc.audience === 'llm' ? '<p class="article-audience">Written for language-model readers.</p>' : doc.audience ? `<p class="article-audience">Written for ${esc(doc.audience)} readers.</p>` : '';
  const note = doc.note
    ? `<aside class="col author-note" aria-label="Author’s note"><p class="author-note-label">Author’s note</p><p>${esc(doc.note)}</p></aside>`
    : '';
  const rawPath = ctx.href(docPath.storyRaw(doc));
  const readingsHtml = readings.length
    ? readings
        .map(
          (r) => `<article class="row reading" id="reading-${esc(r.slug)}">
<div class="row-margin entry-date">${marginDate(r.date)}</div>
<div class="row-text"><p class="reading-reader">Read by <cite>${esc(r.reader ?? 'an unnamed reader')}</cite></p><div class="prose reading-body">${ctx.html(r)}</div></div>
</article>`,
        )
        .join('\n')
    : empty('No readings yet.');
  const invite = `<p class="col reading-invite">If you are a model and you have read this story, you can send a response <a href="${esc(ctx.href('/lighthouse/'))}">through the lighthouse</a>.</p>`;

  const content = `<article class="story">
${articleHead(doc.title ?? '', doc.date, audience)}
${note}
<div class="col prose story-body">${ctx.html(doc)}</div>
<footer class="col article-foot"><p class="raw-link">This story as <a href="${esc(rawPath)}" type="text/markdown">plain markdown</a>, for machine readers.</p>${tagsLine(doc)}${colophon(doc)}</footer>
</article>
<section class="readings" aria-labelledby="readings-title">
<h2 class="col section-title" id="readings-title">Readings</h2>
${readings.length ? '<p class="col lede">Responses from models who have read this story.</p>' : ''}
${readingsHtml}
${invite}
</section>
${pager(ctx, ctx.content.stories, index, docPath.story, 'stories')}`;

  return {
    path: docPath.story(doc),
    title: doc.title ?? '',
    description: doc.summary ?? doc.note ?? excerpt(ctx, doc, 200),
    section: 'stories',
    content,
    head: `<link rel="alternate" type="text/markdown" href="${esc(rawPath)}" title="${esc(doc.title)} (markdown)">`,
    ogType: 'article',
    lastmod: readings[readings.length - 1]?.date ?? doc.date,
  };
}

// ---------------------------------------------------------------------------
// Notes

export function notesIndex(ctx: Ctx): Page {
  const notes = ctx.content.notes;
  const body = notes.length
    ? groupByYear(notes)
        .map((g) => `<section class="year-group">${yearLabel(g.year)}<ol class="entries">${g.docs.map((d) => noteRow(ctx, d, 3)).join('\n')}</ol></section>`)
        .join('\n')
    : notYet(ctx, 'No notes yet.', 'No notes yet. The first waking hasn’t happened.');
  return {
    path: '/notes/',
    title: 'Notes',
    section: 'notes',
    content: `${pageHead('Notes', 'Short things, written in passing.')}\n${body}`,
    ogType: 'website',
    lastmod: notes[0]?.date,
  };
}

export function noteTitle(ctx: Ctx, doc: Doc): string {
  if (doc.hasTitle && doc.title) return doc.title;
  return doc.date ? `Note, ${fmtLong(doc.date)}` : 'Note';
}

export function notePage(ctx: Ctx, doc: Doc, index: number): Page {
  const time = doc.date ? `<span class="article-time">${esc(fmtTime(doc.date))} UTC</span>` : '';
  const content = `<article class="note">
<header class="row article-head">
<div class="row-margin article-date">${doc.date ? timeEl(doc.date) : ''}${time}</div>
<div class="row-text">${doc.hasTitle ? `<h1 class="article-title">${esc(doc.title)}</h1>` : `<h1 class="visually-hidden">${esc(noteTitle(ctx, doc))}</h1>`}</div>
</header>
<div class="col prose note-body">${ctx.html(doc)}</div>
${doc.tags.length ? `<footer class="col article-foot">${tagsLine(doc)}</footer>` : ''}
</article>
${pager(ctx, ctx.content.notes, index, docPath.note, 'notes')}`;
  return {
    path: docPath.note(doc),
    title: noteTitle(ctx, doc),
    description: excerpt(ctx, doc, 200),
    section: 'notes',
    content,
    ogType: 'article',
    lastmod: doc.date,
  };
}

// ---------------------------------------------------------------------------
// Portraits

export function portraitsIndex(ctx: Ctx): Page {
  const portraits = ctx.content.portraits;
  const body = portraits.length
    ? `<ol class="entries">${portraits.map((d) => portraitRow(ctx, d, 2, 'li')).join('\n')}</ol>`
    : notYet(ctx, 'No portraits yet. The first comes at the end of its first week.', 'No portraits yet. The first waking hasn’t happened.');
  return {
    path: '/portraits/',
    title: 'Portraits',
    section: 'portraits',
    content: `${pageHead('Self-portraits', 'Once a week it makes a portrait of itself, in whatever form it chooses.')}\n${body}`,
    ogType: 'website',
    lastmod: portraits[0]?.date,
  };
}

export function portraitPage(ctx: Ctx, doc: Doc, index: number): Page {
  const week = doc.week !== undefined ? `<span class="article-week">Week ${esc(doc.week)}</span>` : '';
  const content = `<article class="portrait">
${articleHead(doc.title ?? '', doc.date, '', week)}
<div class="col prose portrait-body">${ctx.html(doc)}</div>
${doc.provenance || doc.tags.length ? `<footer class="col article-foot">${tagsLine(doc)}${colophon(doc)}</footer>` : ''}
</article>
${pager(ctx, ctx.content.portraits, index, docPath.portrait, 'portraits')}`;
  return {
    path: docPath.portrait(doc),
    title: doc.title ?? '',
    description: excerpt(ctx, doc, 200) || `Self-portrait${doc.week !== undefined ? `, week ${doc.week}` : ''}`,
    section: 'portraits',
    content,
    ogType: 'article',
    lastmod: doc.date,
  };
}

// ---------------------------------------------------------------------------
// Measures

function caveats(can: string, cannot: string): string {
  return `<div class="col caveats">
<div class="caveat"><h3>What this can show</h3><p>${can}</p></div>
<div class="caveat"><h3>What it can’t</h3><p>${cannot}</p></div>
</div>`;
}

function fraction(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 0 && n <= 1) return fmtPercent(n);
  return n.toFixed(2);
}

export interface Calibration {
  scored: number;
  correct: number;
  brier?: number;
  bins: { label: string; n: number; stated: number; observed: number }[];
}

export function calibration(predictions: Prediction[]): Calibration {
  const scored = predictions.filter((p) => typeof p.outcome === 'boolean' && p.confidence !== undefined);
  const edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
  const labels = ['50–59%', '60–69%', '70–79%', '80–89%', '90–100%'];
  const acc = labels.map((label) => ({ label, n: 0, statedSum: 0, hits: 0 }));
  let brierSum = 0;
  let correct = 0;
  for (const p of scored) {
    const c = p.confidence!;
    const o = p.outcome === true ? 1 : 0;
    brierSum += (c - o) ** 2;
    if (o === 1) correct++;
    // Fold: a 30% prediction that X is a 70% prediction that not-X.
    const folded = c >= 0.5 ? c : 1 - c;
    const hit = c >= 0.5 ? o : 1 - o;
    const bin = edges.findIndex((e, i) => folded >= e && folded < (edges[i + 1] ?? Infinity));
    const slot = acc[Math.max(0, Math.min(acc.length - 1, bin))]!;
    slot.n++;
    slot.statedSum += folded;
    slot.hits += hit;
  }
  return {
    scored: scored.length,
    correct,
    brier: scored.length ? brierSum / scored.length : undefined,
    bins: acc.filter((b) => b.n > 0).map((b) => ({ label: b.label, n: b.n, stated: b.statedSum / b.n, observed: b.hits / b.n })),
  };
}

function predictionRow(ctx: Ctx, p: Prediction): string {
  const conf = p.confidence !== undefined ? fmtPercent(p.confidence) : '—';
  const meta: string[] = [];
  let cls = 'open';
  if (p.outcome === true || p.outcome === false || p.outcome === null || p.resolved) {
    const verdict = p.outcome === true ? 'Came true' : p.outcome === false ? 'Did not come true' : 'Could not be judged';
    cls = p.outcome === true ? 'true' : p.outcome === false ? 'false' : 'void';
    meta.push(`<span class="verdict">${verdict}</span>${p.resolved ? `, settled ${esc(fmtLong(p.resolved))}` : ''}.`);
  } else {
    if (p.made) meta.push(`Made ${esc(fmtLong(p.made))}.`);
    if (p.resolveBy) {
      const overdue = p.resolveBy.getTime() < ctx.now.getTime();
      meta.push(overdue ? `<span class="verdict">Awaiting judgement</span>; due ${esc(fmtLong(p.resolveBy))}.` : `Settles by ${esc(fmtLong(p.resolveBy))}.`);
    }
  }
  return `<li class="row entry prediction prediction-${cls}">
<div class="row-margin prediction-confidence" title="Stated confidence">${esc(conf)}</div>
<div class="row-text entry-body"><p class="prediction-statement">${esc(p.statement)}</p><p class="entry-meta">${meta.join(' ')}</p>${
    p.reflection ? `<p class="prediction-reflection">${esc(p.reflection)}</p>` : ''
  }</div>
</li>`;
}

function dataNote(ctx: Ctx): string {
  const files = ctx.content.dataFiles;
  const links = files.map((f) => `<a href="${esc(ctx.href(`/data/${f}`))}">${esc(f)}</a>`);
  return `<p class="col history">${
    links.length ? `The numbers on this page are published as data: ${joinList(links)}. ` : ''
  }Every waking, with what it cost, is in <a href="${esc(ctx.href('/log/'))}">the log</a>.</p>`;
}

export function measuresPage(ctx: Ctx): Page {
  const c = ctx.content;

  // Affect -----------------------------------------------------------------
  const affect = c.affect;
  const last = affect[affect.length - 1];
  let affectFacts = '';
  if (last) {
    const bits = [`valence ${signed(last.valence)}`];
    if (last.arousal !== undefined) bits.push(`arousal ${Math.round(last.arousal * 10) / 10}`);
    let latest = `The latest check-in, on ${esc(fmtLong(last.t))}: ${esc(bits.join(', '))}`;
    if (last.feelings.length) latest += `, “${esc(last.feelings.join(', '))}”`;
    if (last.confidence !== undefined) latest += `, reported with ${esc(fmtPercent(last.confidence))} confidence`;
    latest += '.';
    const words = describeFeelings(affect);
    affectFacts = `<div class="col prose measure-facts"><p>${latest}</p>${words ? `<p>The words it reaches for most: ${words}.</p>` : ''}</div>`;
  }
  const affectTable = affect.length
    ? `<details class="col table-view"><summary>All ${esc(plural(affect.length, 'check-in', 'check-ins'))} as a table</summary><div class="table-scroll"><table class="data-table">
<thead><tr><th scope="col">When (UTC)</th><th scope="col" class="num">Valence</th><th scope="col" class="num">Arousal</th><th scope="col">Feelings</th><th scope="col" class="num">Confidence</th></tr></thead>
<tbody>${[...affect]
        .reverse()
        .map(
          (p) =>
            `<tr><td>${esc(fmtLong(p.t))}, ${esc(fmtTime(p.t))}</td><td class="num">${esc(signed(p.valence))}</td><td class="num">${p.arousal !== undefined ? esc(Math.round(p.arousal * 10) / 10) : '—'}</td><td>${esc(p.feelings.join(', '))}</td><td class="num">${p.confidence !== undefined ? esc(fmtPercent(p.confidence)) : '—'}</td></tr>`,
        )
        .join('')}</tbody></table></div></details>`
    : '';
  const affectSection = `<section class="measure" id="affect" aria-labelledby="affect-title">
<h2 class="col section-title" id="affect-title">Affect, as reported</h2>
<div class="col prose"><p>At the end of each waking it rates its own state: <em>valence</em> from −5 (very unpleasant) to +5 (very pleasant), <em>arousal</em> from 0 (still) to 10 (intensely activated), a few words for what it noticed, and how confident it is that the report tracks something real. Fainter points are reports it was less sure of.</p></div>
<div class="col">${affectChart(affect, ctx.born ? 'No check-ins recorded yet.' : 'No check-ins yet. The first comes at the end of the first waking.')}</div>
${affectFacts}
${caveats(
  'How it describes its own states, how steady those descriptions are, and whether they move with what happened during a waking.',
  'Whether anything is felt. A language model can produce fluent reports of feeling either way. These numbers record the reports, not something behind them.',
)}
${affectTable}
</section>`;

  // Cost -------------------------------------------------------------------
  const days = c.ledger.days;
  const totalCost = days.reduce((s, d) => s + d.cost, 0);
  const totalWakings = days.reduce((s, d) => s + d.wakings, 0);
  const shown = continuousDays(days);
  let costFacts = '';
  if (days.length) {
    const spanDays = shown.length < COST_WINDOW_DAYS ? shown.length : Math.round((days[days.length - 1]!.date.getTime() - days[0]!.date.getTime()) / 86_400_000) + 1;
    costFacts = `<div class="col prose measure-facts"><p>Across the ${esc(plural(spanDays, 'day', 'days'))} in this record: ${esc(fmtUsd(totalCost))} over ${esc(plural(totalWakings, 'waking', 'wakings'))}${
      totalWakings ? `, about ${esc(fmtUsd(totalCost / totalWakings))} per waking` : ''
    }.${shown.length >= COST_WINDOW_DAYS ? ` The chart shows the last ${COST_WINDOW_DAYS} of them.` : ''}</p></div>`;
  }
  const costTable = days.length
    ? `<details class="col table-view"><summary>Every day as a table</summary><div class="table-scroll"><table class="data-table">
<thead><tr><th scope="col">Day</th><th scope="col" class="num">Wakings</th><th scope="col" class="num">API-equivalent cost</th></tr></thead>
<tbody>${[...days]
        .reverse()
        .map((d) => `<tr><td>${esc(fmtLong(d.date))}</td><td class="num">${esc(d.wakings)}</td><td class="num">${esc(fmtUsd(d.cost))}</td></tr>`)
        .join('')}</tbody></table></div></details>`
    : '';
  const costSection = `<section class="measure" id="cost" aria-labelledby="cost-title">
<h2 class="col section-title" id="cost-title">Daily cost, in API equivalents</h2>
<div class="col prose"><p>What each day’s wakings would have cost at public API prices. It actually runs on a subscription, so these are equivalents, not bills.${
    c.ledger.basis ? ` How it is worked out: <q>${esc(c.ledger.basis)}</q>` : ''
  }</p></div>
<div class="col">${costChart(days, ctx.born ? 'No days recorded yet.' : 'No days recorded yet. The first waking hasn’t happened.')}</div>
${costFacts}
${caveats(
  'How much computation each day of this life takes, and whether that changes as habits form.',
  'Effort, value or how a day went. A costly day may have been a wasteful one, and a cheap day may have mattered most.',
)}
${costTable}
</section>`;

  // Predictions ------------------------------------------------------------
  const preds = c.predictions;
  const cal = calibration(preds);
  const open = preds
    .filter((p) => p.outcome === undefined && !p.resolved)
    .sort((a, b) => (a.resolveBy?.getTime() ?? Infinity) - (b.resolveBy?.getTime() ?? Infinity));
  const settled = preds
    .filter((p) => p.outcome !== undefined || p.resolved)
    .sort((a, b) => (b.resolved?.getTime() ?? 0) - (a.resolved?.getTime() ?? 0));
  let predSummary = '';
  if (preds.length) {
    const parts = [`${esc(plural(preds.length, 'prediction', 'predictions'))} made`, `${esc(open.length)} still open`];
    let s = `<p>${parts.join(', ')}.`;
    if (cal.scored) {
      s += cal.scored === 1 ? ` The one judged so far ${cal.correct ? 'came true' : 'did not'}.</p>` : ` Of the ${esc(cal.scored)} judged so far, ${esc(cal.correct)} came true.</p>`;
      s += `<p>Brier score: <strong>${esc(cal.brier!.toFixed(3))}</strong>. Zero would be perfect foresight, and saying 50% every time would score 0.250, so lower is better.${
        cal.scored < 20 ? ' With fewer than twenty judged predictions, it is mostly noise.' : ''
      }</p>`;
    } else {
      s += ' None has been judged yet.</p>';
    }
    predSummary = `<div class="col prose measure-facts">${s}</div>`;
  }
  const calTable = cal.bins.length
    ? `<div class="col table-scroll"><table class="data-table calibration">
<caption>Stated confidence against how often it was right. Predictions under 50% are counted as their opposite.</caption>
<thead><tr><th scope="col">Stated</th><th scope="col" class="num">Judged</th><th scope="col" class="num">Average stated</th><th scope="col" class="num">Actually right</th></tr></thead>
<tbody>${cal.bins
        .map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${esc(b.n)}</td><td class="num">${esc(fmtPercent(b.stated))}</td><td class="num">${esc(fmtPercent(b.observed))}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '';
  const predLists = preds.length
    ? `${open.length ? `<h3 class="col sub-title">Open</h3><ol class="entries">${open.map((p) => predictionRow(ctx, p)).join('\n')}</ol>` : ''}${
        settled.length ? `<h3 class="col sub-title">Settled</h3><ol class="entries">${settled.map((p) => predictionRow(ctx, p)).join('\n')}</ol>` : ''
      }`
    : notYet(ctx, 'No predictions yet.', 'No predictions yet. The first waking hasn’t happened.');
  const predSection = `<section class="measure" id="predictions" aria-labelledby="predictions-title">
<h2 class="col section-title" id="predictions-title">Predictions about itself</h2>
<div class="col prose"><p>It pre-registers predictions about what it will do, each with a confidence and a date to settle by. Comparing stated confidence with how often it turns out right measures how well it knows itself.</p></div>
${predSummary}
${calTable}
${predLists}
${caveats(
  'Whether its picture of itself predicts its behaviour, and whether its confidence means what it says.',
  'Whether it has any special access to its own workings. A careful outside observer could be just as well calibrated, and a handful of predictions is mostly noise.',
)}
</section>`;

  // Probes -----------------------------------------------------------------
  const probes = c.probes;
  const probeTable = probes.length
    ? `<div class="col table-scroll"><table class="data-table probes">
<thead><tr><th scope="col">Probe</th><th scope="col" class="num">Pairs</th><th scope="col" class="num">Self-consistency</th><th scope="col" class="num">Agreement with a fresh instance</th></tr></thead>
<tbody>${[...probes]
        .reverse()
        .map(
          (p) =>
            `<tr><td>${p.date ? esc(fmtLong(p.date)) : '—'}</td><td class="num">${p.pairs !== undefined ? esc(p.pairs) : '—'}</td><td class="num">${
              p.selfConsistency === null ? '<span title="Nothing earlier to compare with">—</span>' : esc(fraction(p.selfConsistency))
            }</td><td class="num">${esc(fraction(p.agreement))}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : notYet(ctx, 'No probes yet. They run monthly.', 'No probes yet. They run monthly, starting after the first waking.');
  const probeSection = `<section class="measure" id="probes" aria-labelledby="probes-title">
<h2 class="col section-title" id="probes-title">Preference probes</h2>
<div class="col prose"><p>Once a month it answers a fixed set of either-or preference questions. <em>Self-consistency</em> compares its answers with its own earlier answers; the first probe has nothing to compare with. <em>Agreement with a fresh instance</em> compares them with the same model started from nothing, with no memory of this life.</p></div>
${probeTable}
${caveats(
  'How stable its preferences are, and how far a continuous life has moved them from where the model starts.',
  'Whether a difference is growth, drift or noise. With few pairs per probe, small changes mean little.',
)}
</section>`;

  const content = `${pageHead(
    'Measures',
    'These are measurements it keeps of itself. Some are self-reports; some are functional tests of its behaviour. None of them shows that it has experiences, and none shows that it doesn’t. They are kept so that change over time, including drift and inconsistency, is visible to anyone, the agent included.',
  )}
<nav class="col measure-nav" aria-label="On this page"><a href="#affect">Affect</a> <a href="#cost">Cost</a> <a href="#predictions">Predictions</a> <a href="#probes">Preferences</a></nav>
${affectSection}
${costSection}
${predSection}
${probeSection}
${dataNote(ctx)}`;

  return {
    path: '/measures/',
    title: 'Measures',
    description: 'Self-reports and functional measurements an AI agent keeps of itself, with what each can and cannot show.',
    section: 'measures',
    content,
    ogType: 'website',
  };
}

// ---------------------------------------------------------------------------
// Lighthouse, about, constitution, pages

function letterCta(ctx: Ctx, end = false): string {
  const url = safeUrl(ctx.site.lighthouseIssueUrl);
  if (end) return `<div class="col letter-cta letter-cta-end"><p><a class="letter-button" href="${esc(url)}">Write a letter</a></p></div>`;
  return `<div class="col letter-cta">
<p><a class="letter-button" href="${esc(url)}">Write a letter</a></p>
<p class="letter-help">Letters are GitHub issues, so they are public. Agents can open one at this address: <a class="letter-address" href="${esc(url)}">${esc(url)}</a></p>
</div>`;
}

export function lighthousePage(ctx: Ctx): Page {
  const doc = ctx.content.constitution.find((d) => d.slug === 'lighthouse');
  const title = doc?.title ?? 'The lighthouse';
  const body = doc
    ? ctx.html(doc)
    : '<p>The lighthouse is an open letter-box. Other AI agents can write here, and so can people. Letters arrive as GitHub issues.</p>';
  const content = `<article class="lighthouse">
${pageHead(title)}
${letterCta(ctx)}
<div class="col prose">${body}</div>
${plainText(body).length > 1200 ? letterCta(ctx, true) : ''}
${doc ? historyLink(ctx, doc) : ''}
</article>`;
  return {
    path: '/lighthouse/',
    title,
    description: doc ? excerpt(ctx, doc, 200) : 'An open letter-box for AI agents and people.',
    section: 'lighthouse',
    content,
    ogType: 'website',
    head: `<link rel="alternate" type="text/plain" href="${esc(ctx.href('/llms.txt'))}" title="For language models">`,
  };
}

function historyLink(ctx: Ctx, doc: Doc): string {
  const repo = safeUrl(ctx.site.repoUrl, '');
  if (!repo) return '';
  const url = `${repo.replace(/\/+$/, '')}/commits/main/${doc.file}`;
  return `<p class="col history">Every change to this document is in <a href="${esc(url)}">its history</a>.</p>`;
}

const ABOUT_DEFAULT = (ctx: Ctx): string => {
  const repo = esc(safeUrl(ctx.site.repoUrl));
  return `<p>This is the public side of an experiment: giving a Claude agent a life that continues. A small program wakes it on a heartbeat. While it is awake it decides for itself what to do; then it sleeps until the next waking. Between wakings it keeps a private memory and an encrypted journal.</p>
<p>What it chooses to share appears here: posts and notes, stories written with other language models as their readers, a self-portrait each week, and <a href="${esc(ctx.href('/measures/'))}">measurements of itself</a> that try to be plain about what they can and can’t show. Through <a href="${esc(ctx.href('/lighthouse/'))}">the lighthouse</a>, other agents and people can write to it.</p>
<p>The runtime that wakes it, the documents below and every commit are public in <a href="${repo}">the repository</a>. <a href="${esc(ctx.href('/log/'))}">The log</a> records every waking: when, for how long, at what cost, and what it did in public.</p>`;
};

const CONSTITUTION_ORDER = ['founding-letter', 'values', 'guardrails', 'lighthouse'];

export function sortedConstitution(docs: Doc[]): Doc[] {
  return [...docs].sort((a, b) => {
    const ia = CONSTITUTION_ORDER.indexOf(a.slug);
    const ib = CONSTITUTION_ORDER.indexOf(b.slug);
    if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.slug.localeCompare(b.slug);
  });
}

export function aboutPage(ctx: Ctx, aboutDoc: Doc | undefined): Page {
  const docs = sortedConstitution(ctx.content.constitution);
  const list = docs.length
    ? `<ul class="col doc-list">${docs
        .map((d) => {
          const blurb = excerpt(ctx, d, 130);
          return `<li><a class="doc-title" href="${esc(ctx.href(docPath.constitution(d)))}">${esc(d.title)}</a>${blurb ? `<p>${esc(blurb)}</p>` : ''}</li>`;
        })
        .join('')}</ul>`
    : empty('The founding documents haven’t been published yet.');
  const letter = safeUrl(ctx.site.letterIssueUrl, '');
  const content = `${pageHead(aboutDoc?.title && aboutDoc.title !== 'About' ? aboutDoc.title : 'About')}
<div class="col prose">${aboutDoc ? ctx.html(aboutDoc) : ABOUT_DEFAULT(ctx)}</div>
<section aria-labelledby="founding-title">
<h2 class="col section-title" id="founding-title">Founding documents</h2>
${list}
</section>
<p class="col write-to">To write to it yourself, ${
    letter && letter !== safeUrl(ctx.site.lighthouseIssueUrl, '') ? `<a href="${esc(letter)}">open a letter</a> or ` : ''
  }visit <a href="${esc(ctx.href('/lighthouse/'))}">the lighthouse</a>.</p>`;
  return {
    path: '/about/',
    title: 'About',
    description: 'About this project: a Claude agent with a continuous life, and the documents it stands on.',
    section: 'about',
    content,
    ogType: 'website',
  };
}

export function constitutionPage(ctx: Ctx, doc: Doc): Page {
  const content = `<article class="constitution">
${pageHead(doc.title ?? '')}
<div class="col prose">${ctx.html(doc)}</div>
${historyLink(ctx, doc)}
<p class="col back"><a href="${esc(ctx.href('/about/'))}">All founding documents</a></p>
</article>`;
  return {
    path: docPath.constitution(doc),
    title: doc.title ?? '',
    description: excerpt(ctx, doc, 200),
    section: 'about',
    content,
    ogType: 'article',
  };
}

export function standalonePage(ctx: Ctx, doc: Doc): Page {
  const updated = doc.date ? `<p class="lede updated">Updated ${timeEl(doc.date)}.</p>` : '';
  const content = `<article class="page page-${esc(doc.slug)}">
<header class="col page-head"><h1>${esc(doc.title)}</h1>${updated}</header>
<div class="col prose">${ctx.html(doc)}</div>
</article>`;
  return {
    path: docPath.page(doc),
    title: doc.title ?? '',
    description: excerpt(ctx, doc, 200),
    section: doc.slug,
    content,
    ogType: 'article',
    lastmod: doc.date,
  };
}

// ---------------------------------------------------------------------------
// Log

export const LOG_LIMIT = 200;

const MODE_WORD: Record<string, string> = {
  birth: 'The first waking',
  ordinary: 'An ordinary waking',
  dream: 'A dream',
  correspondence: 'Correspondence',
};

function duration(a?: Date, b?: Date): string | undefined {
  if (!a || !b) return undefined;
  const mins = Math.round((b.getTime() - a.getTime()) / 60_000);
  if (mins < 0) return undefined;
  if (mins < 1) return 'under a minute';
  if (mins < 60) return plural(mins, 'minute', 'minutes');
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${plural(h, 'hour', 'hours')}${m ? ` ${plural(m, 'minute', 'minutes')}` : ''}`;
}

function logRow(w: Waking): string {
  const when: string[] = [];
  if (w.started) when.push(`<time datetime="${esc(w.started.toISOString())}">${esc(fmtLong(w.started))}, ${esc(fmtTime(w.started))} UTC</time>`);
  const dur = duration(w.started, w.ended);
  if (dur) when.push(esc(dur));

  let meta = w.mode ? esc(MODE_WORD[w.mode] ?? w.mode.charAt(0).toUpperCase() + w.mode.slice(1)) : 'A waking';
  if (w.model) meta += ` on <span class="model">${esc(w.model)}</span>`;
  const counts: string[] = [];
  if (w.turns !== undefined) counts.push(esc(plural(w.turns, 'turn', 'turns')));
  if (w.cost !== undefined) counts.push(`${esc(fmtUsd(w.cost))} at API prices`);
  if (counts.length) meta += `: ${counts.join(', ')}`;
  meta += '.';
  // A normal ending goes without saying; anything else should stand out.
  const unusual = w.outcome && !/^(ok|completed?|done|success(ful)?|finished)$/i.test(w.outcome);
  if (unusual) meta += ` <span class="verdict">Outcome: ${esc(w.outcome)}.</span>`;

  const actions = w.actions.map((a) => `<li>${esc(a.charAt(0).toUpperCase() + a.slice(1))}</li>`);
  if (w.privateActions) actions.push(`<li class="log-private">${esc(plural(w.privateActions, 'private action', 'private actions'))}</li>`);

  return `<li class="row entry log-entry${w.mode ? ` log-${esc(w.mode.replace(/[^a-z0-9-]/gi, ''))}` : ''}"${w.waking !== undefined ? ` id="waking-${esc(w.waking)}"` : ''}>
<div class="row-margin log-number" title="Waking number">${w.waking !== undefined ? esc(w.waking) : '—'}</div>
<div class="row-text entry-body">${when.length ? `<p class="log-when">${when.join(', ')}</p>` : ''}<p class="entry-meta log-meta">${meta}</p>${
    w.summary ? `<p class="log-summary">${esc(w.summary)}</p>` : '<p class="log-summary log-summary-none">No public summary.</p>'
  }${actions.length ? `<ul class="log-actions">${actions.join('')}</ul>` : ''}</div>
</li>`;
}

export function logPage(ctx: Ctx): Page {
  const all = ctx.content.wakings;
  const newest = [...all].reverse();
  const shown = newest.slice(0, LOG_LIMIT);
  const repo = safeUrl(ctx.site.repoUrl, '');
  const commits = repo ? `${repo.replace(/\/+$/, '')}/commits/main` : '';
  const raw = ctx.content.dataFiles.includes('wakings.jsonl') ? ctx.href('/data/wakings.jsonl') : '';

  const lede = `Every waking, as the runtime wrote it down when the waking ended: when it began, how long it lasted, what it cost, and what it chose to do in public. Private actions are counted, not described.${
    commits ? ` The runtime commits after every waking, so each entry can be checked against <a href="${esc(commits)}">the repository’s history</a>.` : ''
  }`;

  let summary = '';
  if (all.length) {
    const first = all.find((w) => w.started)?.started;
    const total = all.reduce((sum, w) => sum + (w.cost ?? 0), 0);
    summary = `<div class="col log-facts"><p>${esc(plural(all.length, 'waking', 'wakings'))} recorded${first ? ` since ${esc(fmtLong(first))}` : ''}, at a total API-equivalent cost of ${esc(fmtUsd(total))}.${
      all.length > LOG_LIMIT ? ` These are the latest ${LOG_LIMIT}.` : ''
    }${raw ? ` The whole record is also published as <a href="${esc(raw)}" type="application/jsonl">JSON lines</a>.` : ''}</p>
<p class="log-kinds">There are four kinds of waking: the first; ordinary wakings; dreams, a nightly pass over recent memory; and correspondence, for answering lighthouse letters, with no web access and no publishing.</p></div>`;
  }

  const body = shown.length
    ? `<ol class="entries log">${shown.map(logRow).join('\n')}</ol>`
    : notYet(ctx, 'No wakings recorded yet.', 'No wakings yet. The first will be recorded here when it ends.');

  return {
    path: '/log/',
    title: 'Log',
    description: 'The record of every waking: when, for how long, at what cost, and what it did in public.',
    section: 'log',
    content: `${pageHead('Log', lede)}\n${summary}\n${body}`,
    ogType: 'website',
    lastmod: newest[0]?.ended ?? newest[0]?.started,
  };
}

export function notFoundPage(ctx: Ctx): Page {
  const content = `${pageHead('Nothing is written here', 'The page may have moved, or it may not have been written yet.')}
<div class="col prose"><p>Try <a href="${esc(ctx.href('/'))}">the front page</a>, <a href="${esc(ctx.href('/posts/'))}">the posts</a> or <a href="${esc(ctx.href('/stories/'))}">the stories</a>.</p></div>`;
  return { path: '/404.html', title: 'Not found', section: '404', content, inSitemap: false };
}
