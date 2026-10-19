#!/usr/bin/env python3
"""Is Cadence ready to launch?

    python3 scripts/prelaunch_check.py

Checks the launch gates and the house style rules, and exits non-zero while
any of them fails. Nothing here talks to the network: it reads the files that
would be deployed.

Launch gates (all must pass before the site is announced):
  * a custom domain is set, not a netlify.app address
  * a favicon exists and every page links it
  * there is no "made with" or "powered by" tag anywhere
  * a privacy policy page and a terms page exist, name who runs the site, and
    are linked from the homepage and the sign-in screen

House style (so the site does not read as generated):
  * no gradients, no pill-shaped controls
  * no em dashes and no emoji in anything a person reads
  * no scroll-triggered or cursor animation, no counters. Three things know
    where the page is scrolled to and are allowed by name, and only those: the
    marker under the header link of the section being read, the back-to-top button
    appearing once the top of the page is out of sight, and the bar of two
    buttons on a phone, which is there only while the page's own buttons are
    not. None of them is an animation
  * nothing that looks like a secret committed to the repository

Things that have to stay true as the site changes:
  * every page loads the theme script before its stylesheets
  * the "site updated" date is not older than the pages it describes
  * the privacy page and the visit counter agree with each other

Being found, and being shared (scripts/stamp_pages.py writes most of this):
  * every page has its own title and description, and a canonical address
  * the planner, its demo, the thank-you page and the 404 page ask not to be
    indexed; everything else is in sitemap.xml, and robots.txt points at it
  * a link to any page draws a card: a 1200 by 630 image and the tags for it
  * what the pages say is in the HTML as it is served, not added by a script
  * every link from one page to another goes somewhere that exists
"""
import datetime
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True      # a check should leave nothing behind in the folder that gets deployed
sys.path.insert(0, str(Path(__file__).resolve().parent))
import stamp_pages  # noqa: E402  (the list of pages, and what should be written into them)

PAGES = [name for name, *_ in stamp_pages.PAGES]
# The pages that are read rather than used: plain HTML, complete without a script.
PUBLIC_PAGES = ['index.html', 'privacy.html', 'terms.html', 'contact.html', 'thanks.html', '404.html']
STYLES = ['site.css', 'src/panel/panel.css', 'src/panel/web.css', 'src/panel/tour.css', 'src/content/content.css']
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))


def read(rel):
    p = ROOT / rel
    return p.read_text(encoding='utf-8') if p.is_file() else ''


def shipped_js():
    return sorted(p for p in (ROOT / 'src').rglob('*.js')) + [ROOT / 'site.js'] + sorted((ROOT / 'netlify').rglob('*.mjs'))


def without_comments(text):
    """Drop // and /* */ comments so only code and strings are judged."""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('*'):
            continue
        out.append(re.sub(r'(?<![:\'"`\\])//(?!/).*$', '', line))
    return '\n'.join(out)


# ------------------------------------------------------------ launch gates
config = stamp_pages.js_source(read('src/config.js'))      # comments out, so only real values are read
field = lambda key: stamp_pages.js_string(config, key)
domain, operator, contact = field('domain'), field('operator'), field('contactEmail')

check('Custom domain is set in src/config.js', bool(domain) and 'netlify.app' not in domain,
      f'site.domain is "{domain}"' if domain else 'site.domain is empty. Connect a domain in Netlify, then write it here.')
check('Operator name is set (shown on the privacy and terms pages)', bool(operator), 'site.operator is empty' if not operator else '')
check('Contact email is set (shown on the privacy and terms pages)', bool(re.match(r'[^@\s]+@[^@\s]+\.[^@\s]+$', contact)), 'site.contactEmail is empty or not an email' if not contact else '')

favicon = (ROOT / 'favicon.ico')
check('favicon.ico exists', favicon.is_file() and favicon.stat().st_size > 200)
for page in PAGES:
    html = read(page)
    check(f'{page} exists', bool(html))
    check(f'{page} links a favicon', 'rel="icon"' in html, 'no <link rel="icon">')

for needle in ('privacy.html', 'terms.html'):
    check(f'Homepage links {needle}', needle in read('index.html'))
    check(f'Sign-in screen links {needle}', needle in read('src/panel/views/signin.js'))
for page in ('privacy.html', 'terms.html'):
    html = read(page)
    check(f'{page} names who runs the site', 'data-site="operator"' in html)
    check(f'{page} gives a contact', 'data-site="contact"' in html)

everything = {p: read(p) for p in PAGES}
everything.update({str(p.relative_to(ROOT)): p.read_text(encoding='utf-8') for p in shipped_js()})
everything.update({p: read(p) for p in STYLES})
everything['manifest.json'] = read('manifest.json')

badge = re.compile(r'made with|built with|powered by|generated by|created with', re.I)
hits = [f'{name}: "{m.group(0)}"' for name, text in everything.items() for m in badge.finditer(without_comments(text) if name.endswith(('.js', '.mjs', '.css')) else text)]
check('No "made with" or "powered by" tag', not hits, '; '.join(hits[:5]))

