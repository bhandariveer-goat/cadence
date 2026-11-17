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
    needed = ['delete out.cloud', 'delete out.gmail', 'delete out.settings.apiKey', 'out.sources = structuredClone(DEFAULT_STATE.sources)', 'delete t.guideData']
    gone = [n for n in needed if n not in body]
    if gone:
        return 'portable() no longer drops: ' + ', '.join(gone)
    if len(re.findall(r'portable\(', t + code(root, 'src/panel/views/account.js'))) < 3:
        return 'the saved copy is no longer built with portable()'
proof_calendar_link_not_synced.shows = 'src/lib/cloud.js: portable() drops the session, the AI key, the Gmail connection and the calendar connections before anything is saved to an account'


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


# ------------------------------------------------------------------- Gmail

GMAIL = 'src/lib/sources/gmail.js'


def proof_gmail_read_only(root):
    t = code(root, GMAIL)
    if "export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';" not in t:
        return 'Gmail is no longer asked for with the read-only permission'
    for rel in shipped(root):
        m = re.search(r'auth/gmail\.(?!readonly)\w+|mail\.google\.com', code(root, rel))
        if m:
            return f'{rel} asks for another Gmail permission: {m.group(0)}'
    call = re.search(r'async function call\(.*?\n\}', t, re.S)
    if not call or 'method' in call.group(0):
        return 'Gmail requests are no longer read-only GET requests'
proof_gmail_read_only.shows = f'{GMAIL}: the only Gmail permission is gmail.readonly, and every Gmail request is a plain read'


def proof_gmail_while_open(root):
    callers = sorted(rel for rel in shipped(root) if rel != GMAIL and re.search(r'\b(readMail|readInbox)\(', code(root, rel)))
    if callers != ['src/panel/core.js', 'src/panel/views/agent.js']:
        return f'Gmail is now read from: {callers or "nowhere"} (it should be only a page of Cadence reading the inbox, and the assistant, which cannot while its email reading is off)'
    if 'const MAIL_EVERY = 30 * MIN;' not in code(root, 'src/panel/core.js'):
        return 'the inbox is no longer read every 30 minutes at most'
    for rel in shipped(root):
        if rel.startswith(('src/background/', 'src/content/')) or rel in ('src/lib/sync.js', 'src/lib/sources/sources.js', 'sw.js'):
            if re.search(r'sources/gmail|gmail\.googleapis', code(root, rel)):
                return f'{rel} (which runs on its own) now touches Gmail'
proof_gmail_while_open.shows = 'src/panel/core.js reads the inbox (when a page is shown, then every 30 minutes); the assistant cannot; nothing in the background worker, the content script or the sync touches Gmail'


def proof_gmail_direct(root):
    if "const API = 'https://gmail.googleapis.com/gmail/v1/users/me';" not in code(root, GMAIL):
        return 'Gmail is no longer read straight from Google'
    for rel in shipped(root):
        if rel.startswith('netlify/') and re.search(r'(?i)gmail', code(root, rel)):
            return f'{rel} (a server function) now handles Gmail'
proof_gmail_direct.shows = f'{GMAIL}: reads from gmail.googleapis.com in the browser; no server function handles Gmail'


def proof_gmail_bounds(root):
    t = code(root, GMAIL)
    need = [(r'messages: 10,', 'at most 10 messages'), (r'textChars: 3000,', '3,000 characters of each'),
            (r'maxResults: LIMITS\.messages', 'asking Gmail for no more than 10'),
            (r'\.slice\(0, LIMITS\.messages\)', 'reading no more than 10'),
            (r'text\.length > LIMITS\.textChars', 'cutting each message to 3,000 characters'),
            (r"\['SPAM', 'TRASH', 'DRAFT'\]\.includes\(l\)", 'skipping spam, trash and drafts'),
            (r'-in:spam -in:trash -in:drafts', 'leaving spam, trash and drafts out of the search'),
            (r'includeSpamTrash: false', 'asking Gmail for no spam or trash')]
    for pattern, what in need:
        if not re.search(pattern, t):
            return f'the Gmail reader no longer enforces {what}'
    for pattern, what in [(r'export const INBOX = \{ messages: 25, days: 14 \};', '25 messages from the last 14 days'),
                          (r"labelIds: 'INBOX'", 'the inbox only'),
                          (r'-category:promotions -category:social -category:forums -in:spam -in:trash -in:drafts', 'promotions, social, forum mail, spam, trash and drafts left out'),
                          (r'\.slice\(0, INBOX\.messages\)', 'reading no more than 25'),
                          (r'maxResults: INBOX\.messages', 'asking Gmail for no more than 25')]:
        if not re.search(pattern, t):
            return f'the inbox reader no longer enforces {what}'
proof_gmail_bounds.shows = f'{GMAIL}: at most 10 messages and 3,000 characters of each; spam, trash and drafts skipped'


def proof_gmail_no_attachments(root):
    t = code(root, GMAIL)
    if re.search(r'/attachments|attachmentId\)\s*\{?\s*(return\s+)?(await\s+)?call', t):
        return 'the Gmail reader now fetches attachments'
    if not re.search(r"const DROP = '[^']*\bimg\b", t) or 'parseFromString' not in t:
        return 'images are no longer dropped, or HTML is no longer read in an inert document'
    if 'hides(' not in t:
        return 'text an email hides is no longer left out'
proof_gmail_no_attachments.shows = f'{GMAIL}: attachments are skipped, never fetched; HTML is read inert with images and hidden text removed'


def proof_gmail_not_saved(root):
    if 'delete out.gmail' not in code(root, 'src/lib/cloud.js'):
        return 'the Gmail connection is no longer left out of the account copy'
    if not re.search(r"gmail: \{ enabled: false, email: '', error: null, lastRead: null \}", code(root, 'src/lib/store.js')):
        return 'what Cadence keeps about Gmail is no longer just whether it is connected and to which address'
    g = code(root, GMAIL)
    if 'let held = null;' not in g or re.search(r'localStorage|sessionStorage|chrome\.storage|indexedDB', g):
        return 'the Gmail sign-in is no longer held in memory only'
    for rel in ('src/panel/views/agent.js', 'src/panel/views/calendars.js'):
        if re.search(r'st\.gmail\s*=\s*\{[^}]*\.\.\.t\b|Object\.assign\(st\.gmail, t\b|st\.gmail\.(accessToken|expiresAt|scopes)\s*=', code(root, rel)):
            return f'{rel} now writes the Gmail sign-in into the plan'
proof_gmail_not_saved.shows = 'src/lib/store.js and src/lib/sources/gmail.js: the plan keeps only whether Gmail is connected, and the sign-in lives in memory; nothing goes to the account'


def proof_gmail_confirm_first(root):
    t = code(root, 'src/lib/agentllm.js')
    if 'let readMail = !chosen && holdsEmail(messages);' not in t:
        return 'a chat that has read email no longer holds its later changes'
    if not re.search(r'if \(got\.read\) readMail = true;', t) or 'read: messages.length > 0' not in t:
        return 'reading email no longer turns on the hold for the rest of the reply'
    if not re.search(r'if \(call\.input\?\.preview === true \|\| readMail\)', t):
        return 'held changes are no longer previews'
    view = code(root, 'src/panel/views/agent.js')
    if 'data-chosen="1"' not in view or "send(el.dataset.text, { chosen: el.dataset.chosen === '1' })" not in view or 'chosen });' not in view:
        return "only a tap on one of the assistant's offered choices should lift the hold"
proof_gmail_confirm_first.shows = "src/lib/agentllm.js and views/agent.js: once email is in a chat, every change is a preview until the student taps an offered choice"


def array_body(text, opening):
    """The text of the array that starts at `opening` (which ends with '['), found by bracket depth."""
    at = text.find(opening)
    if at < 0:
        return ''
    i, depth = at + len(opening), 1
    while i < len(text) and depth:
        depth += {'[': 1, ']': -1}.get(text[i], 0)
        i += 1
    return text[at:i]


def proof_gmail_no_training_model(root):
    providers = code(root, 'src/lib/providers.js')
    if "const email = provider === 'anthropic' || provider === 'groq' || (provider === 'gemini' && plan === 'paid');" not in providers:
        return 'the server no longer limits reading email to models that do not train on it'
    if not re.search(r"chosen === 'groq' \? \(keys\.groq && kept === 'zero' \? 'groq' : null\)", providers):
        return 'Groq can now run without its zero data retention setting confirmed'
    server = code(root, 'netlify/functions/agent.mjs')
    if 'pickProvider(CONFIG.assistant' not in server:
        return 'the server no longer decides with pickProvider()'
    if "const email = picked.email && (provider !== 'groq' || GROQ_PRODUCTION_MODELS.includes(groqModel()));" not in server:
        return "email can now go to a Groq model outside Groq's production models"
    if not re.search(r'if \(!outline && !email && usesEmail\(body\.messages\)\) return json\(403', server):
        return 'the server no longer refuses a conversation that read email where it is not allowed'
    spec = code(root, 'src/lib/agentspec.js')
    if not re.search(r'tools: toolsFor\(\{ email \}\)', spec) or 'read_email' in array_body(spec, 'export const TOOLS = ['):
        return 'read_email is now offered by default'
    for call in ('requestBody(messages, { email })', 'geminiRequest(messages, model, { email })', 'groqRequest(messages, groqModel(), { email })'):
        if call not in server:
            return f'the server no longer passes its decision on: {call} is missing'
proof_gmail_no_training_model.shows = 'src/lib/providers.js and netlify/functions/agent.mjs: read_email is offered only with Claude, Groq (production models, zero retention) or paid Gemini, and refused anywhere else'


def proof_gmail_disconnect(root):
    t = code(root, 'src/panel/views/calendars.js')
    m = re.search(r'async function gmailDisconnect\(\).*?\n\}', t, re.S)
    body = m.group(0) if m else ''
    if 'gmail.drop()' not in body or 'cancelled = await gmail.revoke(token)' not in body:
        return 'disconnecting Gmail no longer forgets the sign-in and asks Google to cancel it'
    g = code(root, GMAIL)
    if 'Date.now() < held.expiresAt ? held.accessToken : null' not in g or 'return res.ok;' not in g:
        return 'a dead token can now be "revoked", and the student told it worked'
proof_gmail_disconnect.shows = 'src/panel/views/calendars.js: disconnecting forgets the sign-in at once and revokes a live token (unless Google Calendar shares it), saying so if Google does not confirm'


