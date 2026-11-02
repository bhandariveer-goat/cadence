#!/usr/bin/env python3
"""Does what Cadence says about itself match what the code does?

    python3 scripts/claims_check.py              check every claim, exit 1 if any fails
    python3 scripts/claims_check.py --markdown   rewrite CLAIMS.md (the claim-to-code table)
    python3 scripts/claims_check.py --accept     record the data surface after a reviewed change
    python3 scripts/claims_check.py --selftest   break things on purpose and check this catches them

Each claim in CLAIMS below pairs a sentence a person can read on a public page
with the code that has to make it true. A claim fails when either side moves:
the sentence is reworded or removed, or the code stops doing what it promised.
So a privacy promise cannot quietly become false, and a change to the code
cannot go through without someone looking at the sentence it backs.

A second check watches what Cadence collects. It fingerprints the data surface
(the browser storage keys, the outside hosts the code talks to, the database
tables, and the part of the plan that is copied to an account) and compares it
with claims.lock.json. If the surface changes, the check fails until the
privacy page's own date is changed too and --accept is run, in the same commit.

Nothing here touches the network. It reads the files that would be deployed.
"""
import hashlib
import html
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


# ---------------------------------------------------------------- reading files

def read(root, rel):
    p = root / rel
    return p.read_text(encoding='utf-8') if p.is_file() else ''


def js_code(text):
    """JavaScript with comments removed, so only code and strings are judged."""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('//') or s.startswith('*'):
            continue
        out.append(re.sub(r'(?<![:\'"`\\])//(?!/).*$', '', line))
    return '\n'.join(out)


def sql_code(text):
    """SQL with -- comments removed."""
    return '\n'.join(re.sub(r'--.*$', '', ln) for ln in text.splitlines())


def code(root, rel):
    text = read(root, rel)
    return sql_code(text) if rel.endswith('.sql') else js_code(text) if rel.endswith(('.js', '.mjs')) else text


def shipped(root):
    """Every file the browser or a server function runs, as paths relative to the root."""
    files = sorted(p.relative_to(root).as_posix() for p in (root / 'src').rglob('*.js'))
    files += ['site.js', 'sw.js'] if (root / 'site.js').is_file() else []
    files += sorted(p.relative_to(root).as_posix() for p in (root / 'netlify').rglob('*.mjs'))
    return files


def page_text(root, rel):
    """What a visitor reads on a page: the text of <main>, with comments and tags gone."""
    s = read(root, rel)
    m = re.search(r'<main.*?</main>', s, re.S)
    s = m.group(0) if m else s
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    s = re.sub(r'</(p|li|tr|h\d|div|td|th)>', ' ', s)
    s = re.sub(r'<[^>]+>', '', s)
    s = html.unescape(s)
    return plain(s)


def plain(s):
    """Straight quotes, single spaces, lower case: so wording is compared, not typography."""
    s = s.replace('‘', "'").replace('’', "'").replace('“', '"').replace('”', '"')
    return re.sub(r'\s+', ' ', s).strip().lower()


# ----------------------------------------------------------------- proof helpers
# A proof is a function (root) -> None when it holds, or a short reason when it does not.

def has(rel, pattern, why=None):
    def proof(root):
        if not re.search(pattern, code(root, rel), re.S):
            return why or f'{rel} no longer matches /{pattern}/'
    proof.shows = f'{rel}: {why_text(pattern)}'
    return proof


def lacks(files, pattern, why=None):
    """No file in `files` (a list of paths, or 'shipped' for all of them) matches the pattern."""
    def proof(root):
        for rel in (shipped(root) if files == 'shipped' else files):
            m = re.search(pattern, code(root, rel), re.S)
            if m:
                return why or f'{rel} contains "{m.group(0)[:60]}"'
    proof.shows = f'{"every script" if files == "shipped" else ", ".join(files)}: never {why_text(pattern)}'
    return proof


def before(rel, first, second, why):
    """In one file, `first` appears and comes earlier than `second`."""
    def proof(root):
        t = code(root, rel)
        a, b = re.search(first, t, re.S), re.search(second, t, re.S)
        if not a or not b or a.start() > b.start():
            return why
    proof.shows = f'{rel}: {why}'
    return proof


def check_fn(shows, fn):
    fn.shows = shows
    return fn


def why_text(pattern):
    return re.sub(r'\\(.)', r'\1', pattern)[:70]


# --------------------------------------------------------------- schema reading

def tables(root):
    """{table name: its create table body} from supabase/schema.sql."""
    sql = code(root, 'supabase/schema.sql')
    return {m.group(1): m.group(2) for m in re.finditer(r'create table if not exists (\w+) \((.*?)\n\);', sql, re.S)}