# -------------------------------------------------------------- house style
css = {p: without_comments(read(p)) for p in STYLES}
grad = []
for name, text in css.items():
    for line in text.splitlines():
        # The one allowed use: the two small triangles that draw a <select> arrow.
        if 'gradient(' in line and not line.strip().startswith('select {'):
            grad.append(f'{name}: {line.strip()[:70]}')
check('No gradients in the stylesheets', not grad, '; '.join(grad[:4]))
check('No gradients in inline styles or markup', not any('gradient(' in without_comments(t) for n, t in everything.items() if n.endswith(('.js', '.html'))),
      ', '.join(n for n, t in everything.items() if n.endswith(('.js', '.html')) and 'gradient(' in without_comments(t)))

pills = []
for name, text in css.items():
    for m in re.finditer(r'([^{}]+)\{([^}]*border-radius:\s*(?:999|9999|100)px[^}]*)\}', text):
        selector = m.group(1).strip().split('\n')[-1]
        if '.toggle' in selector:      # an on/off switch is a switch, not a button
            continue
        pills.append(f'{name}: {selector[:50]}')
check('No pill-shaped controls', not pills, '; '.join(pills[:4]))

EM_DASH = '—'
# The character itself, and the ways of writing it without typing it.
ANY_EM_DASH = re.compile(EM_DASH + r'|&mdash;|&#8212;|&#x2014;|\\u2014|\\u\{2014\}', re.I)
dashes = []
for name, text in everything.items():
    body = text if name.endswith('.html') or name.endswith('.json') else without_comments(text)
    for i, line in enumerate(body.splitlines(), 1):
        if not ANY_EM_DASH.search(line):
            continue
        # Patterns that read what a student typed may match a dash; that is input, not copy.
        if name.endswith(('.js', '.mjs')) and re.search(r'(split|replace|match|test|RegExp)\(|/[^/\n]*' + EM_DASH + r'[^/\n]*/[gimsu]*', line):
            continue
        dashes.append(f'{name}: {line.strip()[:60]}')
check('No em dashes in anything a person reads', not dashes, '; '.join(dashes[:4]))

emoji = re.compile('[\U0001F000-\U0001FAFF☀-➿⭐⭕️]')
found = [f'{name}: {m.group(0)!r}' for name, text in everything.items() for m in emoji.finditer(text)]
check('No emoji', not found, '; '.join(found[:5]))

# The two uses of scroll position that are allowed, written out exactly. Take
# these lines away and nothing else on the public pages may know about scroll.
ALLOWED_SCROLL = {
    'site.js': [
        # The header link for the section being read (initSections).
        "if (!('IntersectionObserver' in window)) return;",
        "const here = new IntersectionObserver((entries) => { for (const e of entries) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); } const first = targets.find((t) => seen.has(t)); if (first === hero) mark(null); else if (first && byId.has(first.id)) mark(first.id); }, { rootMargin: '-80px 0px -60% 0px' });",
        "if ('IntersectionObserver' in window) {",
        "new IntersectionObserver(([entry]) => { top.hidden = entry.isIntersecting; }, { rootMargin: '150% 0px 0px 0px' }).observe(marker);",
        "if (!('IntersectionObserver' in window)) return;",
        "const watch = new IntersectionObserver((entries) => { for (const e of entries) { if (e.isIntersecting) onScreen.add(e.target); else onScreen.delete(e.target); } show(onScreen.size === 0); }, { rootMargin: '-64px 0px 0px 0px' });",
    ],
}


def scroll_free(name):
    text = without_comments(read(name)) if name.endswith(('.js', '.css')) else read(name)
    for allowed in ALLOWED_SCROLL.get(name, []):
        text = text.replace(allowed, '', 1)
    return text


MOTION = re.compile(
    r'IntersectionObserver|scroll-timeline|animation-timeline|view-timeline|onscroll|onwheel|onmousemove|onpointermove'
    r'|addEventListener\(\s*[\'"](?:scroll|wheel|mousemove|pointermove|touchmove)'
    r'|requestAnimationFrame|\.scrollY\b|\.pageYOffset\b|\.scrollTop\b|cursor:\s*url')
motion = [name for name in PAGES + ['site.css', 'site.js'] if MOTION.search(scroll_free(name))]
check('No scroll-triggered or cursor animation on the public pages', not motion, ', '.join(motion))
check('The section marker in the header does not animate',
      'animation-timeline' not in without_comments(read('site.css')) and '.nav::after' not in without_comments(read('site.css')))
check('No counters or testimonials on the homepage', not re.search(r'testimonial|data-count|countup|students? (use|trust)|rated \d|\d[\d,]*\+? (students|users|schools)', read('index.html'), re.I))

