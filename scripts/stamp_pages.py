#!/usr/bin/env python3
"""Write what the pages have to say into the pages themselves.

    python3 scripts/stamp_pages.py            write the files
    python3 scripts/stamp_pages.py --check    change nothing; list what is out of date and exit 1

Cadence has no build step: the HTML in this repository is the HTML that is
served. A few things on the public pages depend on src/config.js, though (who
runs the site, the site's address, the reply-time promise), and a page that
waited for a script to fill those in would be incomplete for anyone, or any
crawler, that reads the HTML without running it. So this script copies them
in, and the result is committed. Run it after changing the `site` block in
src/config.js, the date in site.js, or a page's title or description.

What it writes, and nothing else:

  in every page   the block between <!-- stamp:head --> and <!-- /stamp:head -->:
                  the canonical address, "noindex" on pages that should stay out
                  of search results, the tags a shared link is drawn from, and
                  breadcrumb data for search engines
                  the inside of anything marked data-site="..."
                  anything marked data-needs="...": kept if it is true for this
                  set-up, put inside an <!--off ... off--> comment if it is not
  robots.txt      what crawlers may fetch, and where the sitemap is
  sitemap.xml     the pages that should be found, with the date each changed

A page's <title> and description are written by hand in the page, above the
block; this script only reads them. It never touches anything outside the
places listed, so running it twice in a row changes nothing.

Uses only the standard library, so it runs anywhere python3 does.
"""
import base64
import datetime
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOCIAL_IMAGE = '/icons/social.png'
SOCIAL_ALT = 'Cadence: the planner that schedules your homework. A week with school, activities, events and planned work.'

# Every page there is. `address` is the clean one people and search engines
# should use (netlify.toml serves each file at it). `listed` pages are the
# ones worth finding in a search: they go in the sitemap. The rest ask not to
# be indexed: the planner and its demo draw themselves with scripts from what
# is stored in the browser, so their HTML has nothing in it to index, and the
# thank-you page only means something right after a message was sent.
PAGES = [
    # file            address      listed  breadcrumb trail (name, address)
    ('index.html',    '/',         True,   []),
    ('privacy.html',  '/privacy',  True,   [('Home', '/'), ('Privacy policy', '/privacy')]),
    ('terms.html',    '/terms',    True,   [('Home', '/'), ('Terms of use', '/terms')]),
    ('contact.html',  '/contact',  True,   [('Home', '/'), ('Contact', '/contact')]),
    ('thanks.html',   '/thanks',   False,  []),
    ('app.html',      '/app',      False,  []),
    ('demo.html',     '/demo',     False,  []),
    # Served for any address that does not exist, so it has no address of its own.
    ('404.html',      None,        False,  []),
]

HEAD_OPEN, HEAD_CLOSE = '<!-- stamp:head -->', '<!-- /stamp:head -->'


# ------------------------------------------------------------------ reading

def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def js_source(text):
    """JavaScript with its comments taken out, so a key that is only mentioned
    in a comment (or a line that was commented out) is never read as a value.
    It walks the text once and knows a string from a comment, so // inside a
    string, or /* inside a // comment, cannot confuse it."""
    out, i, n = [], 0, len(text)
    while i < n:
        two = text[i:i + 2]
        if two == '//':
            while i < n and text[i] != '\n':
                i += 1
        elif two == '/*':
            end = text.find('*/', i + 2)
            i = n if end < 0 else end + 2
        elif text[i] in '\'"`':
            quote, start = text[i], i
            i += 1
            while i < n and text[i] != quote:
                i += 2 if text[i] == '\\' else 1
            i += 1
            out.append(text[start:i])
        else:
            out.append(text[i])
            i += 1
    return ''.join(out)


_ESCAPES = {'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', 'v': '\v', '0': '\0'}


def _unescape(m):
    body = m.group(1)
    if body[0] == 'u' and body[1:2] == '{':
        return chr(int(body[2:-1], 16))
    if body[0] in 'ux' and len(body) > 1:
        return chr(int(body[1:], 16))
    return _ESCAPES.get(body, body)      # \' and \\ and the like: the character itself


def js_string(text, key):
    """The string written after `key:` in a JavaScript object, in either kind
    of quote, with its backslash escapes turned into the characters they
    stand for, as JavaScript would. '' if the key is not there."""
    m = re.search(rf"""\b{key}:\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")""", text)
    if not m:
        return ''
    raw = m.group(1) if m.group(1) is not None else m.group(2)
    return re.sub(r'\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)', _unescape, raw).strip()


def is_secret_key(key):
    """The same test as isSecretKey() in src/config.js: a key that must never
    be in a browser. Supabase's secret keys start with sb_secret_; the older
    kind is a token whose contents name a role other than "anon"."""
    key = key.strip()
    if key.lower().startswith('sb_secret_'):
        return True
    parts = key.split('.')
    if len(parts) != 3 or not key.startswith('eyJ'):
        return False
    try:
        body = parts[1].replace('-', '+').replace('_', '/')
        return json.loads(base64.b64decode(body + '=' * (-len(body) % 4))).get('role') != 'anon'
    except (ValueError, AttributeError):
        return True