def proof_rls(root):
    sql = code(root, 'supabase/schema.sql')
    missing = [t for t in tables(root) if not re.search(rf'alter table {t} enable row level security', sql)]
    if missing:
        return 'row level security is not switched on for: ' + ', '.join(missing)
proof_rls.shows = 'supabase/schema.sql: every table has row level security switched on'

# Tables that hold something a person made or did, and so must go with the account.
ERASED_WITH_ACCOUNT = ['profiles', 'partnerships', 'invites', 'club_members', 'checkins', 'kudos', 'nudges', 'club_posts', 'planner_state']


def proof_cascade(root):
    t = tables(root)
    bad = []
    for name in ERASED_WITH_ACCOUNT:
        body = t.get(name)
        if body is None:
            bad.append(f'{name} (table not found)')
        elif not re.search(r'references (auth\.users|profiles) on delete cascade', body):
            bad.append(name)
    if bad:
        return 'these do not cascade when an account is deleted: ' + ', '.join(bad)
proof_cascade.shows = 'supabase/schema.sql: the plan, check-ins, partnerships, clubs and invites all cascade from the account'


def proof_usage_count_removal(root):
    m = re.search(r'delete from agent_usage where day < today - (\d+)', code(root, 'supabase/schema.sql'))
    if not m:
        return 'the daily request count is no longer removed by bump_agent_usage()'
    if int(m.group(1)) > 2:
        return f'old counts are kept {m.group(1)} days, but the page says "a couple of days"'
proof_usage_count_removal.shows = 'supabase/schema.sql: old daily counts are deleted once they are over a day old (page says "a couple of days")'


def proof_usage_survives_deletion(root):
    body = tables(root).get('agent_usage', '')
    if not body or 'references' in body:
        return 'the daily count now disappears with the account, but the page says it does not'
proof_usage_survives_deletion.shows = 'supabase/schema.sql: the daily count has no link to the account, so deleting the account leaves it until it is cleaned up'


def proof_usage_has_no_identity(root):
    body = tables(root).get('agent_usage', '')
    if not body or re.search(r'\b(email|name)\b', body):
        return 'agent_usage holds more than an account ID, a day and counts'
proof_usage_has_no_identity.shows = 'supabase/schema.sql: the daily count table holds an account ID, a day and counts, no name or email'


def proof_agent_server_calls(root):
    t = code(root, 'netlify/functions/agent.mjs')
    paths = set(re.findall(r'\$\{supabaseUrl\}(/[\w/.?=&-]+)', t))
    allowed = {'/auth/v1/user', '/rest/v1/rpc/bump_agent_usage', '/rest/v1/rpc/refund_agent_usage'}
    extra = paths - allowed
    if extra or not paths:
        return f'the assistant function now calls the database at: {sorted(extra) or "nothing"}'
proof_agent_server_calls.shows = 'netlify/functions/agent.mjs: the only database calls are who-is-this, count a request, refund a request'


def proof_feed_server_calls(root):
    t = code(root, 'netlify/functions/canvas-feed.mjs')
    paths = set(re.findall(r'\$\{supabaseUrl\}(/[\w/.?=&-]+)', t))
    if paths != {'/auth/v1/user'}:
        return f'the calendar function now calls the database at: {sorted(paths)}'
proof_feed_server_calls.shows = 'netlify/functions/canvas-feed.mjs: the only database call is who-is-this'


def proof_delete_order(root):
    t = code(root, 'src/panel/views/account.js')
    m = re.search(r'async function deleteFlow\(\)(.*?)\n}(?:\n|$)', t, re.S)
    body = m.group(1) if m else ''
    server = body.find('rpc/delete_my_account')
    refused = body.find('Nothing was deleted')
    wipe = body.find('signOut({ wipe: true, force: true })')
    if min(server, refused, wipe) < 0 or not (server < refused < wipe):
        return 'deleteFlow no longer deletes on the server first, says "Nothing was deleted" on failure, and only then wipes this browser'
proof_delete_order.shows = 'src/panel/views/account.js: delete on the server first; on failure say "Nothing was deleted" and stop; only then wipe this browser'


def proof_delete_account_sql(root):
    m = re.search(r'create or replace function delete_my_account\(\).*?end \$\$;', code(root, 'supabase/schema.sql'), re.S)
    if not m or 'delete from auth.users where id = auth.uid()' not in m.group(0):
        return 'delete_my_account() no longer deletes the signed-in account'
proof_delete_account_sql.shows = 'supabase/schema.sql: delete_my_account() deletes the signed-in account and nothing else'