# ------------------------------------------------- things that must stay true
for page in PAGES + ['src/panel/panel.html']:
    html = read(page)
    theme, sheet = html.find('theme.js"></script>'), html.find('rel="stylesheet"')
    check(f'{page} sets the theme before its styles load', 0 < theme < sheet, 'theme.js is missing or comes after the stylesheets')
for page in PUBLIC_PAGES:
    check(f'{page} has a skip link', 'class="skip" href="#main"' in read(page) and 'id="main"' in read(page))
check('The public pages and the app have print styles', '@media print' in read('site.css') and '@media print' in read('src/panel/web.css'))

# The date in the footer of the public pages. It has to be at least as new as
# the last change to any of them, or it is a date that means nothing.
PUBLIC = PUBLIC_PAGES + ['site.css', 'site.js']
stamp = (re.search(r"const SITE_UPDATED = '(\d{4}-\d{2}-\d{2})'", read('site.js')) or [None, ''])[1]
check('site.js carries the date the public pages were last changed', bool(stamp), 'SITE_UPDATED is missing from site.js')
try:
    committed = subprocess.run(['git', 'log', '-1', '--format=%cs', '--', *PUBLIC], cwd=ROOT, capture_output=True, text=True, timeout=10).stdout.strip()
    dirty = subprocess.run(['git', 'status', '--porcelain', '--', *PUBLIC], cwd=ROOT, capture_output=True, text=True, timeout=10).stdout.splitlines()
except (OSError, subprocess.SubprocessError):
    committed, dirty = '', []
# A page that has been edited but not committed counts from the day it was
# last saved, not from today: the date should not go stale overnight just
# because the work has not been committed yet.
edited = [ROOT / line[3:].strip().strip('"') for line in dirty]
saved = max((datetime.date.fromtimestamp(f.stat().st_mtime).isoformat() for f in edited if f.is_file()), default='')
newest = max(filter(None, [committed, saved]), default='')
check('The "site updated" date is not older than the public pages', bool(stamp) and (not newest or stamp >= newest),
      f'SITE_UPDATED is {stamp} but the pages last changed on {newest}. Set it to {newest} in site.js.')
for page in ('privacy.html', 'terms.html'):
    check(f'{page} says when it was last updated', bool(re.search(r'Last updated <time datetime="\d{4}-\d{2}-\d{2}">', read(page))))

# Counting visits is a claim on the privacy page. Either it is off, or the
# pieces it needs exist: the function, the table, and a database to write to.
counting = bool(re.search(r'countVisits:\s*true', config))
cloud_set = bool(field('supabaseUrl')) and bool(field('supabaseKey')) and not stamp_pages.is_secret_key(field('supabaseKey'))
check('Visit counting is off, or everything it needs is in place',
      not counting or (cloud_set and (ROOT / 'netlify/functions/visit.mjs').is_file() and 'count_visit' in read('supabase/schema.sql')),
      'site.countVisits is true but the Supabase project is not configured in src/config.js')
check('The privacy page has both wordings for visit counting',
      'data-needs="no-visits"' in read('privacy.html') and 'data-needs="visits"' in read('privacy.html'))

# ------------------------------------------------- being found and shared
try:
    stamped, cfg = stamp_pages.build()
    problem = ''
except (SystemExit, OSError) as e:       # a page is missing, or has no title, description or stamp block
    stamped, cfg, problem = {}, stamp_pages.config(), str(e)
stale = [rel for rel, text in stamped.items() if (read(rel) if (ROOT / rel).is_file() else None) != text]
check('The pages carry what src/config.js says (scripts/stamp_pages.py has been run)', not problem and not stale,
      problem or 'Out of date: ' + ', '.join(stale) + '. Run python3 scripts/stamp_pages.py')
check('The contact page promises a reply time (site.replyWithin)', bool(cfg['reply']), 'site.replyWithin is empty, so the contact page makes no promise')

heads = {}
for name, address, listed, _ in stamp_pages.PAGES:
    html = read(name)
    title = (re.search(r'<title>(.*?)</title>', html, re.S) or [None, ''])[1].strip()
    desc = (re.search(r'<meta name="description" content="([^"]*)">', html) or [None, ''])[1].strip()
    heads[name] = (title, desc)
    check(f'{name} has a title of a sensible length', 0 < len(title) <= 60, f'"{title}" is {len(title)} characters')
    check(f'{name} has a description of a sensible length', 70 <= len(desc) <= 160, f'{len(desc)} characters; aim for 70 to 160')
    canonical = re.findall(r'<link rel="canonical" href="([^"]+)">', html)
    if address:
        want = (f'https://{cfg["domain"]}' if cfg['domain'] else '') + address
        check(f'{name} names its one canonical address', canonical == [want], f'found {canonical or "none"}, expected {want}')
        picture = (re.search(r'<meta property="og:image" content="([^"]*)">', html) or [None, ''])[1]
        check(f'{name} can be shared: title, description and a picture at a full address',
              all(tag in html for tag in ('property="og:title"', 'property="og:description"', 'name="twitter:card" content="summary_large_image"'))
              and picture.startswith('https://'), f'og:image is "{picture}"; it needs the site address, so set site.domain')
    else:
        check(f'{name} has no canonical address (it is served for addresses that do not exist)', not canonical)
    noindex = '<meta name="robots" content="noindex">' in html
    check(f'{name} {"is offered to" if listed else "asks to stay out of"} search engines', noindex != listed)