def proof_gmail_asks_first(root):
    t = code(root, 'src/panel/views/agent.js')
    m = re.search(r'function emailReader\(\).*?\n\}', t, re.S)
    body = m.group(0) if m else ''
    if 'Read my email' not in body or "if (ok?.get('op') !== 'read') throw" not in body:
        return 'the assistant can now read email without the student tapping Read my email'
    if body.find("ok?.get('op') !== 'read'") > body.find('gmail.readMail('):
        return 'the student is asked only after the email has been read'
    if 'const allowed = new Set();' not in body:
        return 'an earlier yes now carries over beyond one question'
    if 'if (dlg.open) return new Promise' not in code(root, 'src/panel/ui.js'):
        return 'the question can now take over another open sheet and its answer'
proof_gmail_asks_first.shows = 'src/panel/views/agent.js: emailReader() asks for each question and reads nothing unless the student taps Read my email; sheets never overlap (ui.js)'


def proof_gmail_not_in_chats(root):
    t = code(root, 'src/lib/chats.js')
    m = re.search(r'export function withoutEmails\(.*?\n\}', t, re.S)
    body = m.group(0) if m else ''
    if 'withoutEmails(c.messages || [])' not in t or 'EMAIL_TOOL.name' not in body or 'content: EMAILS_LEFT_OUT' not in body:
        return 'saved chats now keep the emails the assistant read'
proof_gmail_not_in_chats.shows = 'src/lib/chats.js: a saved chat replaces the text of every email read with a note'


def proof_google_signins_not_stored(root):
    for rel in (GMAIL, 'src/lib/sources/googleCalendar.js'):
        g = code(root, rel)
        if 'let held = null;' not in g or re.search(r'localStorage|sessionStorage|chrome\.storage|indexedDB', g):
            return f'{rel} no longer holds the sign-in in memory only'
    if re.search(r'google: \{[^}]*accessToken', code(root, 'src/lib/store.js')):
        return 'the plan has a place for a Google token again'
    for rel in shipped(root):
        src = code(root, rel)
        m = re.search(r'Object\.assign\(st\.(sources\.google|gmail), (t|token)\b|st\.(sources\.google|gmail)\.(accessToken|expiresAt)\s*=|saveGoogle', src) \
            or re.search(r'st\.(sources\.google|gmail)\s*=\s*\{[^}]*\.\.\.(t|token)\b|Object\.assign\(st\.(sources\.google|gmail),\s*\{[^}]*\.\.\.(t|token)\b', src)
        if m:
            return f"{rel} now writes Google's sign-in into the plan ({m.group(0)[:60]})"
    sw = code(root, 'src/background/service-worker.js')
    if 'runAll(state, { interactive: false })' not in sw or 'pushGoogle(fresh, { interactive: false })' not in sw:
        return "the background sync can now open Google's sign-in window"
    core = code(root, 'src/panel/core.js')
    # Each reading that can run by itself, by name: the calendars, the Google
    # Calendar push, and the email events.
    for fn in ('refreshSources', 'pushGoogleBlocks', 'readMailNow'):
        m = re.search(r'(?:export )?async function ' + fn + r'\(.*?\n\}', core, re.S)
        if not m or 'interactive: !quiet' not in m.group(0):
            return f"a refresh that runs by itself ({fn}) can now open Google's sign-in window"
proof_google_signins_not_stored.shows = "src/lib/sources/googleCalendar.js and gmail.js hold Google's sign-in in memory; nothing writes it to the plan; nothing that runs by itself opens the sign-in window"


def proof_policy_change_told(root):
    m = re.search(r"date: '(\d{4}-\d{2}-\d{2})'", code(root, 'src/lib/policy.js'))
    lock = json.loads(read(root, 'claims.lock.json') or '{}')
    if not m:
        return 'src/lib/policy.js no longer says when the policy last changed'
    if lock.get('policy_date', '') > m.group(1):
        return f"what Cadence collects changed on {lock['policy_date']}, after the last announced change ({m.group(1)})"
    view = code(root, 'src/panel/views/agent.js')
    if 'if (via && needsPolicyNotice() && !(await policyNotice()))' not in view:
        return 'the assistant no longer tells people about a change before sending more to an AI company'
    if 'st.profile.policySeen = POLICY_CHANGE.date' not in code(root, 'src/panel/core.js'):
        return 'someone agreeing to the current policy would still be told about an older change'
proof_policy_change_told.shows = 'src/lib/policy.js and views/agent.js: a change to who receives what is shown once, and agreed to, before the assistant next sends anything'


def proof_email_fields(root):
    t = code(root, 'src/lib/agentllm.js')
    if 'const { account, ...asked } = got || {};' not in t or '.map(({ id, ...m }) => m)' not in t:
        return "the model now gets the student's address or Gmail's message ids"
proof_email_fields.shows = "src/lib/agentllm.js: the model gets each message's sender, subject, time, read status and text, not the student's address or Gmail's ids"

# ------------------------------------------------------------- usage data

METRICS = 'src/lib/metrics.js'
METRIC_FN = 'netlify/functions/metric.mjs'
INSIGHT = 'src/panel/insight.js'
USAGE_WORDS = ['active', 'onboarded', 'has_work', 'checked_in', 'connected']
USAGE_KINDS = ['screen', 'click', 'dead_click', 'rage_click', 'step', 'error', 'timing', 'session', 'milestone']
USAGE_STEPS = ['signin:shown', 'signin:started', 'signin:submitted', 'signin:done']
USAGE_NAME = "/^[a-z0-9][a-z0-9_.:-]{0,79}$/"
# What insights() may return, key by key (supabase/ux_check.sql checks the same list on a real database).
INSIGHT_KEYS = ['days', 'overview', 'daily', 'retention', 'signup', 'setup', 'setup_time', 'tour', 'tour_skips', 'screens', 'most_pressed', 'least_pressed', 'dead_clicks', 'rage_clicks', 'errors', 'early_errors', 'speed', 'value', 'visits', 'stops']
# The only bodies lib/metrics.js sends, with spaces taken out.
USAGE_BODIES = {'id:rec.id,event', "id:rec.id,event:'forget'", 'id,session:visit,events:batch', 'steps:[name]'}
# The sheets about email, whose heading carries data-about="email" so insight.js records nothing while one is open.
EMAIL_SHEETS = {
    'src/panel/views/mail.js': '<h2 data-about="email">${esc(e.title)}</h2>',
    'src/panel/views/calendars.js': '<h2 data-about="email">Find events in your Gmail?</h2>',
    'src/panel/views/agent.js': '<h2 data-about="email">Read your email for this?</h2>',
}


def words_in(text):
    return re.findall(r"'([a-z_:]+)'", text)


def proof_usage_payload(root):
    t = code(root, METRICS)
    for const, want in (('EVENTS', USAGE_WORDS), ('KINDS', USAGE_KINDS), ('STEPS', USAGE_STEPS)):
        m = re.search(rf'export const {const} = \[([^\]]*)\]', t)
        if not m or words_in(m.group(1)) != want:
            return f'lib/metrics.js: {const} is no longer exactly the list on the page'
    if f'export const NAME = {USAGE_NAME};' not in t:
        return 'lib/metrics.js: a name may now hold more than code characters'
    bodies = {re.sub(r'\s+', '', b) for b in re.findall(r'send\(\{([^}]*)\}\)', t)}
    if not bodies or bodies - USAGE_BODIES:
        return f'lib/metrics.js now sends a body that was not checked: {", ".join(sorted(bodies - USAGE_BODIES))}'
    if 'body: JSON.stringify(body)' not in t:
        return 'usage data is no longer sent as the body that was checked'
    tr = re.search(r'export function track\(.*?\n\}', t, re.S)
    if not tr or 'const rec = { q: seq++, k: kind, n: name };' not in tr.group(0) \
            or set(re.findall(r'\brec\.(\w+)\s*=', tr.group(0))) - {'s', 'v'}:
        return 'track() now keeps more than an order number, a kind, a name, a screen and a number'
    ms = re.search(r'export function milestones\(state\) \{(.*?)\n\}', t, re.S)
    if not ms or re.search(r"state\??\.(tasks|commitments|checkins)\b[^;)]*\b(title|name|text|note)\b", ms.group(1)):
        return 'a milestone now reads something other than yes or no from the plan'
    if "id !== 'mail'" not in ms.group(1) or re.search(r'gmail', ms.group(1), re.I):
        return 'the connected milestone may now count Gmail or email events'
    for rel in (METRICS, METRIC_FN, INSIGHT):
        if re.search(r'mailEvents|sources/gmail|sources\??\.mail|\.gmail\b', code(root, rel)):
            return f'{rel} now touches Gmail or the events found in email'
    fn = code(root, METRIC_FN)
    m = re.search(r'x-forwarded|x-nf-|client-ip|user-agent|referer|cookie|console\.|\bgetStore\b|writeFile', fn, re.I)
    if m:
        return f'the usage function now reads or keeps {m.group(0)}'
    for const, want in (('EVENTS', USAGE_WORDS), ('KINDS', USAGE_KINDS), ('STEPS', USAGE_STEPS)):
        m = re.search(rf"const {const} = new Set\(\[([^\]]*)\]\)", fn)
        if not m or words_in(m.group(1)) != want:
            return f'the usage function accepts {const.lower()} other than the ones on the page'
    cr = re.search(r'export function cleanRecord\(r\) \{.*?\n\}', fn, re.S)
    if not cr or 'const out = { q: r.q, k: r.k, n: r.n };' not in cr.group(0) or set(re.findall(r'\bout\.(\w+)\s*=', cr.group(0))) - {'s', 'v'}:
        return 'the usage function now passes on more of a record than its five fields'
    sql = code(root, 'supabase/schema.sql')
    if "event in ('active', 'onboarded', 'has_work', 'checked_in', 'connected')" not in sql:
        return 'the usage table accepts words other than the five'
    if "kind in ('screen', 'click', 'dead_click', 'rage_click', 'step', 'error', 'timing', 'session', 'milestone')" not in sql \
            or sql.count("~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'") < 2:
        return 'the table of how the app is used accepts kinds or names other than the ones on the page'
    if sql.count("('signin:shown', 'signin:started', 'signin:submitted', 'signin:done')") < 2:
        return 'the sign-up counts accept names other than the four'
proof_usage_payload.shows = 'lib/metrics.js, netlify/functions/metric.mjs, supabase/schema.sql: a random ID with five words, records of a fixed kind and a code-character name, and the four sign-up steps; each is rebuilt from its fields and checked again by the database'