def proof_google_writes_own(root):
    t = code(root, 'src/lib/sources/googleCalendar.js')
    own = re.search(r'async function listOwnBlocks.*?privateExtendedProperty', t, re.S)
    recon = re.search(r'async function reconcileBlocks.*?\n}(?:\n|$)', t, re.S)
    remove = re.search(r'async function removeAllBlocks.*?\n}(?:\n|$)', t, re.S)
    callers = len(re.findall(r'(?<!function )\b(deleteBlock|updateBlock)\(', t))
    ok = own and recon and remove and 'listOwnBlocks(' in recon.group(0) and 'listOwnBlocks(' in remove.group(0) and callers == 3
    if not ok:
        return 'Google events are no longer changed only through the list of Cadence\'s own tagged events'
proof_google_writes_own.shows = 'src/lib/sources/googleCalendar.js: edits and deletes only reach events found by Cadence\'s own tag'


def proof_calendar_link_not_synced(root):
    t = code(root, 'src/lib/cloud.js')
    m = re.search(r'export function portable\(state\) \{(.*?)\n\}', t, re.S)
    body = m.group(1) if m else ''
    needed = ['delete out.cloud', 'delete out.settings.apiKey', 'out.sources = structuredClone(DEFAULT_STATE.sources)', 'delete t.guideData']
    gone = [n for n in needed if n not in body]
    if gone:
        return 'portable() no longer drops: ' + ', '.join(gone)
    if len(re.findall(r'portable\(', t + code(root, 'src/panel/views/account.js'))) < 3:
        return 'the saved copy is no longer built with portable()'
proof_calendar_link_not_synced.shows = 'src/lib/cloud.js: portable() drops the session, the AI key and the calendar connections before anything is saved to an account'


def proof_visits_off(root):
    cfg = re.search(r'countVisits:\s*(true|false)', code(root, 'src/config.js'))
    if not cfg or cfg.group(1) != 'false':
        return 'visit counting is on in src/config.js, but the page says labels are not recorded'
    if not re.search(r'if \(!site\.countVisits', code(root, 'site.js')):
        return 'site.js no longer checks site.countVisits before counting'
proof_visits_off.shows = 'src/config.js and site.js: visit counting is off, and nothing is sent unless it is turned on'


def proof_no_third_party_scripts(root):
    for rel in ['index.html', 'contact.html', 'privacy.html', 'terms.html', 'thanks.html', '404.html', 'app.html', 'demo.html']:
        for src in re.findall(r'<script[^>]+src="([^"]+)"', read(root, rel)):
            if re.match(r'(https?:)?//', src):
                return f'{rel} loads a script from {src}'
    toml = read(root, 'netlify.toml')
    if "script-src 'self';" not in toml:
        return "the security policy no longer limits scripts to this site's own"
proof_no_third_party_scripts.shows = "every page and netlify.toml: scripts come from this site only (the security policy allows nothing else)"


def proof_connect_hosts(root):
    m = re.search(r"connect-src ([^;\"]+)", read(root, 'netlify.toml'))
    hosts = sorted(h for h in (m.group(1).split() if m else []) if h != "'self'")
    if len(hosts) != 2 or not any('supabase.co' in h for h in hosts) or 'https://api.anthropic.com' not in hosts:
        return f'the pages may now connect to: {hosts}'
proof_connect_hosts.shows = 'netlify.toml: pages may connect only to this site, the account database and Anthropic (for a key the person adds)'


def proof_key_stays_on_device(root):
    server = code(root, 'netlify/functions/agent.mjs')
    if re.search(r'req\.headers\.get\([\'"]x-api-key|body\.(apiKey|key)|settings\.apiKey', server):
        return "the assistant function now reads a key the person supplied"
    if 'process.env.ANTHROPIC_API_KEY' not in server:
        return "the assistant function no longer uses Cadence's own key"
    for rel in ['src/lib/agentllm.js', 'src/lib/ai.js']:
        if 'x-api-key' in code(root, rel) and not re.search(r'API_URL|api\.anthropic\.com', code(root, rel)):
            return f'{rel} sends the key somewhere other than Anthropic'
proof_key_stays_on_device.shows = "netlify/functions/agent.mjs and src/lib/agentllm.js: a person's own key goes from the browser to Anthropic; the server uses only its own"


def proof_memory_filter(root):
    t = code(root, 'src/lib/memory.js')
    m = re.search(r'const PRIVATE = (/.*?/i);', t)
    r = m.group(1) if m else ''
    for need, label in [('@', 'an email address'), (r'\d', 'a phone number'), ('https?', 'a link'), ('pass', 'a password')]:
        if need not in r:
            return f'the memory filter no longer refuses {label}'
    if 'PRIVATE.test(clean)' not in t:
        return 'the memory filter is no longer applied to saved notes'