titles = [t for t, _ in heads.values()]
descs = [d for _, d in heads.values()]
check('Every page has a title no other page has', len(set(titles)) == len(titles), ', '.join(sorted({t for t in titles if titles.count(t) > 1})))
check('Every page has a description no other page has', len(set(descs)) == len(descs))

social = ROOT / 'icons' / 'social.png'
size = None
if social.is_file():
    raw = social.read_bytes()[:24]
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        size = (int.from_bytes(raw[16:20], 'big'), int.from_bytes(raw[20:24], 'big'))
check('The image for shared links is a 1200 by 630 PNG', size == (1200, 630), f'icons/social.png is {size}')

robots = read('robots.txt')
check('robots.txt exists and lets pages, styles and scripts be fetched',
      'User-agent: *' in robots and not re.search(r'^Disallow:\s*/(src|icons|app|demo)?/?\s*$', robots, re.M))
listed_pages = [address for _, address, listed, _ in stamp_pages.PAGES if listed]
if cfg['domain']:
    base = f'https://{cfg["domain"]}'
    check('robots.txt says where the sitemap is', f'Sitemap: {base}/sitemap.xml' in robots)
    locs = re.findall(r'<loc>([^<]+)</loc>', read('sitemap.xml'))
    check('sitemap.xml lists exactly the pages meant to be found', locs == [base + a for a in listed_pages], f'it lists {locs}')
else:
    check('sitemap.xml waits for an address (site.domain is empty)', not (ROOT / 'sitemap.xml').is_file())

# ---- what the pages say is in the HTML that is served
for name in PUBLIC_PAGES:
    html = read(name)
    main = html[html.find('<main'):html.find('</main>')]
    empty = re.findall(r'<(\w+)\b[^<>]*\sdata-site="(operator|updated|contact)"[^<>]*></\1>', html)
    check(f'{name}: who runs the site and when it changed are written in the page', not empty, f'empty: {[e[1] for e in empty]}')
    unnamed = re.findall(r'<(?:h2|h3|summary)(?![^>]*\sid=)[^>]*>', main)
    check(f'{name}: every heading and question has an id to link to', not unnamed, f'{len(unnamed)} without one')
    words = re.sub(r'\s+', '', re.sub(r'<!--.*?-->|<[^>]+>', '', main, flags=re.S))
    check(f'{name}: its text does not wait for a script', len(words) > 200, f'only {len(words)} characters of text in <main>')
    seen_ids = re.findall(r'\sid="([^"]+)"', re.sub(r'<!--.*?-->', '', html, flags=re.S))
    twice = sorted({i for i in seen_ids if seen_ids.count(i) > 1})
    check(f'{name}: no id is used twice', not twice, ', '.join(twice))
for name in ('app.html', 'demo.html'):
    check(f'{name} says what to do when scripts are off', '<noscript>' in read(name) and 'needs JavaScript' in read(name))

# ---- every link goes somewhere
ids = {name: set(re.findall(r'\sid="([^"]+)"', read(name))) for name in PAGES}
CLEAN = {address: name for name, address, *_ in stamp_pages.PAGES if address}
broken = []
for name in PAGES:
    html = read(name)
    for href in re.findall(r'<a\b[^>]*\shref="([^"]+)"', html):
        if re.match(r'(https?:|mailto:|tel:)', href):
            continue
        path, _, frag = href.partition('#')
        if path in ('', ):
            target = name
        elif path in ('./', '/'):
            target = 'index.html'
        else:
            target = path.lstrip('/')
            target = CLEAN.get('/' + target.rstrip('/'), target)      # /privacy is privacy.html
        if target not in PAGES:
            broken.append(f'{name}: {href} (no such page)')
        elif frag and frag not in ids[target]:
            broken.append(f'{name}: {href} (nothing on {target} is called #{frag})')
    for tag, ref in re.findall(r'(<(?:link|script|img|iframe)\b[^>]*\s(?:href|src)="([^"]+)")', html):
        # A canonical link names an address, not a file; it has its own check above.
        if re.match(r'(https?:|data:)', ref) or 'rel="canonical"' in tag:
            continue
        if not (ROOT / ref.split('?')[0].lstrip('/')).is_file():
            broken.append(f'{name}: {ref} (file not found)')
check('Every link and every file a page asks for exists', not broken, '; '.join(broken[:6]))

# A page can be served at an address with a slash on the end (/privacy/), and
# the 404 page at any depth at all. Addresses that start at the root work from
# anywhere; ones written relative to the page do not.
for name in PAGES:
    relative = re.findall(r'\s(?:href|src)="(?!/|#|https?:|mailto:|data:)([^"]+)"', read(name))
    check(f'{name} reaches its files and links from the root of the site', not relative, ', '.join(relative[:5]))