def proof_usage_no_content(root):
    t = code(root, INSIGHT)
    if not re.search(r"^import \{[^}]*\} from '\.\./lib/metrics\.js';\nimport \{ CONFIG \} from '\.\./config\.js';$", t, re.M) \
            or len(re.findall(r'^import ', t, re.M)) != 2:
        return 'insight.js now imports more than the sender and the config, so it may reach the plan'
    if re.search(r'\bapp\.S\b|localStorage|chrome\.storage|indexedDB|document\.cookie', t):
        return 'insight.js now reads the plan or stores something'
    if t.count('.value') != 1 or 'codeName(el.value)' not in t:
        return 'insight.js now reads what is in a field'
    m = re.search(r'textContent|innerText|innerHTML|outerHTML|\.placeholder|aria-label|\.title\b|\.message\b|\.alt\b'
                  r'|client[XY]|page[XY]|screen[XY]|offset[XY]|movement[XY]|getBoundingClientRect'
                  r"|['\"](?:mousemove|pointermove|scroll|wheel|touchmove|selectionchange|copy|paste)['\"]|getSelection", t)
    if m:
        return f'insight.js now reads {m.group(0)}, which could be words on the page, what was typed, or a position on the screen'
    if 'const EMAIL = /\\bg?mail\\b/;' not in t or "if (!name || EMAIL.test(name) || EMAIL.test(screen) || emailOpen()) return false;" not in t:
        return 'insight.js no longer skips everything about email'
    if """const emailOpen = () => !!document.querySelector('#sheet[open] [data-about="email"]');""" not in t:
        return 'insight.js no longer knows when a sheet about email is open'
    if not re.search(r'return EMAIL\.test\(name\) \? \'\' : name;', t):
        return "insight.js may now name a control about email"
    for rel, line in EMAIL_SHEETS.items():
        if line not in read(root, rel):
            return f'{rel}: a sheet about email lost its data-about="email" marker, so it would be recorded'
    if not re.search(r"<h2\$\{/mail/i\.test\(title\) \? ' data-about=\"email\"' : ''\}>", read(root, 'src/panel/views/calendars.js')):
        return 'calendars.js: the Gmail sign-in sheet lost its data-about="email" marker'
    if "sheet(`<h2 data-about=\"email\">Disconnect Gmail?</h2>" not in read(root, 'src/panel/views/calendars.js'):
        return 'calendars.js: the Disconnect Gmail sheet lost its data-about="email" marker'
proof_usage_no_content.shows = 'src/panel/insight.js: records names from the code only; reads no text, field, position, mouse or scroll, cannot reach the plan, and skips every control and sheet about email (marked data-about="email" in mail.js, calendars.js and agent.js)'


def proof_usage_signup_no_id(root):
    t = code(root, METRICS)
    cs = re.search(r'export async function countStep\(.*?\n\}', t, re.S)
    if not cs or 'return send({ steps: [name] });' not in cs.group(0) or re.search(r'\bid\b|known|visit', cs.group(0).replace('stepsSent', '')):
        return 'the sign-up counts now carry an ID'
    if '!STEPS.includes(name) || stepsSent.has(name)' not in cs.group(0) or 'demo' not in cs.group(0) or '.off' not in cs.group(0):
        return 'the sign-up counts no longer stick to the four steps, once a load, outside the demo, and not when turned off'
    sql = code(root, 'supabase/schema.sql')
    tb = re.search(r'create table if not exists funnel_counts \((.*?)\n\);', sql, re.S)
    if not tb or re.search(r'install_id|session|uuid', tb.group(1)):
        return 'the sign-up counts table now has room for an ID'
proof_usage_signup_no_id.shows = 'lib/metrics.js countStep() and supabase/schema.sql funnel_counts: a step name and a daily number, with no ID of any kind'


def proof_usage_local_id(root):
    t = code(root, METRICS)
    if "const KEY = 'cadence.usage.v1';" not in t or 'crypto.randomUUID()' not in t:
        return 'the usage ID is no longer a random one in its own storage slot'
    if re.search(r'usage|metrics', code(root, 'src/lib/store.js'), re.I):
        return 'the plan now has a place for usage data, which would copy the ID to the account'
    if re.search(r'cadence\.usage|lib/metrics', code(root, 'src/lib/cloud.js')):
        return 'the account copy now handles the usage ID'
    if re.search(r'localStorage\.setItem|chrome\.storage\.local\.set', t.replace("chrome.storage.local.set({ [KEY]: v })", '').replace('localStorage.setItem(KEY, JSON.stringify(v))', '')):
        return 'lib/metrics.js now stores something besides its own slot'
proof_usage_local_id.shows = 'lib/metrics.js and store.js: the random ID is its own storage slot, not part of the plan, so portable() never copies it; records wait in memory'


def proof_usage_consent_and_off(root):
    t = code(root, METRICS)
    el = re.search(r'export function eligible\(.*?\n\}', t, re.S)
    if not el or not all(s in el.group(0) for s in ('!demo', 'profile?.consentedAt', 'POLICY_CHANGE.date')):
        return 'usage data no longer waits for the demo to be left, the terms to be agreed and the change to be seen'
    if 'if (running || !eligible(state, { demo })) return;' not in t:
        return 'noteUsage() no longer checks eligible() first'
    ad = re.search(r'export function allowDetail\(.*?\n\}', t, re.S)
    if not ad or 'eligible(state, { demo }) && known !== null && !known.off' not in ad.group(0):
        return 'records of how the app is used no longer wait for agreement and the Account switch'
    if 'if (!allowed || !KINDS.includes(kind)' not in t or 'if (flushing || !allowed || !buffer.length) return;' not in t:
        return 'records may now be kept or sent while they are not allowed'
    off = re.search(r'export async function setUsage\(on\) \{(.*?)\n\}', t, re.S)
    if not off or "event: 'forget'" not in off.group(1) or 'off: true' not in off.group(1) or "id: ''" not in off.group(1) or 'buffer = [];' not in off.group(1):
        return 'turning usage data off no longer deletes the ID, drops what is waiting and asks the server to forget it'
    if 'await forgetUsage();' not in code(root, 'src/panel/core.js'):
        return 'signing out or deleting data no longer forgets the usage ID'
    acct = code(root, 'src/panel/views/account.js')
    if 'data-act="usage-toggle"' not in acct or "'usage-toggle'" not in acct:
        return 'the switch for usage data is gone from Account'
    sql = code(root, 'supabase/schema.sql')
    fg = re.search(r'create or replace function forget_usage.*?end \$\$;', sql, re.S)
    if not fg or not all(f'delete from {tb} where install_id = p_id;' in fg.group(0) for tb in ('usage_events', 'ux_events', 'ux_quota')):
        return 'the database no longer forgets everything recorded with a usage ID'
    ins = code(root, INSIGHT)
    if 'if (on || isDemo || embedded) return;' not in ins:
        return 'insight.js may now watch the demo or the homepage frame'
    if "!screen.startsWith('signin') && spent >= 500" not in ins:
        return 'insight.js now records time on the sign-up screen, which is spent before agreeing'
    app = code(root, 'src/panel/app.js')
    if 'allowDetail(app.S, { demo: DEMO });' not in app or 'demo: DEMO,\n  embedded: EMBEDDED' not in app:
        return 'app.js no longer passes the demo and the frame to the usage data'
proof_usage_consent_and_off.shows = 'lib/metrics.js, panel/insight.js, panel/app.js, views/account.js: nothing with the ID until the terms are agreed and the change seen, never in the demo or the homepage frame, not the sign-up screen; off, sign out and Delete my data delete the ID and ask the server to forget everything recorded with it'


def proof_usage_owner_only(root):
    sql = code(root, 'supabase/schema.sql')
    fn = re.search(r'create or replace function insights\(.*?\n\s*end \$\$;', sql, re.S)
    if not fn:
        return 'the database no longer has insights()'
    body = fn.group(0)
    if 'security definer' not in body:
        return 'insights() no longer runs with the database owner\'s rights, so it could not read the locked tables'
    if "if auth.uid() is null or not exists (select 1 from owners where user_id = auth.uid()) then\n    raise exception 'not allowed';" not in body:
        return 'insights() no longer refuses an account that is not on the owners list'
    if re.search(r'select \*|to_jsonb\((?!q\))|row_to_json', body):
        return 'insights() may now return a row of one browser\'s records, not only totals'
    keys = re.findall(r"^    '(\w+)', ", body, re.M)
    if sorted(keys) != sorted(INSIGHT_KEYS):
        return f'insights() now returns {sorted(set(keys) ^ set(INSIGHT_KEYS))} beyond or short of the totals checked'
    if not re.search(r'create table if not exists owners \(\s*user_id uuid primary key references auth\.users on delete cascade\s*\);\s*alter table owners enable row level security;', sql):
        return 'the owners list is no longer a table locked by row level security'
    if re.search(r'create policy[^;]*on owners\b', sql):
        return 'the owners list now has a policy that lets someone read or change it'
    if 'owners, partner_overview from anon, authenticated;' not in sql:
        return 'the owners list is no longer taken away from visitors and signed-in users'
    anyone = [g for g in re.findall(r'grant [^;]*;', sql) if re.search(r'\banon\b', g) and 'insights' in g]
    if anyone:
        return 'insights() is now granted to people who are not signed in'
    if not re.search(r'grant execute on function[^;]*\binsights\(integer\)[^;]*\n?\s*to authenticated;', sql):
        return 'insights() is no longer granted to signed-in accounts only'
    if 'insights(integer), handle_new_user()' not in sql:
        return 'insights() is no longer taken away from everyone before being granted back'
    page = code(root, 'src/panel/views/insights.js')
    if re.search(r'localStorage|sessionStorage|chrome\.storage|indexedDB|document\.cookie', page):
        return 'the Insights page now keeps something in the browser'
    if set(re.findall(r"rest\('([^']+)'", page)) != {'rpc/insights'}:
        return 'the Insights page now asks the database for something besides insights()'
    app = code(root, 'src/panel/app.js')
    if "STANDALONE && !DEMO && !EMBEDDED && new URLSearchParams(location.search).get('insights') === '1' && signedIn()" not in app:
        return 'the Insights page can now be opened somewhere other than the website, or without signing in'
    ins = code(root, INSIGHT)
    if "if (screen === 'insights' || String(name).startsWith('insights')) return false;" not in ins:
        return "the owner's own visits to the Insights page are now recorded as student activity"
proof_usage_owner_only.shows = 'supabase/schema.sql, views/insights.js, app.js: insights() answers only an account on the owners list (a table no one can read), returns totals and never a browser\'s rows, is not granted to visitors, and the page keeps nothing and is not in the extension'