proof_memory_filter.shows = 'src/lib/memory.js: a note that looks like an email, phone number, link or password is refused'


def proof_outline_answers(root):
    t = code(root, 'src/lib/outline.js')
    if not re.search(r'ANSWERISH\.test\(s\)', t) or not re.search(r'const ANSWERISH', t):
        return 'outline lines that read like answers are no longer dropped'
    if not re.search(r'budget', t):
        return 'the outline no longer has a total size limit'
proof_outline_answers.shows = 'src/lib/outline.js: lines that read like an answer are dropped and the whole outline has a size budget'


def proof_delete_wipes_browser(root):
    if 'signOut({ wipe: true, force: true })' not in code(root, 'src/panel/views/account.js'):
        return 'deleting no longer wipes this browser, chats included'
proof_delete_wipes_browser.shows = 'src/panel/views/account.js: deleting calls the same wipe as signing out'


def proof_sign_out_clears(root):
    t = code(root, 'src/panel/core.js')
    m = re.search(r'export async function signOut.*?\n}(?:\n|$)', t, re.S)
    body = m.group(0) if m else ''
    for need in ["'cadence.assistant-session'", "'cadence.pending-invite'", "'cadence.consented-at'", 'clearChats()']:
        if need not in body:
            return f'signing out no longer clears {need}'
proof_sign_out_clears.shows = 'src/panel/core.js: signing out clears the chats, the hidden account, a waiting invite and the terms agreement from this browser'


# ------------------------------------------------------------------------ claims
# id, a short name, what the page says ((page, phrase) pairs; each phrase must be on that page), and the proofs.
# Wording is compared after quotes and spacing are made plain, so a reworded sentence fails here.

PRIVACY = 'privacy.html'