# ---- the pieces a visitor is meant to find
home = read('index.html')
hero = home[home.find('<div class="hero">'):home.find('<section')]
hero_links = re.findall(r'<a\b[^>]*>', hero)
check('The homepage has its main button in the first screenful',
      any('primary' in a and re.search(r'href="/?app(\.html)?"', a) for a in hero_links))
site_js = without_comments(read('site.js'))
check('The homepage keeps its buttons in reach on a phone',
      bool(re.search(r'<div\b[^>]*data-cta-bar', home)) and 'function initCtaBar' in site_js and re.search(r'^initCtaBar\(\);', site_js, re.M) is not None)
faq = (re.search(r'<div class="faq-list">(.*?)</section>', home, re.S) or [None, ''])[1]
questions = len(re.findall(r'<details\b[^>]*>\s*<summary\b', faq))
check('The homepage answers at least five questions', questions >= 5, f'{questions} found')
check('The storage notice is written in every public page, not added by a script',
      all(re.search(r'<aside\b[^>]*data-notice[^>]*\shidden', read(name)) for name in PUBLIC_PAGES) and 'createElement(\'aside\')' not in site_js)
example = home[home.find('<section id="example">'):]
example = example[:example.find('</section>')]
check('The worked example says plainly that the student is made up', 'made up' in example and 'demo' in example)
for name, trail in (('privacy.html', 2), ('terms.html', 2), ('contact.html', 2), ('thanks.html', 3)):
    crumbs = re.search(r'<nav class="crumbs" aria-label="Breadcrumb">(.*?)</nav>', read(name), re.S)
    check(f'{name} has breadcrumbs', bool(crumbs) and crumbs.group(1).count('<li>') == trail and crumbs.group(1).count('aria-current="page"') == 1)

form = (re.search(r'<form\b[^>]*data-enquiry[^>]*>.*?</form>', read('contact.html'), re.S) or [''])[0]
opening = form[:form.find('>') + 1]
check('The contact form is one Netlify can receive',
      all(bit in opening for bit in ('name="contact"', 'method="POST"', 'action="/thanks"', 'data-netlify="true"', 'data-netlify-honeypot="bot-field"'))
      and '<input type="hidden" name="form-name" value="contact">' in form and 'name="bot-field"' in form)
fields = re.findall(r'<(?:input|textarea|select)\b(?![^>]*type="hidden")(?![^>]*name="bot-field")[^>]*>', form)
field_id = lambda tag: (re.search(r'\sid="([^"]+)"', tag) or [None, None])[1]
unlabelled = [f[:60] for f in fields if not field_id(f) or f'<label for="{field_id(f)}">' not in form]
check('Every field on the contact form has a label', bool(fields) and not unlabelled, f'without one: {unlabelled}')
check('What the contact form says when sending fails is written in the page',
      bool(re.search(r'<p\b[^>]*data-form-error[^>]*>\s*[A-Za-z]', form)))
check('The form lands on a thank-you page that exists', (ROOT / 'thanks.html').is_file() and 'from = "/thanks"' in read('netlify.toml'))

foot = lambda name: re.findall(r'href="/?([^"]*)"', (re.search(r'<nav class="foot-links"[^>]*>(.*?)</nav>', read(name), re.S) or ['', ''])[1])
check('Every public page ends with the same links', all(foot(name) == foot('index.html') and len(foot(name)) == 5 for name in PUBLIC_PAGES),
      '; '.join(f'{name}: {foot(name)}' for name in PUBLIC_PAGES if foot(name) != foot('index.html')))

# ------------------------------------------------------------- the database
# Accounts and saved plans live in a Supabase project. Nothing here talks to
# it; these compare what the app asks the database for with what
# supabase/schema.sql sets up, because the file takes away every default
# grant, and a table it does not give back answers "permission denied".
key = field('supabaseKey')
check('Supabase is set up completely or not at all', bool(field('supabaseUrl')) == bool(key),
      'src/config.js has one of supabaseUrl and supabaseKey but not the other')
# A local test address (the mock server, or anything not https) would ship a
# site whose sign-in goes nowhere. scripts/devserver.py --mock swaps the
# project in memory, so config.js never needs to point anywhere else.
check('Supabase points at a real project, not a test server',
      not field('supabaseUrl') or bool(re.match(r'^https://[a-z0-9-]+\.supabase\.co/?$', field('supabaseUrl'))) and 'mock' not in key,
      'supabaseUrl in src/config.js must be https://<project>.supabase.co (a test value was left in)')