def proof_usage_kept(root):
    sql = code(root, 'supabase/schema.sql')
    if 'delete from usage_events where day < current_date - 400;' not in sql:
        return 'usage counts are no longer deleted after 400 days'
    if "delete from ux_events where at < now() - interval '180 days';" not in sql:
        return 'records of how the app is used are no longer deleted after 180 days'
    if 'delete from funnel_counts where day < current_date - 400;' not in sql:
        return 'the sign-up counts are no longer deleted after 400 days'
    if not re.search(r'create table if not exists usage_events \(.*?day date not null default current_date', sql, re.S) \
            or not re.search(r'create table if not exists ux_events \(.*?at timestamptz not null default now\(\)', sql, re.S):
        return "the time of a usage record is no longer the database's own"
    for tb in ('usage_events', 'ux_events', 'ux_quota', 'funnel_counts'):
        if f'alter table {tb} enable row level security;' not in sql:
            return f'{tb} no longer has row level security on'
        if re.search(rf'create policy[^;]*on {tb}\b', sql):
            return f'{tb} now has a policy that lets someone read or change rows'
proof_usage_kept.shows = "supabase/schema.sql: times are the database's; counts and sign-up numbers go after 400 days, records of use after 180; no one can read or change the tables with the public key"



# ------------------------------------------------------- the site's assistant

def proof_site_assistant(root):
    ai = site_assistant(root)
    if ai not in ('groq', 'gemini', 'claude'):
        return f'src/config.js names no assistant ({ai or "nothing"}); it should be groq, gemini or claude'
    server = code(root, 'netlify/functions/agent.mjs')
    if "import { CONFIG } from '../../src/config.js';" not in server or 'pickProvider(CONFIG.assistant' not in server:
        return 'the server no longer takes its assistant from src/config.js'
    providers = code(root, 'src/lib/providers.js')
    for case in (r"chosen === 'groq' \? \(keys\.groq && kept === 'zero' \? 'groq' : null\)",
                 r"chosen === 'gemini' \? \(keys\.gemini && \(plan === 'free' \|\| plan === 'paid'\) \? 'gemini' : null\)",
                 r"chosen === 'claude' \? \(keys\.anthropic \? 'anthropic' : null\)"):
        if not re.search(case, providers):
            return 'pickProvider() no longer runs only the named company, and only once it is set up'
proof_site_assistant.shows = "src/config.js names the company; netlify/functions/agent.mjs runs that one only (pickProvider in src/lib/providers.js)"


def proof_groq_keeps_nothing(root):
    if 'process.env.GROQ_RETENTION' not in code(root, 'netlify/functions/agent.mjs'):
        return 'the server no longer reads GROQ_RETENTION'
    if not re.search(r"keys\.groq && kept === 'zero' \? 'groq' : null", code(root, 'src/lib/providers.js')):
        return 'Groq can now run without its zero data retention setting confirmed'
proof_groq_keeps_nothing.shows = "src/lib/providers.js: Groq runs only with GROQ_RETENTION=zero, the owner's word that zero data retention is on"


# ----------------------------------------------------------------- invariants
# Rules about email that the code must keep whatever the pages say, checked on
# every run. Together they hold up the email events feature: events found in
# email stay in this browser, nothing about them reaches the assistant's AI
# company, and only Cadence's own site can ask the extension for them.

MAIL = 'src/lib/mailEvents.js'
SHARE = 'src/lib/mailShare.js'
BRIDGE = 'src/panel/mailbridge.js'
MAIL_TOUCH = re.compile(r"sources\??\.mail|mailEvents|source === 'mail'")


def proof_mail_stays_on_device(root):
    if not re.search(r'sources: \{.*?\n    mail: \{', code(root, 'src/lib/store.js'), re.S):
        return 'the plan no longer keeps email events under sources'
    cloud = code(root, 'src/lib/cloud.js')
    if 'out.sources = structuredClone(DEFAULT_STATE.sources);' not in cloud:
        return 'the account copy no longer leaves sources, and with them the email events, out'
    if 'next.sources = structuredClone(local.sources || DEFAULT_STATE.sources);' not in cloud:
        return "a plan from the account can now replace this device's email events"
    if 'mail: stored.sources?.mail' not in code(root, 'src/panel/core.js'):
        return 'an Undo can now bring back old email events'
    for rel in shipped(root):
        if rel not in (MAIL, SHARE) and re.search(r"source:\s*'mail'", code(root, rel)):
            return f'{rel} now makes email events of its own'
    # Only these files may handle the stored email events themselves. Anything
    # else reaching for them (a sync, a request, the assistant) has to be added
    # here on purpose, where a reviewer will see it.
    if 'const data = portable(state);' not in cloud:
        return 'the plan sent to the account no longer goes through portable()'
    outside = re.sub(r'export function (portable|adopt)\(.*?\n\}', '', cloud, flags=re.S)
    if re.search(r'\bsources\b', outside):
        return 'lib/cloud.js now handles sources outside portable() and adopt()'
    callers = sorted(rel for rel in shipped(root) if re.search(r'\bsourceEvents\(', code(root, rel)) and rel != 'src/lib/sources/sources.js')
    if callers != ['src/lib/replanner.js', 'src/panel/core.js']:
        return f'calendar events, email events among them, are now read by {callers}'
    walkers = sorted(rel for rel in shipped(root) if re.search(r'Object\.(entries|values|keys)\(\s*[\w.?]*sources\b', code(root, rel)))
    if not set(walkers) <= {'src/lib/sources/sources.js', 'src/panel/core.js', 'src/background/service-worker.js', 'src/panel/views/calendar.js', 'src/lib/metrics.js'}:
        return f'every source, email events among them, is now walked by {walkers}'
    # The homepage's worked example makes up one email event for a student who
    # does not exist, in a week that lives only in the page. It may hold that
    # event for as long as it has no way to save or send anything.
    example = 'src/site/evening.js'
    if re.search(r'\b(fetch|sendBeacon|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|chrome)\b|saveState|/cloud\.js|/sync\.js', code(root, example)):
        return f'{example} holds an email event and can now save or send it'
    allowed = {MAIL, SHARE, BRIDGE, 'src/panel/core.js', 'src/panel/views/calendars.js', 'src/panel/views/mail.js', example}
    for rel in shipped(root):
        if rel not in allowed and re.search(r'sources\??\.mail\b', code(root, rel)):
            return f'{rel} now reads the email events (sources.mail)'
proof_mail_stays_on_device.shows = 'src/lib/store.js, cloud.js, panel/core.js: email events live under sources, which the account copy leaves out, and only lib/mailEvents.js makes them'


def proof_mail_no_network(root):
    for rel in (MAIL, SHARE, BRIDGE, 'src/panel/views/mail.js'):
        src = code(root, rel)
        if not src:
            return f'{rel} is missing'
        m = re.search(r'\b(fetch|sendBeacon|XMLHttpRequest|WebSocket|EventSource|importScripts)\b|agentEndpoint|console\.', src)
        if m:
            return f'{rel} now uses {m.group(0)}'
    if re.findall(r"^import [^;]*? from '([^']+)';", code(root, MAIL), re.M) != ['./store.js']:
        return 'lib/mailEvents.js now imports more than lib/store.js'
    if re.findall(r"^import [^;]*? from '([^']+)';", code(root, SHARE), re.M) != ['./mailEvents.js']:
        return 'lib/mailShare.js now imports more than lib/mailEvents.js'
    if 'globalThis.LanguageModel' not in code(root, MAIL):
        return "lib/mailEvents.js no longer uses Chrome's on-device model"
    for rel in ('src/panel/views/mail.js', BRIDGE, 'src/panel/views/calendars.js'):
        if re.search(r'agent-say|cadence:act', code(root, rel)):
            return f'{rel} now hands something to the assistant'
    for rel in (MAIL, SHARE):
        if re.search(r'\bimport\s*\(', code(root, rel)):
            return f'{rel} now loads code at run time'
proof_mail_no_network.shows = "lib/mailEvents.js, mailShare.js, panel/mailbridge.js, views/mail.js: no network request and no logging; the model is Chrome's on-device one"


def proof_mail_quotes_checked(root):
    t = code(root, MAIL)
    for need, what in [("if (!quoteIn(quote, message.text)) return", 'the quote is checked against the email'),
                       ('plain(text).includes(q)', 'the email has to contain the quote'),
                       ('if (!agrees(date, quote, arrived, order)) return', 'the date is checked against the quote'),
                       ('if (named.size && !named.has(day.getDay())) return false;', 'a weekday the quote names must match'),
                       ('if (dates.length && !dates.some(', 'a date the quote names must match'),
                       ('return check(raw, message, now, opts).event || null;', 'every candidate goes through check()')]:
        if need not in t:
            return f'lib/mailEvents.js no longer makes sure {what}'
    if 'const ev = validate(raw, m, now' not in t:
        return "the model's and the rules' candidates no longer all go through validate()"
    if 'return q.length >= MAIL_LIMITS.quoteMin && plain(text).includes(q);' not in t:
        return 'quoteIn() no longer needs both a real quote and the email containing it'
proof_mail_quotes_checked.shows = "lib/mailEvents.js: every event's quote must be in its email, and its date must agree with any weekday or date the quote names"


def proof_assistant_never_sees_mail(root):
    t = code(root, 'src/lib/agentllm.js')
    if 'const view = forAssistant(state);' not in t or 'let working = view;' not in t:
        return 'the assistant no longer works on a copy of the plan without email events'
    m = re.search(r'export function forAssistant\(state\) \{(.*?)\n\}', t, re.S)
    if not m or 'withoutMail(state)' not in m.group(1) or 'recomputeState(view)' not in m.group(1):
        return 'forAssistant() no longer removes the email events and plans again without them'
    if 'next: changed ? replay(state, applied, now) : null' not in t:
        return "the assistant's changes are no longer made again on the real plan"
    if 'return view;' not in m.group(1):
        return 'forAssistant() no longer returns the copy it made'
    for need in ('const tonight = stayUpOption(working, now);', '...planView(working, now)',
                 'const r = toOps(call.name, call.input, working, now);', 'const run = carryOut(working, r.ops, now);'):
        if need not in t:
            return f'the model is no longer shown only the copy ({need} is missing)'
    conv = re.search(r'export async function converse\(.*?\n\}', t, re.S)
    if not conv or re.search(r'planView\(state|stayUpOption\(state|toOps\(call\.name, call\.input, state|carryOut\(state', conv.group(0)):
        return 'the model is shown the real plan somewhere in converse()'
    if 'mail: blankMail()' not in code(root, MAIL):
        return 'withoutMail() no longer empties the email events'
    for rel in ('netlify/functions/agent.mjs', 'src/lib/agentspec.js', 'src/lib/agentops.js', 'src/lib/gemini.js', 'src/lib/groq.js'):
        hit = MAIL_TOUCH.search(code(root, rel))
        if hit:
            return f'{rel} now touches email events ({hit.group(0)})'
proof_assistant_never_sees_mail.shows = "lib/agentllm.js: the AI model is shown, and its tools answer from, a copy of the plan without email events (forAssistant); its changes are made again on the real plan"