CLAIMS = [
    ('password-never-handled', 'Cadence never sees or stores your password',
     [(PRIVACY, "your password goes from your browser straight to supabase"),
      (PRIVACY, "cadence's own server never receives it, and cadence never stores it")],
     [has('src/lib/cloud.js', r"authCall\('token\?grant_type=password', \{ email, password \}\)"),
      has('src/lib/cloud.js', r'/auth/v1/'),
      lacks(['netlify/functions/agent.mjs', 'netlify/functions/canvas-feed.mjs', 'netlify/functions/visit.mjs'], r'(?i)(?<![.\w])password',
            'a server function now handles a password'),
      lacks('shipped', r'(?:setItem|storage\.local\.set|persist)\([^)]*\bpassword\b',
            'the password is now written to storage'),
      lacks(['src/panel/views/signin.js'], r'\bS\.[\w.]*password|state\.[\w.]*password', 'the password is now kept in the plan')]),

    ('chats-stay-here', 'Chats with the assistant stay in this browser, never in the account',
     [(PRIVACY, 'chats are kept only in this browser, never in your account')],
     [has('src/lib/chats.js', r'localStorage\.setItem'),
      lacks(['src/lib/chats.js'], r'\b(fetch|rest|sendBeacon)\(', 'chats.js now makes network calls'),
      lacks(['src/lib/cloud.js', 'src/lib/sync.js'], r'(?i)chats', 'chats are now mentioned in the code that saves to an account')]),

    ('chats-thirty', 'Up to 30 chats are kept',
     [(PRIVACY, 'up to 30 chats')],
     [has('src/lib/chats.js', r'MAX_CHATS = 30;')]),

    ('chats-cleared', 'Chats are deleted when you sign out or delete your data',
     [(PRIVACY, 'until you delete them, sign out, or delete your data')],
     [proof_sign_out_clears, proof_delete_wipes_browser]),

    ('download-has-chats', 'Download my data includes the plan and the chats',
     [(PRIVACY, 'it saves your plan, the same copy that is saved to an account, and your chats with the assistant')],
     [has('src/panel/views/account.js', r'plan: portable\(app\.S\), assistantChats: exportChats\(\)')]),

    ('account-copy-leaves-out', "The account copy leaves out the AI key, calendar connections, calendar links and chats",
     [(PRIVACY, 'the copy leaves out your anthropic api key, your google calendar connection and its events, your calendar links, and your chats with the assistant')],
     [proof_calendar_link_not_synced]),

    ('memory-refuses-private', 'Notes that look like contact details or passwords are refused',
     [(PRIVACY, 'notes that look like an email address, a phone number, a link or a password are refused')],
     [proof_memory_filter]),

    ('memory-six-weeks', 'The record of how you work covers the last six weeks',
     [(PRIVACY, 'a record from the last six weeks')],
     [has('src/lib/memory.js', r'keepDays: 42\b')]),

    ('invite-two-weeks', 'A waiting invite is kept for up to two weeks',
     [(PRIVACY, 'for up to two weeks')],
     [has('src/panel/core.js', r'Date\.now\(\) - v\.at > 14 \* DAY')]),

    ('calendar-keeps-nothing', "Cadence's server hands a calendar back and keeps nothing",
     [(PRIVACY, "cadence's server, which fetches your calendar from canvas, hands it straight back to your browser, and keeps neither")],
     [has('netlify/functions/canvas-feed.mjs', r"'cache-control': 'no-store'"),
      lacks(['netlify/functions/canvas-feed.mjs'], r'console\.|writeFile|getStore|blobs|localStorage|rest/v1', 'the calendar function now logs or stores something'),
      check_fn(proof_feed_server_calls.shows, proof_feed_server_calls)]),

    ('free-events-left-out', 'Events marked free are left out',
     [(PRIVACY, 'events marked free are left out')],
     [has('src/lib/sources/googleCalendar.js', r"ev\.transparency === 'transparent'"),
      has('src/lib/sources/sources.js', r'!e\.transparent')]),

    ('google-only-own-events', 'Cadence never edits or deletes a Google event it did not create',
     [(PRIVACY, 'never edits or deletes any event it did not create')],
     [proof_google_writes_own]),

    ('ai-sees-no-google-titles', 'Events from Google, Outlook and iCloud reach the AI model as a time with no title',
     [(PRIVACY, 'events that came from google calendar, either way, are passed on as a time with no title')],
     [has('src/lib/agentops.js', r"\['google', 'googleFeed', 'outlookFeed', 'icloudFeed'\]\.includes\(b\.source\) \? 'Busy' : b\.title")]),

    ('server-stores-no-messages', "Cadence's server does not store your messages or the replies",
     [(PRIVACY, "cadence's server does not store your messages or the replies")],
     [lacks(['netlify/functions/agent.mjs'], r'console\.|writeFile|getStore|blobs|rest/v1/(?!rpc/)', 'the assistant function now logs or stores something'),
      check_fn(proof_agent_server_calls.shows, proof_agent_server_calls)]),

    ('own-key-stays-on-device', 'Your own Anthropic key goes from your browser to Anthropic, never to Cadence',
     [(PRIVACY, 'with your own key, it goes straight from your browser to anthropic')],
     [proof_key_stays_on_device, proof_connect_hosts]),

    ('daily-limit-enforced', 'A daily limit on assistant requests is enforced in the database before any request is sent on',
     [(PRIVACY, 'only to enforce a daily limit')],
     [has('supabase/schema.sql', r'lim int := case when anon then \d+ else \d+ end'),
      before('netlify/functions/agent.mjs', r'rpc/bump_agent_usage', r'await fetch\(API_URL|await fetch\(geminiUrl',
             'the request is counted before it is sent to an AI model')]),

    ('usage-count-no-identity', 'The daily count is kept against an account ID, not a name or email',
     [(PRIVACY, 'it is stored against an account id, not your name or email')],
     [proof_usage_has_no_identity]),

    ('usage-count-removed', 'Old daily counts are deleted automatically, usually within a couple of days',
     [(PRIVACY, 'old counts are deleted automatically, usually within a couple of days'),
      (PRIVACY, 'deleting your account does not remove a count early')],
     [proof_usage_count_removal, proof_usage_survives_deletion]),

    ('hidden-account-30-days', 'A hidden account is removed after 30 days without use',
     [(PRIVACY, 'removed after 30 days without use')],
     [has('supabase/schema.sql', r"is_anonymous.*?interval '30 days'"),
      has('src/lib/cloud.js', r"post\('signup', \{ data: \{\} \}\)")]),

    ('delete-is-real', 'Deleting an account erases it on the server first, and says so when it cannot',
     [(PRIVACY, 'choose delete account. this erases your account, the saved plan, your check-ins, and your connections to partners and clubs'),
      (PRIVACY, 'it cannot be undone')],
     [proof_delete_order, proof_delete_account_sql, proof_cascade]),

    ('tables-protected', "Only you can read or change your plan: every table has row level security",
     [(PRIVACY, 'data in your account is protected by database rules: only you can read or change your plan')],
     [proof_rls,
      has('supabase/schema.sql', r'create policy[^;]*on planner_state[^;]*auth\.uid\(\)')]),

    ('no-cookies', 'Cadence does not set cookies',
     [(PRIVACY, 'cadence does not set cookies')],
     [lacks('shipped', r'document\.cookie\s*=(?!=)', 'a script now sets a cookie'),
      lacks(['netlify/functions/agent.mjs', 'netlify/functions/canvas-feed.mjs', 'netlify/functions/visit.mjs'], r'(?i)set-cookie', 'a server function now sets a cookie')]),

    ('no-ads-or-analytics', 'No ads, no analytics: no script on any page comes from anywhere else',
     [(PRIVACY, 'cadence does not share your data with anyone else, and does not use advertising or analytics services')],
     [check_fn(proof_no_third_party_scripts.shows, proof_no_third_party_scripts),
      lacks('shipped', r'(?i)gtag\(|google-analytics|googletagmanager|plausible\.io|mixpanel|segment\.com|hotjar|posthog|amplitude', 'an analytics service is now referenced')]),

    ('link-labels-removed', 'A shared-link label is removed from the address and not counted',
     [(PRIVACY, 'cadence removes that label from the address as soon as the page opens'),
      (PRIVACY, 'the label is not recorded or counted')],
     [has('site.js', r"startsWith\('utm_'\)"), has('site.js', r'history\.replaceState'), proof_visits_off]),

    ('canvas-no-token', 'The extension does not create a Canvas API token or receive a Canvas password',
     [(PRIVACY, 'does not receive your canvas password, does not create an api token')],
     [lacks(['src/content/content.js', 'src/lib/canvas.js', 'src/background/background.js'], r'access_tokens|/token\b|password', 'Canvas code now handles a token or password')]),

    ('mic-text-only', 'Speech is turned into text by the browser; Cadence receives only the text',
     [(PRIVACY, 'cadence receives only the text')],
     [lacks('shipped', r'getUserMedia|MediaRecorder', 'a script now records audio itself'),
      has('src/panel/views/agent.js', r'SpeechRecognition')]),

    ('contact-through-netlify', 'The contact form goes to Netlify and nowhere else',
     [(PRIVACY, 'the contact page has a form'),
      (PRIVACY, 'go to netlify, the company that hosts this site')],
     [check_fn('contact.html: the form is a Netlify form that posts to this site', lambda root: (
         None if 'data-netlify="true"' in read(root, 'contact.html') and re.search(r'<form[^>]+action="/thanks"', read(root, 'contact.html'))
         else 'the contact form no longer posts as a Netlify form'))]),

    ('home-table-matches', 'The homepage summary says the same things: no ads, nothing sold, chats stay here',
     [('index.html', "never sells or rents anything about you"),
      ('index.html', 'your chats stay in this browser until you delete them or sign out, never in your account')],
     [has('src/lib/chats.js', r'localStorage\.setItem'), proof_calendar_link_not_synced]),
]