toml_text = read('netlify.toml')
csp = re.search(r'Content-Security-Policy = "([^"]*)"', toml_text)
csp = csp.group(1) if csp else ''
check('The site sends a Content-Security-Policy that only runs its own scripts',
      "script-src 'self'" in csp and "object-src 'none'" in csp and 'frame-ancestors' in csp and 'unsafe-eval' not in csp
      and not re.search(r"script-src[^;]*'unsafe-inline'", csp),
      "netlify.toml needs Content-Security-Policy with script-src 'self', object-src 'none' and frame-ancestors, and no unsafe-inline or unsafe-eval for scripts")
check('The Content-Security-Policy lets the app reach the Supabase project in src/config.js',
      not field('supabaseUrl') or field('supabaseUrl').rstrip('/') in csp,
      'connect-src in netlify.toml must name supabaseUrl from src/config.js, or sign-in and saving are blocked in the browser')
pages_with_inline = [p.name for p in Path(ROOT).glob('*.html')
                     if re.search(r'<script(?![^>]*\bsrc=)(?![^>]*application/ld\+json)[^>]*>', p.read_text())
                     or re.search(r'\son[a-z]+="', p.read_text())]
check('No page has an inline script or inline event handler (the Content-Security-Policy would block it)', not pages_with_inline,
      'Move these into a .js file: ' + ', '.join(pages_with_inline))
check('The Supabase key in src/config.js is the public one', not stamp_pages.is_secret_key(key),
      'supabaseKey is a secret or service_role key. Take it out, and rotate it in Supabase: it has been in a file')

schema = without_comments(re.sub(r'--[^\n]*', '', read('supabase/schema.sql')))
tables = set(re.findall(r'create table if not exists (\w+)', schema)) | set(re.findall(r'create or replace view (\w+)', schema))
granted, granted_columns, granted_table_wide = {}, {}, {}
for actions, names in re.findall(r'grant ((?:select|insert|update|delete|\([^)]*\)|[ ,])+?) on ([\w, \n]+?) to authenticated;', schema):
    for name in re.findall(r'\w+', names):
        granted.setdefault(name, set()).update(re.findall(r'select|insert|update|delete', actions))
        granted_table_wide.setdefault(name, set()).update(re.findall(r'(select|insert|update|delete)(?! \()', actions))
        for action, columns in re.findall(r'(select|insert|update|delete) \(([^)]*)\)', actions):
            granted_columns.setdefault((name, action), set()).update(re.findall(r'\w+', columns))
# What points at what, to tell whether a request that reads two tables at once
# says clearly enough which link between them it means.
table_bodies = dict(re.findall(r'create table if not exists (\w+) \((.*?)\n\);', schema, re.S))
foreign = {t: dict(re.findall(r'^\s*(\w+) \w+[^,\n]*?\breferences (?:auth\.)?(\w+)', body, re.M)) for t, body in table_bodies.items()}
primary = {}
for t, body in table_bodies.items():
    composite = re.search(r'primary key \(([^)]*)\)', body)
    primary[t] = set(re.findall(r'\w+', composite.group(1))) if composite else set(re.findall(r'^\s*(\w+) [^,\n]*\bprimary key', body, re.M))


def links_between(a, b):
    """Every way the API could join table a to table b: a column of one that
    points at the other, or a third table whose key points at both."""
    direct = [f'{a}_{c}_fkey' for c, to in foreign.get(a, {}).items() if to == b] + [f'{b}_{c}_fkey' for c, to in foreign.get(b, {}).items() if to == a]
    through = [j for j in table_bodies if j not in (a, b)
               and any(to == a and c in primary[j] for c, to in foreign[j].items())
               and any(to == b and c in primary[j] for c, to in foreign[j].items())]
    return direct, through


functions = set(re.findall(r'create or replace function (\w+)\(', schema))
runnable = set()
for names in re.findall(r'grant execute on function([^;]+?)to (?:anon, )?authenticated;', schema, re.S):
    runnable |= set(re.findall(r'(\w+)\(', names))

app_js = ''.join(without_comments(p.read_text(encoding='utf-8')) for p in shipped_js())
asked = set(re.findall(r'''rest\(\s*[`'"]([a-z_]+)''', app_js)) - {'rpc'}
called = set(re.findall(r'''rpc\(\s*['"]([a-z_]+)['"]''', app_js)) | set(re.findall(r'rpc/([a-z_]+)', app_js))
NEEDS = {'GET': 'select', 'POST': 'insert', 'PATCH': 'update', 'DELETE': 'delete'}

missing = sorted(t for t in asked if t not in tables)
check('Every table the app asks for is made in supabase/schema.sql', not missing, ', '.join(missing))


def calls_to_the_database(source):
    """Each rest('table...', {...}) in the app, as (table, the whole call)."""
    for found in re.finditer(r'''rest\(\s*[`'"]([a-z_]+)''', source):
        depth, at = 0, found.start() + len('rest')
        while at < len(source):
            depth += source[at] == '('
            depth -= source[at] == ')'
            at += 1
            if depth == 0:
                break
        if found.group(1) != 'rpc':
            yield found.group(1), source[found.start():at]