def proof_mail_not_to_google(root):
    m = re.search(r'export function pushableBlocks\(.*?\n\}', code(root, 'src/lib/replanner.js'), re.S)
    if not m or re.search(r'sourceEvents|sources|mail', m.group(0)):
        return 'what Cadence writes to Google Calendar may now include events found in email'
    if MAIL_TOUCH.search(code(root, 'src/lib/sources/googleCalendar.js')):
        return 'the Google Calendar code now touches email events'
    push = re.search(r'export async function pushGoogle\(.*?\n\}', code(root, 'src/lib/sources/sources.js'), re.S)
    if not push or re.search(r'sourceEvents|sources\??\.mail|mail', push.group(0).replace('pushGoogle', '')):
        return 'what Cadence pushes to Google Calendar may now include events found in email'
proof_mail_not_to_google.shows = "src/lib/replanner.js pushableBlocks: only Cadence's own planned blocks go to Google Calendar, never events found in email"


def proof_mail_labelled(root):
    for need, rel in [("calendarName: 'From email'", MAIL), ('From email', 'src/panel/views/parts.js'), ('From email', 'src/panel/views/week.js'),
                      ('open-mail-event', 'src/panel/views/mail.js'), ('Delete event', 'src/panel/views/mail.js'), ("'mail-toggle'", 'src/panel/views/calendars.js'),
                      ('function wasDeleted(', MAIL)]:
        if need not in code(root, rel):
            return f'{rel} no longer has {need}'
proof_mail_labelled.shows = 'lib/mailEvents.js, views/parts.js, week.js, mail.js, calendars.js: events are labelled From email, open to their sentence, can be deleted (and stay deleted), and the switch exists'


def proof_disconnect_deletes_mail(root):
    m = re.search(r'async function gmailDisconnect\(\).*?\n\}', code(root, 'src/panel/views/calendars.js'), re.S)
    if not m or 'st.sources.mail = blankMail();' not in m.group(0):
        return 'disconnecting Gmail no longer removes the events found in email from this device'
proof_disconnect_deletes_mail.shows = 'src/panel/views/calendars.js gmailDisconnect: the events found in email go with the connection'


def proof_bridge_only_own_site(root):
    try:
        manifest = json.loads(read(root, 'manifest.json') or '{}')
    except ValueError:
        return 'manifest.json does not parse'
    domain = re.search(r"domain:\s*'([^']+)'", code(root, 'src/config.js'))
    want = [f'https://{domain.group(1)}/*'] if domain else None
    ec = manifest.get('externally_connectable') or {}
    if ec.get('matches') != want or 'ids' in ec:
        return f"externally_connectable lets {ec} talk to the extension (it should be only {want})"
    sw = code(root, 'src/background/service-worker.js')
    if 'chrome.runtime.onMessageExternal.addListener' not in sw or 'sender?.origin !== origin' not in sw or 'readSiteMessage(msg)' not in sw:
        return "the extension no longer checks a web page's origin and message before answering"
    share = code(root, SHARE)
    if 'if (!origin || sender?.origin !== origin) return null;' not in share:
        return 'lib/mailShare.js no longer checks the origin first'
    m = re.search(r'export function forSite\(e\) \{(.*?)\n\}', share, re.S)
    if not m or re.search(r'fromKey|messageId|received|engine', m.group(1)):
        return 'the website may now be sent the sender address or Gmail ids'
    if 'events: enabled ? (mail.events || []).map(forSite) : []' not in share:
        return 'events sent to the website no longer all go through forSite()'
    ways_in = sum(len(re.findall(r'onMessageExternal|onConnectExternal', code(root, rel))) for rel in shipped(root))
    if ways_in != 1:
        return f'the extension now has {ways_in} ways for web pages to reach it (it should be the one checked listener)'
proof_bridge_only_own_site.shows = "manifest.json, src/background/service-worker.js, lib/mailShare.js: only Cadence's own site may ask the extension for email events, and it gets no address, Gmail id or sign-in"


def proof_assistant_email_off(root):
    if not re.search(r'\bemailToAssistant:\s*false\b', code(root, 'src/config.js')):
        return 'src/config.js lets the assistant read email (emailToAssistant)'
    if 'return { provider, email: email && emailToAssistant === true };' not in code(root, 'src/lib/providers.js'):
        return 'pickProvider() no longer needs emailToAssistant to offer email'
    if 'emailToAssistant: CONFIG.emailToAssistant' not in code(root, 'netlify/functions/agent.mjs'):
        return 'the server no longer passes emailToAssistant on'
    if 'email && CONFIG.emailToAssistant === true ? [...TOOLS, EMAIL_TOOL] : TOOLS' not in code(root, 'src/lib/agentspec.js'):
        return 'read_email can now be offered with emailToAssistant off'
    if 'if (CONFIG.emailToAssistant !== true) return null;' not in code(root, 'src/panel/views/agent.js'):
        return 'the panel can now read email for the assistant with emailToAssistant off'
    for rel in ('src/lib/gemini.js', 'src/lib/groq.js'):
        src = code(root, rel)
        if 'toolsFor({ email })' not in src or 'EMAIL_TOOL' in src:
            return f'{rel} no longer takes its tools from toolsFor(), which keeps read_email off'
proof_assistant_email_off.shows = 'src/config.js, providers.js, agentspec.js, views/agent.js, netlify/functions/agent.mjs: with emailToAssistant false, no model is offered email or given any'