def config():
    text = js_source(read('src/config.js'))
    field = lambda key: js_string(text, key)
    url, key = field('supabaseUrl'), field('supabaseKey')
    return {
        'domain': re.sub(r'^https?://', '', field('domain')).strip('/'),
        'operator': field('operator'),
        'contact': field('contactEmail'),
        'reply': field('replyWithin'),
        'visits': bool(re.search(r'\bcountVisits:\s*true\b', text)),
        # The same test as cloudConfigured() in src/config.js.
        'cloud': bool(re.match(r'(https://.+|http://localhost(:\d+)?/.+)', url)) and len(key) > 20 and not is_secret_key(key),
        'supabase_url': url,
        'supabase_key': key,
    }


def site_updated():
    m = re.search(r"const SITE_UPDATED = '(\d{4}-\d{2}-\d{2})'", read('site.js'))
    if not m:
        sys.exit('site.js has no SITE_UPDATED date.')
    return m.group(1)


def long_date(iso):
    d = datetime.date.fromisoformat(iso)
    return f'{d.strftime("%B")} {d.day}, {d.year}'


def title_and_description(page_html, name):
    t = re.search(r'<title>(.*?)</title>', page_html, re.S)
    d = re.search(r'<meta name="description" content="([^"]*)">', page_html)
    if not t or not d:
        sys.exit(f'{name} needs a <title> and a <meta name="description">.')
    return html.unescape(t.group(1).strip()), html.unescape(d.group(1).strip())


# ------------------------------------------------------------------ writing

def esc(text):
    return html.escape(text, quote=True)


def ld(data):
    """One block of structured data. </ cannot end the script early."""
    return '<script type="application/ld+json">' + json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/') + '</script>'


def head_block(name, address, listed, trail, page_html, cfg):
    base = f'https://{cfg["domain"]}' if cfg['domain'] else ''
    title, description = title_and_description(page_html, name)
    lines = []
    if address:
        # With no domain yet the address is written from the root of whatever
        # host is serving the page, which is still right, only less explicit.
        lines.append(f'<link rel="canonical" href="{esc(base + address)}">')
    if not listed:
        lines.append('<meta name="robots" content="noindex">')
    if address:
        lines += [
            '<meta property="og:site_name" content="Cadence">',
            '<meta property="og:type" content="website">',
            f'<meta property="og:title" content="{esc(title)}">',
            f'<meta property="og:description" content="{esc(description)}">',
        ]
        if base:
            lines.append(f'<meta property="og:url" content="{esc(base + address)}">')
        lines += [
            f'<meta property="og:image" content="{esc(base + SOCIAL_IMAGE)}">',
            '<meta property="og:image:width" content="1200">',
            '<meta property="og:image:height" content="630">',
            f'<meta property="og:image:alt" content="{esc(SOCIAL_ALT)}">',
            '<meta name="twitter:card" content="summary_large_image">',
        ]
    if base and listed and address == '/':
        lines.append(ld({'@context': 'https://schema.org', '@type': 'WebSite', 'name': 'Cadence', 'url': base + '/'}))
    if base and listed and trail:
        lines.append(ld({
            '@context': 'https://schema.org', '@type': 'BreadcrumbList',
            'itemListElement': [{'@type': 'ListItem', 'position': i, 'name': label, 'item': base + where}
                                for i, (label, where) in enumerate(trail, 1)],
        }))
    return lines


def stamp_head(page_html, name, lines):
    m = re.search(rf'^([ \t]*){re.escape(HEAD_OPEN)}.*?{re.escape(HEAD_CLOSE)}', page_html, re.S | re.M)
    if not m:
        sys.exit(f'{name} has no {HEAD_OPEN} ... {HEAD_CLOSE} block in its <head>.')
    indent = m.group(1)
    block = '\n'.join([f'{indent}{HEAD_OPEN}'] + [indent + line for line in lines] + [f'{indent}{HEAD_CLOSE}'])
    return page_html[:m.start()] + block + page_html[m.end():]


def pending(what):
    return f'<mark class="pending">{what} to be added before launch</mark>'


def stamp_body(page_html, cfg, updated):
    values = {
        'operator': esc(cfg['operator']) if cfg['operator'] else pending('Operator name'),
        'contact': f'<a href="mailto:{esc(cfg["contact"])}">{esc(cfg["contact"])}</a>' if cfg['contact'] else pending('Contact email'),
        'reply': esc(cfg['reply']),
        'updated': f'<time datetime="{updated}">{long_date(updated)}</time>',
    }
    if cfg['domain']:
        values['domain'] = esc(cfg['domain'])

    def fill(m):
        return m.group(1) + values[m.group(3)] + m.group(5) if m.group(3) in values else m.group(0)
    page_html = re.sub(r'(<(\w+)\b[^<>]*\sdata-site="([a-z]+)"[^<>]*>)(.*?)(</\2>)', fill, page_html, flags=re.S)

    return only_what_is_true(page_html, cfg)


OFF_OPEN, OFF_CLOSE = '<!--off ', ' off-->'