def top_level_parts(text):
    """Split an object literal's inside at the commas between its fields, not
    the ones inside calls such as slice(0, 200) or quoted text."""
    parts, depth, quote, start = [], 0, '', 0
    for i, ch in enumerate(text):
        if quote:
            quote = '' if ch == quote and text[i - 1] != '\\' else quote
        elif ch in '\'"`':
            quote = ch
        elif ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        elif ch == ',' and depth == 0:
            parts.append(text[start:i]); start = i + 1
    return parts + [text[start:]]


refused, unclear = [], []
for table, call in calls_to_the_database(app_js):
    if table not in tables:
        continue
    method = (re.search(r"method:\s*'(\w+)'", call) or [None, 'GET'])[1]
    needs = {NEEDS[method]}
    if method == 'GET' or 'return=representation' in call or (method in ('PATCH', 'DELETE') and '?' in call):
        needs.add('select')                                # reading back, or finding the row by a filter
    if 'merge-duplicates' in call:
        needs.add('update')                                # an upsert writes over the row when it exists
    for action in sorted(needs - granted.get(table, set())):
        refused.append(f'{method} {table} needs {action}')
    body = re.search(r'body:\s*\{([^{}]*)\}', call)
    sent = {m.group(1) for part in top_level_parts(body.group(1)) if (m := re.match(r'\s*(\w+)', part))} if body else set()
    action = NEEDS[method]
    only = granted_columns.get((table, action))
    if action in ('insert', 'update') and only is not None and action not in granted_table_wide.get(table, set()):
        refused += [f'{method} {table} sets {c}, which is not granted' for c in sorted(sent - only)]
    # Tables read along with this one: select=...,other(...) or name:other!link(...)
    for other, hint in re.findall(r'[,=](?:\w+:)?(\w+)(?:!(\w+))?\(', (re.search(r'select=([^&`\'"]*)', call) or [None, ''])[1]):
        if 'select' not in granted.get(other, set()):
            refused.append(f'{table} reads {other}, which is not granted')
        direct, through = links_between(table, other)
        if hint and hint not in direct:
            unclear.append(f'{table} to {other}: no link called {hint}')
        if not hint and len(direct) + len(through) != 1:
            unclear.append(f'{table} to {other}: {len(direct) + len(through)} links ({", ".join(direct + through)}), name one')
# A grant lets a request reach a table; a policy has to let it touch rows too,
# or a delete or update quietly changes nothing.
POLICY_FOR = {'select': 'select', 'insert': 'insert', 'update': 'update', 'delete': 'delete'}
permissive = {(t, cmd) for t, cmd in re.findall(r'create policy "[^"]+" on (\w+) (?!as restrictive)(?:to \w+ )?for (\w+)', schema)}
no_policy = sorted({f'{method} {table}' for table, call in calls_to_the_database(app_js) if table in tables
                    for method in [(re.search(r"method:\s*'(\w+)'", call) or [None, 'GET'])[1]]
                    if table not in ('partner_overview',) and (table, NEEDS[method]) not in permissive and (table, 'all') not in permissive})
check('Every request the app makes has a policy that lets it change or see rows', not no_policy, '; '.join(no_policy[:5]))
check('Every request the app makes is one the database grants', not refused and any(True for _ in calls_to_the_database(app_js)), '; '.join(refused[:5]))
check('Every request that reads two tables says which link joins them', not unclear, '; '.join(unclear[:5]))
hidden_tables = {'agent_usage', 'visit_counts'}
exposed = sorted(t for t in hidden_tables if t in granted)
check('The two counting tables are granted to nobody', not exposed and hidden_tables <= tables, ', '.join(exposed))
to_anyone = [' '.join(g.split()) for g in re.findall(r'grant [^;]*\bto\b[^;]*\banon\b[^;]*;', schema)]
ALLOWED_TO_ANYONE = {'grant usage on schema public to anon, authenticated;', 'grant execute on function count_visit(text, text, text) to anon, authenticated;'}
check('Nothing in the database is granted to people who are not signed in, except the visit counter',
      set(to_anyone) == ALLOWED_TO_ANYONE, '; '.join(g for g in to_anyone if g not in ALLOWED_TO_ANYONE))
uncalled = sorted(f for f in called if f not in functions or f not in runnable)
check('Every database function the app calls exists and may be run', not uncalled, ', '.join(uncalled))
policies = re.findall(r'create policy ("[^"]+") on (\w+)', schema)
not_dropped = [f'{n} on {t}' for n, t in policies if f'drop policy if exists {n} on {t};' not in schema]
check('supabase/schema.sql can be run a second time', bool(policies) and not not_dropped and 'create table if not exists' in schema
      and not re.search(r'^\s*create (?!or replace |table if not exists |index if not exists |extension if not exists |policy |trigger )\w', schema, re.M)
      and 'drop trigger if exists on_auth_user_created on auth.users;' in schema
      and all(f'drop constraint if exists {c};' in schema.split(f'add constraint {c} ')[0] for c in re.findall(r'add constraint (\w+) ', schema)),
      '; '.join(not_dropped[:4]) or 'something is created without "if not exists" or "or replace"')