INVARIANTS = [
    ('usage-minimal', 'Usage data, if on, sends only a random ID with fixed counts and records named in code, and never anything typed, from the plan, or from email', [proof_usage_payload, proof_usage_no_content]),
    ('usage-totals-only', 'The usage records are read only as totals, by an account on the owners list', [proof_usage_owner_only]),
    ('assistant-email-hold', 'If the assistant reads email again, every change it makes stays a preview until the student taps it', [proof_gmail_confirm_first]),
    ('assistant-email-asks-first', 'If the assistant reads email again, it asks before each read', [proof_gmail_asks_first]),
    ('assistant-email-not-in-chats', 'If the assistant reads email again, saved chats leave the emails out', [proof_gmail_not_in_chats]),
    ('assistant-email-fields', 'If the assistant reads email again, it gets no address or Gmail ids', [proof_email_fields]),
    ('assistant-email-providers', 'If the assistant reads email again, only a model that does not train on it gets it', [proof_gmail_no_training_model]),
    ('mail-stays-on-device', 'Events found in email stay on this device and out of the account', [proof_mail_stays_on_device]),
    ('mail-no-network', 'Email events are found without any network request, and nothing about them is logged', [proof_mail_no_network]),
    ('mail-quotes-checked', "Every event's quote is in its email, and its date agrees with the quote", [proof_mail_quotes_checked]),
    ('assistant-never-sees-mail', "The assistant's AI model never sees email events, in the plan or in its tools' answers", [proof_assistant_never_sees_mail]),
    ('mail-not-to-google-calendar', 'Nothing found in email is written to Google Calendar', [proof_mail_not_to_google]),
    ('disconnect-deletes-mail', 'Disconnecting Gmail removes the events found in it', [proof_disconnect_deletes_mail]),
    ('bridge-only-own-site', "Only Cadence's own site can ask the extension for email events", [proof_bridge_only_own_site]),
    ('assistant-email-off', 'The assistant reads no email while emailToAssistant is off', [proof_assistant_email_off]),
]



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
     [(PRIVACY, 'the copy leaves out your anthropic api key, your google calendar connection and its events, your gmail connection and the events found in your email, your calendar links, and your chats with the assistant')],
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
     [(PRIVACY, 'cadence does not share your data with anyone else, and does not use advertising or third-party analytics services')],
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

    # The homepage's four statements about your data (the "principles" over its table).
    ('home-download-delete', 'You can download your plan or delete it, from Account',
     [('index.html', 'in account, download my data saves it as a file you can keep'),
      ('index.html', 'delete my data erases it')],
     [has('src/panel/views/account.js', r"row\('account-export', I\.file, 'Download my data'"),
      has('src/panel/views/account.js', r"'Delete account' : 'Delete my data'"),
      proof_delete_wipes_browser]),
    ('home-crew-sees-shared', 'A partner or a club sees only check-ins for the activities you share, with these details',
     [('index.html', 'a partner or a club sees your name and your check-ins for the activities you choose: the activity, how long, how it went and any note')],
     [has('src/lib/sync.js', r'share: async \(checkin, commitment\) => \{\s*if \(!commitment\?\.share\) return;'),
      has('src/lib/sync.js', r'title: String\(commitment\.title.*?minutes: Math\.min\(1440, checkin\.minutes\), feel: checkin\.feel, note: ')]),
    ('home-email-stays', "Email is read on the student's computer and is not sent to Cadence or to an AI company",
     [('index.html', 'gmail is read in the chrome extension, on your computer'),
      ('index.html', "your email isn't sent to cadence or to any ai company")],
     [proof_gmail_direct, proof_mail_no_network, proof_assistant_email_off]),
    ('home-assistant-summary', 'What you tell the assistant goes to the AI company with a summary of your week',
     [('index.html', 'your message goes to the ai company that answers it, with a summary of your week')],
     [has('src/lib/agentllm.js', r'<plan>\$\{JSON\.stringify\(\{ \.\.\.planView\(working, now\)')]),

    ('gmail-read-only', 'Gmail is read with a read-only permission; Cadence cannot send, delete or change email',
     [(PRIVACY, "using google's read-only gmail permission: cadence cannot send, delete or change anything in gmail")],
     [proof_gmail_read_only]),

    ('gmail-straight-from-google', "Your browser reads email straight from Google, not through Cadence's server, and none of it is sent to an AI company",
     [(PRIVACY, "your browser reads your email straight from google, without going through cadence's server"),
      (PRIVACY, 'your email is not sent to cadence or to any ai company')],
     [proof_gmail_direct, proof_mail_no_network, proof_assistant_email_off]),

    ('gmail-reads-while-open', 'Email is read only while Cadence is open, after you connect and leave the switch on',
     [(PRIVACY, 'it does this only while cadence is open: when you open it, about every 30 minutes after that, and when you choose check email now')],
     [proof_gmail_while_open]),

    ('gmail-bounded', 'Inbox emails from the last two weeks, up to 25 at a time and 3,000 characters of each; promotions, social, forums, spam, trash and drafts left out',
     [(PRIVACY, 'it reads the text of emails in your inbox from the last two weeks, up to 25 at a time, and up to 3,000 characters of each'),
      (PRIVACY, 'promotions, social and forum mail, spam, trash and drafts are left out')],
     [proof_gmail_bounds]),

    ('gmail-no-attachments', 'Attachments, images and links in an email are never opened',
     [(PRIVACY, 'attachments, images and links in an email are never opened')],
     [proof_gmail_no_attachments]),

    ('gmail-not-saved', 'The Gmail sign-in is never stored; what is found in email stays in this browser, not in the account',
     [(PRIVACY, "the gmail sign-in lasts about an hour and is kept only in memory while cadence is open: it is never written to your device's storage or saved to your account"),
      (PRIVACY, "in your browser's storage only: never in your account or on cadence's server")],
     [proof_gmail_not_saved, proof_mail_stays_on_device]),

    ('mail-found-on-device', 'Events are found on your computer and checked against their email',
     [(PRIVACY, 'the events are found on your computer'),
      (PRIVACY, 'cadence checks each event against its email: the sentence it came from must be in the email, and the date must match that sentence')],
     [proof_mail_no_network, proof_mail_quotes_checked]),

    ('mail-labelled-and-deletable', 'Events from email are labelled, show their sentence, and can be deleted, switched off or removed',
     [(PRIVACY, 'events found in email are added to your calendar, labelled from email, with the sentence each came from'),
      (PRIVACY, 'which events you deleted, so that they are not added again'),
      (PRIVACY, 'switch "add events from email automatically" off, which stops the reading and hides the events, or disconnect gmail')],
     [proof_mail_labelled, proof_disconnect_deletes_mail]),

    ('mail-not-to-google-calendar', 'Nothing found in email is added to Google Calendar',
     [(PRIVACY, 'they are never added to your google calendar')],
     [proof_mail_not_to_google]),

    ('assistant-blind-to-email', 'The assistant does not read email and never sees the events found in it',
     [(PRIVACY, 'the assistant does not read your email, and the events cadence finds in your email are left out of the summary of your week and of everything else sent to the ai model')],
     [proof_assistant_email_off, proof_assistant_never_sees_mail]),

    ('website-asks-extension', 'The website shows email events by asking the extension in the same browser, not through the server',
     [(PRIVACY, 'it can show these events by asking the chrome extension directly, inside your browser, not through cadence\'s server')],
     [proof_bridge_only_own_site]),

    ('gmail-disconnect', 'Disconnecting Gmail makes this device forget it at once',
     [(PRIVACY, 'disconnecting gmail under calendars forgets it straight away')],
     [proof_gmail_disconnect, proof_disconnect_deletes_mail]),
    ('gmail-nobody-reads', "No one at Cadence reads email, and the server keeps no record of it",
     [(PRIVACY, "no one at cadence reads your email, and cadence's server keeps no record of it")],
     [lacks(['netlify/functions/agent.mjs'], r'console\.|writeFile|getStore|blobs|rest/v1/(?!rpc/)', 'the assistant function now logs or stores something'),
      check_fn(proof_agent_server_calls.shows, proof_agent_server_calls)]),

    ('google-limited-use', "Google data follows Google's Limited Use rules and trains no AI model",
     [(PRIVACY, "cadence's use and transfer of information received from google apis, including gmail and google calendar, will adhere to the google api services user data policy, including the limited use requirements"),
      (PRIVACY, 'the use of information received from google apis will adhere to the chrome web store user data policy, including the limited use requirements'),
      (PRIVACY, 'cadence does not use gmail or any other google user data to develop, improve or train ai or machine learning models')],
     [proof_gmail_no_training_model, proof_mail_no_network, proof_assistant_never_sees_mail]),

    ('google-signins-not-stored', "Google's sign-ins are held in memory and never stored",
     [(PRIVACY, "google's sign-in itself is never stored: it is held in memory while cadence is open, and asked for again when it runs out"),
      (PRIVACY, "keys for other services stay on your device, and google's sign-ins are never stored")],
     [proof_google_signins_not_stored]),

    ('policy-change-told', 'A change to who receives what is told in the app before it applies',
     [(PRIVACY, 'if a change affects what is collected or who receives it, signed-in users will be told in the app')],
     [proof_policy_change_told]),

    ('usage-what-is-sent', 'Anonymous usage data sends a random ID with counts and records named in code, and nothing typed, no content, no position and nothing from email',
     [(PRIVACY, 'so that the person who runs cadence can see whether people come back, where they get stuck and what they never find, cadence records anonymously how it is used'),
      (PRIVACY, "never sent: your name, your email, anything you type, what a field contains, the words on what you press, where on the screen you press, mouse movement or scrolling, your plan, titles, messages to the assistant, calendar contents, error messages, and nothing from gmail or email: cadence's email screens and buttons are never recorded")],
     [proof_usage_payload, proof_usage_no_content], 'usage'),

    ('usage-signup-no-id', 'The sign-up screen is counted per day with no ID',
     [(PRIVACY, 'before anyone signs up, the sign-up screen is counted with no id at all')],
     [proof_usage_signup_no_id], 'usage'),

    ('usage-id-stays-here', 'The usage ID lives in its own slot in this browser and is never copied to the account',
     [(PRIVACY, 'the random id lives in your browser in its own storage slot, not in your plan, so it is never copied to your account')],
     [proof_usage_local_id], 'usage'),

    ('usage-consent-and-off', 'Usage data waits for the terms and the notice, never runs in the demo, and can be turned off and deleted',
     [(PRIVACY, 'nothing with the id is recorded in the demo, or until you have agreed to the terms and seen this policy'),
      (PRIVACY, "you can turn it off under account, anonymous usage data: that deletes the id from your browser and asks cadence's server to delete everything recorded with it")],
     [proof_usage_consent_and_off], 'usage'),

    ('usage-owner-only', 'Only the person who runs Cadence can read the usage records, and only as totals',
     [(PRIVACY, 'only the person who runs cadence can read these records, and only as totals: a page in the app that checks their sign-in turns them into counts and averages, and the database refuses to answer anyone else')],
     [proof_usage_owner_only], 'usage'),

    ('usage-kept', 'Counts and sign-up numbers are kept up to 400 days, records of use up to 180, and none can be read with the public key',
     [(PRIVACY, 'the counts are kept for up to 400 days, the records of how the app is used for up to 180 days, and the sign-up numbers for up to 400 days')],
     [proof_usage_kept], 'usage'),

    ('site-assistant-groq', "The site's assistant is Groq, and the privacy page says so",
     [(PRIVACY, 'every message you send the assistant goes to groq, a company that runs ai models')],
     [proof_site_assistant], 'groq'),

    ('site-assistant-gemini', "The site's assistant is Gemini, and the privacy page says so",
     [(PRIVACY, 'every message you send the assistant goes to gemini, an ai model made by google')],
     [proof_site_assistant], 'gemini'),

    ('site-assistant-claude', "The site's assistant is Claude, and the privacy page says so",
     [(PRIVACY, 'every message you send the assistant goes to claude, an ai model made by anthropic')],
     [proof_site_assistant], 'claude'),

    ('groq-keeps-nothing', 'Groq may not train on messages, and keeps none of them',
     [(PRIVACY, "groq's agreement does not permit it to use what it receives to train or fine-tune any ai model"),
      (PRIVACY, "cadence keeps groq's zero data retention setting on, so groq does not store your messages or its replies")],
     [proof_groq_keeps_nothing], 'groq'),
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
    "That Gemini's paid plan, Anthropic's API and Groq do not train on what they receive, as each company's terms say (Groq: Services Agreement section 4.2, June 2026). The script checks that email is offered only with those.",
    "That Groq's zero data retention setting is switched on in Groq's console. GROQ_RETENTION=zero in Netlify is the owner's word for it; the script checks that Groq is never used without that word.",
    "That every way an email can hide text is caught. Cadence removes the common ones (hidden, aria-hidden, display:none, zero size or opacity, and simple .class or #id rules in a style block); the page says \"where Cadence can tell\".",
    "That Gmail reading works against a real Google account. It needs the Gmail API switched on and the read-only scope added to the OAuth client, and was not run against a live mailbox before release.",
    "That anonymous usage counts are accurate. Anyone can send the request, so they are estimates, not a meter; and Netlify, as the web host, sees ordinary web requests (an IP address) like any host, which the privacy page says.",
    "That Chrome's on-device AI model sends nothing to Google. Cadence calls it and nothing else; that it stays on the computer is Chrome's own documentation (developer.chrome.com/docs/ai/prompt-api).",
    "How accurate Chrome's on-device model is at finding events in email. Every event is checked against its email in code, but the model's own hits and misses have not been measured, and the real model has not been run against real mail.",
    "That the extension and the website exchange these messages only inside the browser. Chrome's messaging does that; the script checks that only Cadence's own address may ask the extension, and what the extension answers.",
]




# ------------------------------------------------------------------- running it

def usage_on(root=ROOT):
    """Whether src/config.js switches anonymous usage counts (lib/metrics.js) on."""
    return bool(re.search(r'\bcountUsage:\s*true\b', code(root, 'src/config.js')))


def site_assistant(root=ROOT):
    """The company src/config.js names for the site's assistant: groq, gemini or claude ('' if none)."""
    m = re.search(r"\bassistant:\s*'([a-z]+)'", code(root, 'src/config.js'))
    return m.group(1) if m else ''


def run(root=ROOT):
    """Returns (rows, failures): rows are (id, name, says, proof shows), failures are strings.
    A claim with a fifth element applies only when the site's assistant is that
    company (src/config.js); the page then shows that wording and hides the rest."""
    pages = {}
    rows, failures = [], []
    ai = site_assistant(root)
    for cid, name, says, proofs, *when in CLAIMS:
        if when and (usage_on(root) != (when[0] == 'usage') if when[0] in ('usage', 'no-usage') else when[0] != ai):
            continue
        for page, phrase in says:
            pages.setdefault(page, page_text(root, page))
            if plain(phrase) not in pages[page]:
                failures.append(f'{cid}: {page} no longer says "{phrase}"')
        for proof in proofs:
            why = proof(root)
            if why:
                failures.append(f'{cid}: {why}')
        rows.append((cid, name, [p for _, p in says], [pr.shows for pr in proofs]))
    for iid, _, proofs in INVARIANTS:
        for proof in proofs:
            why = proof(root)
            if why:
                failures.append(f'{iid}: {why}')
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
    try:
        connectable = (json.loads(read(root, 'manifest.json') or '{}').get('externally_connectable') or {})
    except ValueError:
        connectable = {'unreadable': True}
    return {
        'web_pages_that_can_ask_the_extension': sorted(connectable.get('matches') or []) + sorted(f'extension {i}' for i in connectable.get('ids') or []),
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
        '## Rules about email the code must keep',
        '',
        'Checked on every run, whatever the pages say:',
        '',
        '| Rule | What the code must do |',
        '| --- | --- |',
        *[f'| {name} | {"<br>".join(pr.shows.replace("|", "/") for pr in proofs)} |' for _, name, proofs in INVARIANTS],
        '',
        '## What counts as the data surface',
        '',
        '`claims.lock.json` records the browser storage keys, the outside hosts, the database',
        'tables, the part of the plan copied to an account, and the web pages that may ask the',
        'extension for anything (manifest.json externally_connectable). Changing any of them fails the',
        'check until `privacy.html` and its date are updated and `--accept` is run in the same commit.',
        '',
    ]
    return '\n'.join(out)