# Things the privacy page says that no script here can check, listed so nobody
# mistakes the table above for proof of them.
NOT_CHECKED = [
    "What Google, Anthropic, Netlify, Supabase, Microsoft and Apple do with data once they have it (their own terms and privacy policies).",
    "That Supabase stores the password only as a hash. The script checks that Cadence never handles the password; the hashing is Supabase's, as its documentation says.",
    "That Netlify checks contact messages with Akismet, and what Supabase's sign-in log records.",
    "That the live Supabase project matches supabase/schema.sql. It was applied and compared by hand on the day it was last changed, and rolled-back tests were run against it; this script reads the file only.",
    "That deleting an account really empties the live database. The script checks the code path and that every table cascades. On 2 November 2026 a rolled-back run against the live project (two accounts, with a plan, check-ins, kudos, nudges, a partnership, an invite, and a club with a post) left none of the deleted account's rows, passed the club to the other member, and kept the other account's data. It is a one-off run, not repeated by this script.",
    "That browsers and extensions behave as the page describes (for example, Chrome sending speech to Google).",
]


# ------------------------------------------------------------------- running it

def run(root=ROOT):
    """Returns (rows, failures): rows are (id, name, says, proof shows), failures are strings."""
    pages = {}
    rows, failures = [], []
    for cid, name, says, proofs in CLAIMS:
        for page, phrase in says:
            pages.setdefault(page, page_text(root, page))
            if plain(phrase) not in pages[page]:
                failures.append(f'{cid}: {page} no longer says "{phrase}"')
        for proof in proofs:
            why = proof(root)
            if why:
                failures.append(f'{cid}: {why}')
        rows.append((cid, name, [p for _, p in says], [pr.shows for pr in proofs]))
    return rows, failures


# --------------------------------------------------------------- the data surface

STORAGE_KEY = re.compile(r"""['"`](cadence\.[A-Za-z0-9_.${}-]+)['"`]""")
HOST = re.compile(r'https://[a-z0-9.-]+\.[a-z]{2,}')