self_reading = sorted({f'{name} on {table}' for name, table, body in re.findall(r'create policy ("[^"]+") on (\w+)(.*?);', schema, re.S)
                       if re.search(rf'\bfrom {table}\b', body)})
check('No policy reads its own table (Postgres refuses every request to such a table)', not self_reading, '; '.join(self_reading))
undropped_triggers = [f'{name} on {table}' for name, table in re.findall(r'create trigger (\w+) (?:before|after) \w+ on ([\w.]+)', schema)
                      if f'drop trigger if exists {name} on {table};' not in schema]
check('Every trigger is dropped before it is made, so the file runs twice', not undropped_triggers, ', '.join(undropped_triggers))
unprotected = sorted(t for t in re.findall(r'create table if not exists (\w+)', schema) if f'alter table {t} enable row level security;' not in schema)
check('Every table has row level security switched on', not unprotected, ', '.join(unprotected))
open_to_anonymous = sorted(t for t in re.findall(r'create table if not exists (\w+)', schema)
                           if t in granted and f'create policy "not for anonymous accounts" on {t} as restrictive' not in schema)
check('Hidden anonymous accounts can reach no table the app uses', not open_to_anonymous, ', '.join(open_to_anonymous))
check('A profile row is made with every account', 'after insert on auth.users' in schema and 'handle_new_user' in schema)
for fn in ('netlify/functions/agent.mjs', 'netlify/functions/visit.mjs'):
    check(f'{fn} reads the key under its new name and its old one', 'process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY' in read(fn))

# ------------------------------------------------------------ the assistant
# The server function can send what students type to Google (Gemini) or
# Anthropic (Claude). The privacy page has to say so, and the Gemini path has
# to stay off until the owner says billing is on: the privacy page promises
# Google's paid terms, under which students' messages are not used to improve
# Google's products.
agent_fn = read('netlify/functions/agent.mjs')
privacy_text = read('privacy.html')
says_who = {
    'Google': 'generativelanguage.googleapis.com' in read('src/lib/gemini.js'),
    'Anthropic': 'api.anthropic.com' in read('src/lib/agentspec.js'),
}
model_of = {'Google': 'Gemini', 'Anthropic': 'Claude'}
unnamed = [who for who, used in says_who.items() if used and not (
    f'{model_of[who]}, an AI model made by {who}' in privacy_text
    and re.search(rf'<tr><td>{who}</td><td>[^<]*\bassistant\b', privacy_text, re.I))]
check('The privacy page names both companies the assistant can send messages to', not unnamed,
      'missing the sentence or the row in the table of companies for: ' + ', '.join(unnamed))
check('The Gemini assistant stays off until the plan is chosen and the privacy page says what that means',
      "process.env.GEMINI_TIER" in agent_fn and re.search(r"gemini \? \(tier === 'free' \|\| tier === 'paid' \? 'gemini' : null\)", agent_fn) is not None
      and 'may read it' in privacy_text)

# ------------------------------------------------------------------ secrets
secret = re.compile(r'sk-ant-[A-Za-z0-9_-]{8,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|service_role|sb_secret_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]*|AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{30,}|GOCSPX-[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY')
leaks = []
for p in list(ROOT.rglob('*')):
    if not p.is_file() or '.git' in p.parts or p.suffix in ('.png', '.ico', '.zip') or p.name == 'prelaunch_check.py':
        continue
    try:
        text = p.read_text(encoding='utf-8')
    except (UnicodeDecodeError, OSError):
        continue
    for m in secret.finditer(text):
        # schema.sql and the config comment mention service_role in order to warn against it.
        if m.group(0) == 'service_role' and p.name in ('schema.sql', 'config.js', 'README.md', 'LAUNCH.md'):
            continue
        # The older kind of Supabase key is a token. The public one ("anon") is
        # meant to be in src/config.js; any other token, anywhere, is a leak.
        if m.group(0).startswith('eyJ') and p.name == 'config.js' and not stamp_pages.is_secret_key(m.group(0)):
            continue
        leaks.append(f'{p.relative_to(ROOT)}: {m.group(0)[:16]}')
check('Nothing that looks like a secret is committed', not leaks, '; '.join(leaks[:4]))

check('The service worker only removes itself', 'unregister()' in read('sw.js') and 'caches.open' not in read('sw.js'))
check('No page registers a service worker', not any('serviceWorker.register' in t for t in everything.values()))

# ------------------------------------------------------------------- report
width = max(len(n) for n, _, _ in results)
failed = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}" + (f'\n          {detail}' if detail and not ok else ''))
print()
print(f'{len(results) - len(failed)} of {len(results)} checks pass.' + ('' if not failed else f' {len(failed)} to fix before launch.'))
sys.exit(1 if failed else 0)