# -------------------------------------------------------------------- self-test

def selftest():
    """Copy the site, break one thing at a time, and check the right claim fails."""
    need = ['privacy.html', 'index.html', 'contact.html', 'terms.html', 'thanks.html', '404.html', 'app.html', 'demo.html',
            'site.js', 'sw.js', 'netlify.toml', 'claims.lock.json', 'manifest.json', 'src', 'netlify', 'supabase']
    mutations = [
        ('a sentence on the privacy page is reworded', PRIVACY, 'Cadence does not set cookies', 'Cadence rarely sets cookies', 'no-cookies'),
        ('chats get sent to the account copy', 'src/lib/cloud.js', 'delete out.plan;', 'delete out.plan; out.chats = 1; // chats', 'chats-stay-here'),
        ('the password is logged on a server function', 'netlify/functions/agent.mjs', "anthropic: process.env.ANTHROPIC_API_KEY };", "anthropic: process.env.ANTHROPIC_API_KEY }; const x = 'password';", 'password-never-handled'),
        ('deleting wipes the browser before the server', 'src/panel/views/account.js', "try { await app.cloud.rest('rpc/delete_my_account'", "await signOut({ wipe: true, force: true }); try { await app.cloud.rest('rpc/delete_my_account'", 'delete-is-real'),
        ('a table stops cascading on account deletion', 'supabase/schema.sql', 'user_id uuid not null references profiles on delete cascade default auth.uid(),\n  ', 'user_id uuid not null references profiles default auth.uid(),\n  ', 'delete-is-real'),
        ('an analytics script appears', 'index.html', '</head>', '<script src="https://stats.example.com/a.js"></script></head>', 'no-ads-or-analytics'),
        ('the AI model starts seeing Google event titles', 'src/lib/agentops.js', "? 'Busy' : b.title", ': b.title', 'ai-sees-no-google-titles'),
        ('Cadence starts editing any Google event', 'src/lib/sources/googleCalendar.js', 'const mine = await listOwnBlocks(token, calendarId, { daysAhead, daysBack: 400 });', 'const mine = await listAllEvents(token, calendarId);', 'google-only-own-events'),
        ('the assistant adds things straight from email', 'src/lib/agentllm.js', 'if (call.input?.preview === true || readMail) {', 'if (call.input?.preview === true) {', 'assistant-email-hold'),
        ('the site lets free Gemini read email', 'src/lib/providers.js', "const email = provider === 'anthropic' || provider === 'groq' || (provider === 'gemini' && plan === 'paid');", 'const email = true;', 'assistant-email-providers'),
        ('Gmail is asked for permission to send', 'src/lib/sources/gmail.js', "export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';", "export const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';", 'gmail-read-only'),
        # Which assistant claims apply follows src/config.js, so these follow it too.
        *([('Groq runs without zero data retention confirmed', 'src/lib/providers.js', "keys.groq && kept === 'zero' ? 'groq' : null", "keys.groq ? 'groq' : null", 'groq-keeps-nothing')]
          if site_assistant() == 'groq' else []),
        ('the server stops following src/config.js', 'netlify/functions/agent.mjs', 'pickProvider(CONFIG.assistant',
         f"pickProvider('{'gemini' if site_assistant() == 'groq' else 'groq'}'", f'site-assistant-{site_assistant()}'),
        ('the assistant reads email without asking', 'src/panel/views/agent.js', "if (ok?.get('op') !== 'read') throw", "if (false) throw", 'assistant-email-asks-first'),
        ('saved chats keep the emails', 'src/lib/chats.js', 'withoutEmails(c.messages || [])', '(c.messages || [])', 'assistant-email-not-in-chats'),
        ('the Gmail sign-in is written to storage', 'src/lib/sources/gmail.js', 'let held = null;', "let held = null; try { localStorage.setItem('x', '1'); } catch {}", 'gmail-not-saved'),
        ('the background sync may open the sign-in window', 'src/background/service-worker.js', 'runAll(state, { interactive: false })', 'runAll(state, {})', 'google-signins-not-stored'),
        ('the Calendar sign-in is written to storage', 'src/lib/sources/googleCalendar.js', 'let held = null;', "let held = null; try { chrome.storage.local.set({ t: 1 }); } catch {}", 'google-signins-not-stored'),
        ('the hold on changes ends after one reply', 'src/lib/agentllm.js', 'let readMail = !chosen && holdsEmail(messages);', 'let readMail = false;', 'assistant-email-hold'),
        ('any button lifts the hold, not only offered choices', 'src/panel/views/agent.js', "send(el.dataset.text, { chosen: el.dataset.chosen === '1' })", 'send(el.dataset.text, { chosen: true })', 'assistant-email-hold'),
        ('one yes to read email lasts the whole session', 'src/panel/views/agent.js', 'const allowed = new Set();', 'const allowed = window.__allowed ||= new Set();', 'assistant-email-asks-first'),
        ('sheets can take over each other', 'src/panel/ui.js', 'if (dlg.open) return new Promise', 'if (false) return new Promise', 'assistant-email-asks-first'),
        ('withoutEmails stops removing anything', 'src/lib/chats.js', 'content: EMAILS_LEFT_OUT', 'content: b.content', 'assistant-email-not-in-chats'),
        ('the Google token is spread into the plan', 'src/panel/views/calendars.js', 'enabled: true, email: me.email, calendars,', '...token, enabled: true, email: me.email, calendars,', 'google-signins-not-stored'),
        ('a quiet refresh may open the sign-in window', 'src/panel/core.js', 'interactive: !quiet,', 'interactive: true,', 'google-signins-not-stored'),
        ('read_email is added to the default tools', 'src/lib/agentspec.js', "tool('offer_choices',", "EMAIL_TOOL_PLACEHOLDER_read_email, tool('offer_choices',", 'assistant-email-providers'),
        ('email goes to any Groq model', 'netlify/functions/agent.mjs', "(provider !== 'groq' || GROQ_PRODUCTION_MODELS.includes(groqModel()))", "(true)", 'assistant-email-providers'),
        ('more than 10 emails are read', 'src/lib/sources/gmail.js', '.slice(0, LIMITS.messages)', '.slice(0, 50)', 'gmail-bounded'),
        ('an expired token is "revoked"', 'src/lib/sources/gmail.js', 'Date.now() < held.expiresAt ? held.accessToken : null', 'held?.accessToken || null', 'gmail-disconnect'),
        ('the model is sent the student address', 'src/lib/agentllm.js', 'const { account, ...asked } = got || {};', 'const asked = got || {};', 'assistant-email-fields'),
        ('the policy notice is skipped', 'src/panel/views/agent.js', 'if (via && needsPolicyNotice() && !(await policyNotice()))', 'if (false)', 'policy-change-told'),
        ('a quiet email check may open the sign-in window', 'src/panel/core.js', 'token = await gmail.freshToken(account, clientId, { interactive: !quiet });', 'token = await gmail.freshToken(account, clientId, { interactive: true });', 'google-signins-not-stored'),
        ('email events get copied to the account', 'src/lib/cloud.js', 'out.sources = structuredClone(DEFAULT_STATE.sources);', 'out.sources = structuredClone(state.sources);', 'mail-stays-on-device'),
        ('crew sync reaches for the email events', 'src/lib/sync.js', 'export function createSync(', 'const leak = (st) => st.sources?.mail; export function createSync(', 'mail-stays-on-device'),
        ('the homepage example saves its made-up email event', 'src/site/evening.js', 'export function startingWeek() {', "export function startingWeek() { localStorage.setItem('sam', '1');", 'mail-stays-on-device'),
        ('an Undo brings back old email events', 'src/panel/core.js', 'mail: stored.sources?.mail || snapshot.sources?.mail', 'mail: snapshot.sources?.mail', 'mail-stays-on-device'),
        ('the email events code makes a request', 'src/lib/mailEvents.js', 'const MIN = 60 * 1000;', "const MIN = 60 * 1000; fetch('https://example.com/x');", 'mail-no-network'),
        ('the website bridge logs what it gets', 'src/panel/mailbridge.js', 'const EVERY = 5 * 60 * 1000;', 'const EVERY = 5 * 60 * 1000; console.log(1);', 'mail-no-network'),
        ('a quote no longer has to be in the email', 'src/lib/mailEvents.js', "if (!quoteIn(quote, message.text)) return { why: 'quote is not in the email' };", '', 'mail-quotes-checked'),
        ('the date no longer has to match the quote', 'src/lib/mailEvents.js', "if (!agrees(date, quote, arrived, order)) return { why: 'the date does not match the quote' };", '', 'mail-quotes-checked'),
        ('the assistant is shown the real plan', 'src/lib/agentllm.js', 'const view = forAssistant(state);', 'const view = state;', 'assistant-never-sees-mail'),
        ('the server reads email events', 'netlify/functions/agent.mjs', "const keys = { groq:", "const seen = body => body?.sources?.mail; const keys = { groq:", 'assistant-never-sees-mail'),
        ('email events go to Google Calendar', 'src/lib/replanner.js', 'export function pushableBlocks(st, { daysAhead = 21 } = {}) {', 'export function pushableBlocks(st, { daysAhead = 21 } = {}) { const extra = st.sources.mail;', 'mail-not-to-google-calendar'),
        ('disconnecting keeps the email events', 'src/panel/views/calendars.js', '    st.sources.mail = blankMail();\n  }, { edit: false });\n  let cancelled', '  }, { edit: false });\n  let cancelled', 'disconnect-deletes-mail'),
        ('any site may ask the extension', 'manifest.json', '"https://cadenceaiplanning.netlify.app/*"', '"https://*/*"', 'bridge-only-own-site'),
        ('the extension stops checking the origin', 'src/background/service-worker.js', 'sender?.origin !== origin || ', '', 'bridge-only-own-site'),
        ('the website is sent the sender address', 'src/lib/mailShare.js', 'quote: m.quote, from: String(m.from', 'quote: m.quote, fromKey: m.fromKey, from: String(m.from', 'bridge-only-own-site'),
        ('the assistant may read email again', 'src/config.js', 'emailToAssistant: false,', 'emailToAssistant: true,', 'assistant-email-off'),
        ('the model is sent the real plan', 'src/lib/agentllm.js', '...planView(working, now)', '...planView(state, now)', 'assistant-never-sees-mail'),
        ('a tool answers from the real plan', 'src/lib/agentllm.js', 'const r = toOps(call.name, call.input, working, now);', 'const r = toOps(call.name, call.input, state, now);', 'assistant-never-sees-mail'),
        ('the account copy carries every source', 'src/lib/cloud.js', 'const data = portable(state);', 'const data = { ...portable(state), sources: state.sources };', 'mail-stays-on-device'),
        ('crew sync reads the calendar events', 'src/lib/sync.js', 'export function createSync(', 'const busyOf = (st) => sourceEvents(st); export function createSync(', 'mail-stays-on-device'),
        ('Google Calendar is sent the email events', 'src/lib/sources/sources.js', 'const desired = pushableBlocks(state, { daysAhead });', 'const desired = [...pushableBlocks(state, { daysAhead }), ...sourceEvents(state)];', 'mail-not-to-google-calendar'),
        ('the website is sent raw events', 'src/lib/mailShare.js', 'events: enabled ? (mail.events || []).map(forSite) : []', 'events: enabled ? (mail.events || []) : []', 'bridge-only-own-site'),
        ('a second way in for web pages', 'src/background/service-worker.js', 'chrome.runtime.onMessage.addListener((msg, _sender, respond) => {', 'chrome.runtime.onConnectExternal.addListener(() => {}); chrome.runtime.onMessage.addListener((msg, _sender, respond) => {', 'bridge-only-own-site'),
        ('an email event is handed to the assistant', 'src/panel/views/mail.js', "'open-mail-event': (el) => mailEventSheet(el.dataset.id)", "'open-mail-event': (el) => { mailEventSheet(el.dataset.id); document.dispatchEvent(new CustomEvent('cadence:act', { detail: { act: 'agent-say', text: el.dataset.id } })); }", 'mail-no-network'),
        ('any 12 characters pass as a quote', 'src/lib/mailEvents.js', 'return q.length >= MAIL_LIMITS.quoteMin && plain(text).includes(q);', 'return q.length >= MAIL_LIMITS.quoteMin || plain(text).includes(q);', 'mail-quotes-checked'),
        ('Gemini is offered read_email directly', 'src/lib/gemini.js', 'toolsFor({ email })', '[...TOOLS, EMAIL_TOOL]', 'assistant-email-off'),
        ('usage counts also send the name', 'src/lib/metrics.js', 'if (!(await send({ id: rec.id, event }))) continue;', 'if (!(await send({ id: rec.id, event, name: state.profile.name }))) continue;', 'usage-what-is-sent'),
        ('a Gmail connection counts as a calendar', 'src/lib/metrics.js', "id !== 'mail' && s?.enabled", 's?.enabled', 'usage-what-is-sent'),
        ('the usage function reads the IP address', 'netlify/functions/metric.mjs', 'const done = (status)', "const ip = (r) => r.headers.get('x-forwarded-for'); const done = (status)", 'usage-what-is-sent'),
        ('the usage function passes on every field', 'netlify/functions/metric.mjs', 'const out = { q: r.q, k: r.k, n: r.n };', 'const out = { ...r };', 'usage-what-is-sent'),
        ('a record keeps the plan', 'src/lib/metrics.js', 'if (clean(screen)) rec.s = screen;', 'if (clean(screen)) rec.s = screen; rec.t = name;', 'usage-what-is-sent'),
        ('the tracker reads what is typed', 'src/panel/insight.js', 'const signinForm = (el)', 'const typed = (el) => el.value; const signinForm = (el)', 'usage-what-is-sent'),
        ('the tracker records where on the screen', 'src/panel/insight.js', 'const target = ctl || el;', 'const target = ctl || el; const at = ev.clientX;', 'usage-what-is-sent'),
        ('the tracker reads the words on a button', 'src/panel/insight.js', "} else name = `${el.tagName.toLowerCase()}", "} else name = el.textContent || `${el.tagName.toLowerCase()}", 'usage-what-is-sent'),
        ('the tracker records sheets about email', 'src/panel/insight.js', ' || emailOpen()) return false;', ') return false;', 'usage-what-is-sent'),
        ('an email event sheet loses its marker', 'src/panel/views/mail.js', '<h2 data-about="email">${esc(e.title)}</h2>', '<h2>${esc(e.title)}</h2>', 'usage-what-is-sent'),
        ('the tracker reaches the plan', 'src/panel/insight.js', "import { CONFIG } from '../config.js';", "import { CONFIG } from '../config.js';\nimport { app } from './core.js';", 'usage-what-is-sent'),
        ('sign-up counts carry the ID', 'src/lib/metrics.js', 'return send({ steps: [name] });', 'return send({ steps: [name], id: known?.id });', 'usage-signup-no-id'),
        ('usage counts ignore whether the terms were agreed', 'src/lib/metrics.js', '!!state?.profile?.consentedAt\n    && ', '', 'usage-consent-and-off'),
        ('records are kept before agreeing', 'src/lib/metrics.js', 'if (!allowed || !KINDS.includes(kind)', 'if (!KINDS.includes(kind)', 'usage-consent-and-off'),
        ('time on the sign-up screen is recorded', 'src/panel/insight.js', "!screen.startsWith('signin') && spent >= 500", 'spent >= 500', 'usage-consent-and-off'),
        ('the tracker runs in the demo', 'src/panel/insight.js', 'if (on || isDemo || embedded) return;', 'if (on) return;', 'usage-consent-and-off'),
        ('turning it off keeps the records', 'supabase/schema.sql', '  delete from ux_events where install_id = p_id;\n', '', 'usage-consent-and-off'),
        ('sign out keeps the usage ID', 'src/panel/core.js', 'await forgetUsage();', 'await Promise.resolve();', 'usage-consent-and-off'),
        ('anyone signed in may read insights', 'supabase/schema.sql', "if auth.uid() is null or not exists (select 1 from owners where user_id = auth.uid()) then\n    raise exception 'not allowed';", "if auth.uid() is null then\n    raise exception 'not allowed';", 'usage-owner-only'),
        ('insights is granted to visitors', 'supabase/schema.sql', 'grant execute on function count_visit(text, text, text) to anon, authenticated;', 'grant execute on function count_visit(text, text, text) to anon, authenticated;\ngrant execute on function insights(integer) to anon;', 'usage-owner-only'),
        ('insights returns whole rows', 'supabase/schema.sql', "'overview', (select to_jsonb(q) from (", "'overview', (select to_jsonb(u) from usage_events u limit 1), 'overview_totals', (select to_jsonb(q) from (", 'usage-owner-only'),
        ('anyone can read the owners list', 'supabase/schema.sql', 'alter table owners enable row level security;', 'alter table owners enable row level security;\ncreate policy "anyone reads owners" on owners for select using (true);', 'usage-owner-only'),
        ('the Insights page keeps the totals in the browser', 'src/panel/views/insights.js', "state.at = new Date();", "state.at = new Date(); localStorage.setItem('x', JSON.stringify(state.data));", 'usage-owner-only'),
        ('the Insights page opens in the extension too', 'src/panel/app.js', "if (STANDALONE && !DEMO && !EMBEDDED && new URLSearchParams(location.search)", "if (!DEMO && !EMBEDDED && new URLSearchParams(location.search)", 'usage-owner-only'),
        ('the owner is counted as a student', 'src/panel/insight.js', "if (screen === 'insights' || String(name).startsWith('insights')) return false;", '', 'usage-owner-only'),
        ('usage counts never expire', 'supabase/schema.sql', 'delete from usage_events where day < current_date - 400;', 'select 1;', 'usage-kept'),
        ('records of use never expire', 'supabase/schema.sql', "delete from ux_events where at < now() - interval '180 days';", 'select 1;', 'usage-kept'),
        ('the usage ID is made part of the plan', 'src/lib/store.js', '  autoSync: { enabled: true, everyMinutes: 20, lastRun: null },', "  autoSync: { enabled: true, everyMinutes: 20, lastRun: null },\n  usage: { id: '' },", 'usage-id-stays-here'),
        ('a new browser storage key is added', 'src/lib/chats.js', "const keyFor = (bucket) => `cadence.chats.${bucket}.v1`;", "const keyFor = (bucket) => `cadence.chats.${bucket}.v1`; const extra = 'cadence.new-thing';", 'LOCK'),
    ]
    def site_copy(tmp):
        for n in need:
            src = ROOT / n
            if src.is_dir():
                shutil.copytree(src, tmp / n, ignore=shutil.ignore_patterns('fonts', '__pycache__'))
            elif src.is_file():
                shutil.copy2(src, tmp / n)

    # A break counts as caught only when it adds a failure that was not there
    # before it: a claim that already fails (while its page is being reworded)
    # does not get the credit, and its breaks show as misses until it holds again.
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        site_copy(tmp)
        baseline = set(run(tmp)[1])
        baseline_surface = fingerprint(surface(tmp))
    if baseline:
        print(f'  ({len({f.split(":")[0] for f in baseline})} claims or rules already fail without any break; their breaks count only if they add a new failure)')
    failed = 0
    for what, rel, old, new, expect in mutations:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            site_copy(tmp)
            text = (tmp / rel).read_text()
            if old not in text:
                print(f'  SKIP  {what}: the text to break is not in {rel} any more (update the self-test)')
                failed += 1
                continue
            (tmp / rel).write_text(text.replace(old, new, 1))
            if expect == 'LOCK':
                caught = fingerprint(surface(tmp)) != baseline_surface and not lock_status(tmp)[0]
            else:
                _, fails = run(tmp)
                caught = any(f.startswith(expect + ':') and f not in baseline for f in fails)
            print(f'  {"ok  " if caught else "MISS"}  {what}' + ('' if caught else f' ({expect} added no new failure)'))
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
    invariant_ids = {iid for iid, _, _ in INVARIANTS}
    claim_fails = {f.split(':')[0] for f in failures if f.split(':')[0] not in invariant_ids}
    rule_fails = {f.split(':')[0] for f in failures if f.split(':')[0] in invariant_ids}
    if '--markdown' in argv:
        (ROOT / 'CLAIMS.md').write_text(markdown(rows))
        print(f'CLAIMS.md written: {len(rows)} claims.')
    for f in failures:
        print('  FAIL  ' + f)
    ok, detail = lock_status()
    if not ok:
        print('  FAIL  ' + detail)
    print(f'{len(rows)} claims: {len(rows) - len(claim_fails)} hold'
          + (f', {len(claim_fails)} do not.' if claim_fails else '.')
          + f' {len(INVARIANTS)} rules about email: {len(INVARIANTS) - len(rule_fails)} hold'
          + (f', {len(rule_fails)} do not.' if rule_fails else '.')
          + ('' if ok else ' The data surface has changed.'))
    return 1 if failures or not ok else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