def surface(root):
    """Everything Cadence stores or talks to, as sorted lists that are easy to compare and to read in a diff."""
    keys, hosts = set(), set()
    for rel in shipped(root):
        t = code(root, rel)
        keys |= set(STORAGE_KEY.findall(t))
        hosts |= set(HOST.findall(t))
    toml = read(root, 'netlify.toml')
    m = re.search(r'connect-src ([^;"]+)', toml)
    hosts |= {h for h in (m.group(1).split() if m else []) if h.startswith('https://')}
    sql = code(root, 'supabase/schema.sql')
    defs = {k: re.sub(r'\s+', ' ', v).strip() for k, v in tables(root).items()}
    adds = sorted(re.sub(r'\s+', ' ', m.group(0)) for m in re.finditer(r'alter table \w+ add column[^;]*;', sql))
    t = code(root, 'src/lib/cloud.js')
    m = re.search(r'export function portable\(state\) \{(.*?)\n\}', t, re.S)
    return {
        'storage_keys': sorted(keys),
        'outside_hosts': sorted(hosts),
        'tables': defs,
        'added_columns': adds,
        'copied_to_account': re.sub(r'\s+', ' ', m.group(1)).strip() if m else '',
    }


def fingerprint(s):
    return hashlib.sha256(json.dumps(s, sort_keys=True).encode()).hexdigest()


def policy_date(root):
    m = re.search(r'<p class="updated">Last updated <time datetime="(\d{4}-\d{2}-\d{2})">', read(root, PRIVACY))
    return m.group(1) if m else ''


def lock_status(root=ROOT):
    """(ok, detail): does the data surface match the one the privacy page was last reviewed against?"""
    path = root / 'claims.lock.json'
    if not path.is_file():
        return False, 'claims.lock.json is missing. Run: python3 scripts/claims_check.py --accept'
    lock = json.loads(path.read_text())
    now = surface(root)
    if fingerprint(now) == lock.get('fingerprint'):
        return True, ''
    old = lock.get('surface', {})
    changes = []
    for key in now:
        a, b = old.get(key), now[key]
        if a == b:
            continue
        if isinstance(b, list):
            changes.append(f'{key}: added {sorted(set(b) - set(a or []))}, removed {sorted(set(a or []) - set(b))}')
        elif isinstance(b, dict):
            changes.append(f'{key}: added {sorted(set(b) - set(a or {}))}, removed {sorted(set(a or {}) - set(b))}, changed {sorted(k for k in b if k in (a or {}) and a[k] != b[k])}')
        else:
            changes.append(f'{key} changed')
    return False, ('what Cadence collects or talks to has changed since the privacy page was last reviewed: '
                   + '; '.join(changes)
                   + '. Update privacy.html (and change its date), then run: python3 scripts/claims_check.py --accept')


def accept(root=ROOT):
    """Record the current data surface. Refuses unless the privacy page's date was changed since the last record."""
    path = root / 'claims.lock.json'
    date = policy_date(root)
    if not date:
        return 'privacy.html has no "Last updated" date'
    ok, _ = lock_status(root)
    old = json.loads(path.read_text()) if path.is_file() else {}
    if not ok and old and old.get('policy_date') == date:
        return ('the data surface changed but the privacy page still has the date it had at the last review '
                f'({date}). Review privacy.html, change what it says and its date, then accept.')
    s = surface(root)
    path.write_text(json.dumps({'policy_date': date, 'fingerprint': fingerprint(s), 'surface': s}, indent=1, sort_keys=True) + '\n')
    return ''


# ------------------------------------------------------------------- CLAIMS.md

def markdown(rows):
    out = [
        '# What Cadence says, and the code that makes it true',
        '',
        'Generated by `python3 scripts/claims_check.py --markdown`. Do not edit by hand:',
        'the launch check fails if this file is out of date. Every row is checked by',
        '`scripts/claims_check.py`, which fails if the sentence on the page changes or the',
        'code stops doing what the sentence says.',
        '',
        '| Claim | What the page says | What the code must do |',
        '| --- | --- | --- |',
    ]
    for cid, name, says, shows in rows:
        out.append(f'| {name} | {"<br>".join("&ldquo;" + s.replace("|", "/") + "&rdquo;" for s in says)} | {"<br>".join(x.replace("|", "/") for x in shows)} |')
    out += [
        '',
        '## Said on the pages, but not checked by the script',
        '',
        *[f'- {n}' for n in NOT_CHECKED],
        '',
        '## What counts as the data surface',
        '',
        '`claims.lock.json` records the browser storage keys, the outside hosts, the database',
        'tables and the part of the plan copied to an account. Changing any of them fails the',
        'check until `privacy.html` and its date are updated and `--accept` is run in the same commit.',
        '',
    ]
    return '\n'.join(out)


# -------------------------------------------------------------------- self-test