def element_end(page_html, opening):
    """Where the element that starts at the match `opening` ends: just past
    its own closing tag, counting any tags of the same name nested in it."""
    tag, depth = opening.group(1), 1
    for m in re.compile(rf'<(/?){tag}\b[^<>]*>').finditer(page_html, opening.end()):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return m.end()
    sys.exit(f'An element marked data-needs="{opening.group(2)}" is never closed.')


def only_what_is_true(page_html, cfg):
    """Some sentences are only true in some set-ups: "does not use analytics"
    while visit counting is off, a different one while it is on. Both are
    written in the page, each marked data-needs="...". The one that does not
    apply is put inside an HTML comment, so the page says exactly what is
    true to a browser, to a reader with scripts off and to anything that
    takes the text out of the HTML, and the other wording is still there to
    be brought back when the set-up changes."""
    facts = {'cloud': cfg['cloud'], 'visits': cfg['visits'], 'contact': bool(cfg['contact']), 'reply': bool(cfg['reply'])}
    # Everything back in first, then decide again from scratch.
    page_html = re.sub(re.escape(OFF_OPEN) + r'(.*?)' + re.escape(OFF_CLOSE), r'\1', page_html, flags=re.S)
    out, at = [], 0
    for m in re.finditer(r'<(\w+)\b[^<>]*\sdata-needs="([a-z-]+)"[^<>]*>', page_html):
        if m.start() < at:
            continue                              # inside an element already dealt with
        need = m.group(2)
        inverted, fact = (True, need[3:]) if need.startswith('no-') else (False, need)
        if fact not in facts:
            continue
        end = element_end(page_html, m)
        # `hidden` is not how these are switched any more; a stray one would hide a true sentence.
        element = re.sub(r'\shidden\b', '', m.group(0)) + page_html[m.end():end]
        shown = (not facts[fact]) if inverted else facts[fact]
        if not shown and '--' in element:
            sys.exit(f'The data-needs="{need}" element contains "--", which cannot go inside an HTML comment.')
        out.append(page_html[at:m.start()] + (element if shown else OFF_OPEN + element + OFF_CLOSE))
        at = end
    out.append(page_html[at:])
    return ''.join(out)


def last_changed(name, page_html, updated):
    """The privacy policy and the terms carry their own date; other pages share the site's."""
    m = re.search(r'<p class="updated">Last updated <time datetime="(\d{4}-\d{2}-\d{2})">', page_html)
    return m.group(1) if m else updated


def robots(cfg):
    lines = [
        '# Everything a visitor can read, a crawler can read.',
        '#',
        '# The planner (/app) and its demo (/demo) are not blocked here on purpose.',
        '# They ask to stay out of search results with a tag in their own HTML,',
        '# and a crawler can only see that tag if it is allowed to fetch the page.',
        '# The stylesheets and scripts under /src are open so pages can be drawn.',
        '',
        'User-agent: *',
        'Disallow: /api/',
    ]
    if cfg['domain']:
        lines += ['', f'Sitemap: https://{cfg["domain"]}/sitemap.xml']
    return '\n'.join(lines) + '\n'


def sitemap(cfg, dates):
    base = f'https://{cfg["domain"]}'
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for name, address, listed, _ in PAGES:
        if listed:
            out.append(f'  <url><loc>{esc(base + address)}</loc><lastmod>{dates[name]}</lastmod></url>')
    out.append('</urlset>')
    return '\n'.join(out) + '\n'


# --------------------------------------------------------------------- main

def build():
    """Every file this script owns, as {path: text}. A value of None means the file should not exist."""
    cfg, updated = config(), site_updated()
    out, dates = {}, {}
    for name, address, listed, trail in PAGES:
        page_html = read(name)
        page_html = stamp_head(page_html, name, head_block(name, address, listed, trail, page_html, cfg))
        page_html = stamp_body(page_html, cfg, updated)
        out[name] = page_html
        dates[name] = last_changed(name, page_html, updated)
    out['robots.txt'] = robots(cfg)
    # A sitemap needs full addresses. Until the site has one there is no sitemap.
    out['sitemap.xml'] = sitemap(cfg, dates) if cfg['domain'] else None
    return out, cfg


def main():
    check = '--check' in sys.argv
    files, cfg = build()
    stale = []
    for rel, text in files.items():
        path = ROOT / rel
        current = path.read_text(encoding='utf-8') if path.is_file() else None
        if current == text:
            continue
        stale.append(rel)
        if check:
            continue
        if text is None:
            path.unlink()
        else:
            path.write_text(text, encoding='utf-8')

    where = f'https://{cfg["domain"]}' if cfg['domain'] else 'no address yet (site.domain is empty), so links are written from the root and there is no sitemap'
    if check:
        if stale:
            print('Out of date: ' + ', '.join(stale) + '\nRun: python3 scripts/stamp_pages.py')
            sys.exit(1)
        print(f'Stamped pages are up to date ({where}).')
        return
    print(f'Site address: {where}')
    print('Wrote: ' + ', '.join(stale) if stale else 'Nothing to change.')


if __name__ == '__main__':
    main()