def selftest():
    """Copy the site, break one thing at a time, and check the right claim fails."""
    need = ['privacy.html', 'index.html', 'contact.html', 'terms.html', 'thanks.html', '404.html', 'app.html', 'demo.html',
            'site.js', 'sw.js', 'netlify.toml', 'claims.lock.json', 'src', 'netlify', 'supabase']
    mutations = [
        ('a sentence on the privacy page is reworded', PRIVACY, 'Cadence does not set cookies', 'Cadence rarely sets cookies', 'no-cookies'),
        ('chats get sent to the account copy', 'src/lib/cloud.js', 'delete out.plan;', 'delete out.plan; out.chats = 1; // chats', 'chats-stay-here'),
        ('the password is logged on a server function', 'netlify/functions/agent.mjs', "const anthropic = process.env.ANTHROPIC_API_KEY;", "const anthropic = process.env.ANTHROPIC_API_KEY; const x = 'password';", 'password-never-handled'),
        ('deleting wipes the browser before the server', 'src/panel/views/account.js', "try { await app.cloud.rest('rpc/delete_my_account'", "await signOut({ wipe: true, force: true }); try { await app.cloud.rest('rpc/delete_my_account'", 'delete-is-real'),
        ('a table stops cascading on account deletion', 'supabase/schema.sql', 'user_id uuid not null references profiles on delete cascade default auth.uid(),\n  ', 'user_id uuid not null references profiles default auth.uid(),\n  ', 'delete-is-real'),
        ('an analytics script appears', 'index.html', '</head>', '<script src="https://stats.example.com/a.js"></script></head>', 'no-ads-or-analytics'),
        ('the AI model starts seeing Google event titles', 'src/lib/agentops.js', "? 'Busy' : b.title", ': b.title', 'ai-sees-no-google-titles'),
        ('Cadence starts editing any Google event', 'src/lib/sources/googleCalendar.js', 'const mine = await listOwnBlocks(token, calendarId, { daysAhead, daysBack: 400 });', 'const mine = await listAllEvents(token, calendarId);', 'google-only-own-events'),
        ('a new browser storage key is added', 'src/lib/chats.js', "const keyFor = (bucket) => `cadence.chats.${bucket}.v1`;", "const keyFor = (bucket) => `cadence.chats.${bucket}.v1`; const extra = 'cadence.new-thing';", 'LOCK'),
    ]
    failed = 0
    for what, rel, old, new, expect in mutations:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for n in need:
                src = ROOT / n
                if src.is_dir():
                    shutil.copytree(src, tmp / n, ignore=shutil.ignore_patterns('fonts', '__pycache__'))
                elif src.is_file():
                    shutil.copy2(src, tmp / n)
            text = (tmp / rel).read_text()
            if old not in text:
                print(f'  SKIP  {what}: the text to break is not in {rel} any more (update the self-test)')
                failed += 1
                continue
            (tmp / rel).write_text(text.replace(old, new, 1))
            if expect == 'LOCK':
                caught = not lock_status(tmp)[0]
            else:
                _, fails = run(tmp)
                caught = any(f.startswith(expect + ':') for f in fails)
            print(f'  {"ok  " if caught else "MISS"}  {what}' + ('' if caught else f' ({expect} did not fail)'))
            failed += 0 if caught else 1
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for n in need:
            src = ROOT / n
            if src.is_dir():
                shutil.copytree(src, tmp / n, ignore=shutil.ignore_patterns('fonts', '__pycache__'))
            elif src.is_file():
                shutil.copy2(src, tmp / n)
        (tmp / 'src/lib/chats.js').write_text((tmp / 'src/lib/chats.js').read_text() + "\nconst more = 'cadence.new-thing';\n")
        refused = accept(tmp)
        print(f'  {"ok  " if refused else "MISS"}  --accept refuses a changed data surface while the policy date is unchanged')
        failed += 0 if refused else 1
    print('The checks catch every deliberate break.' if not failed else f'{failed} self-test problem(s).')
    return failed


def main(argv):
    if '--selftest' in argv:
        return 1 if selftest() else 0
    if '--accept' in argv:
        why = accept()
        print(why or 'claims.lock.json updated.')
        return 1 if why else 0
    rows, failures = run()
    if '--markdown' in argv:
        (ROOT / 'CLAIMS.md').write_text(markdown(rows))
        print(f'CLAIMS.md written: {len(rows)} claims.')
    for f in failures:
        print('  FAIL  ' + f)
    ok, detail = lock_status()
    if not ok:
        print('  FAIL  ' + detail)
    print(f'{len(rows)} claims: {len(rows) - len({f.split(":")[0] for f in failures})} hold'
          + (f', {len({f.split(":")[0] for f in failures})} do not.' if failures else '.')
          + ('' if ok else ' The data surface has changed.'))
    return 1 if failures or not ok else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
