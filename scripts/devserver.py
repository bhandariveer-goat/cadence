#!/usr/bin/env python3
"""Local server for working on Cadence.

    python3 scripts/devserver.py [port]

Serves the repo the way Netlify does (static files from the root), with two
differences that matter while developing:

  * every response is sent with Cache-Control: no-store, so an edited module is
    always the one the browser runs;
  * with --mock it also answers the two backends Cadence talks to, so sign-in,
    sync and the assistant can be exercised without a Supabase project or an
    Anthropic key. The mock keeps everything in memory and accepts any
    six-digit code. It also stands in for Netlify Forms, so the contact page
    can be sent: without --mock a form post gets the 404 it would get on a
    Netlify site where forms have not been switched on.

Like Netlify, it serves 404.html (with a 404 status) for an address that does
not exist, and each page at its clean address: /privacy is privacy.html.
"""
import json
import re
import sys
import time
import uuid
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
MOCK = '--mock' in sys.argv


def _site_headers():
    """The headers netlify.toml sets for every path, read from the file."""
    import re
    text = (Path(__file__).resolve().parent.parent / 'netlify.toml').read_text()
    block = re.search(r'for = "/\*"\s*\[headers\.values\](.*?)(?:\n\[|\Z)', text, re.S)
    if not block:
        return []
    return [(k, v) for k, v in re.findall(r'^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$', block.group(1), re.M)]


SITE_HEADERS = _site_headers()
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8123)

USERS = {}      # email -> user id
TOKENS = {}     # access token -> {id, email}
PASSWORDS = {}  # email -> the test password set on that mock account
PROVED = set()  # mock accounts that have typed the code for a password change
ROWS = {}       # user id -> {data, updated_at}
PROFILES = {}   # user id -> row
USAGE = {}      # user id -> count
INVITES = {}
CSP_REPORTS = []
MOCK_CLUB = {'id': '00000000-0000-4000-8000-00000000c1ab', 'name': 'Robotics'}
AGENT_CALLS = []
VISITS = {}     # "source|medium|campaign" -> count
ENQUIRIES = []  # what the contact form sent, minus anything a bot filled in
LABEL = re.compile(r'^[a-z0-9_-]{0,40}$')


def _moment(stamp):
    """A timestamp as a number, so '...Z' and '...+00:00' compare equal."""
    try:
        return datetime.fromisoformat(str(stamp).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return str(stamp)



def mock_feed_kind(raw):
    """Which calendar a link is, by the same rules as feedAddress() in
    netlify/functions/canvas-feed.mjs, or None when it would be refused."""
    from urllib.parse import urlparse
    raw = raw.strip()
    if raw.lower().startswith('webcal:'):
        raw = 'https:' + raw[7:]
    try:
        u = urlparse(raw)
    except ValueError:
        return None
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.port:
        return None
    host, path = u.hostname.lower(), u.path
    if '.' not in host or host == 'localhost' or re.fullmatch(r'[\d.]+', host):
        return None
    if re.fullmatch(r'/feeds/calendars/[A-Za-z0-9_.-]+\.ics', path):
        return 'Canvas'
    if host == 'calendar.google.com' and re.fullmatch(r'/calendar/ical/[A-Za-z0-9%._@+-]+/(private-[a-z0-9]+|public)/basic\.ics', path):
        return 'Google Calendar'
    if host in ('outlook.office365.com', 'outlook.office.com', 'outlook.live.com') and re.fullmatch(r'/owa/calendar/[A-Za-z0-9%._@+-]+/[A-Za-z0-9%._+-]+(/cid-[A-Za-z0-9]+)?/(reach)?calendar\.ics', path):
        return 'Outlook'
    if re.fullmatch(r'p\d{1,3}-(caldav|calendars)\.icloud\.com', host) and re.fullmatch(r'/published/\d{1,2}/[A-Za-z0-9_-]{16,}', path):
        return 'iCloud'
    return None

class Handler(SimpleHTTPRequestHandler):
    # Serves files from the repository root.
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    # Every reply: never cached, and with the live site's security headers.
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        # The same security headers the live site sends (netlify.toml), so a
        # page that breaks them breaks here first. Locally the Supabase stand-in
        # is this server, which 'self' already allows.
        for name, value in SITE_HEADERS:
            # In mock mode the browser also reports anything the policy blocks
            # to this server: GET /mock/csp-reports lists them.
            if MOCK and name == 'Content-Security-Policy':
                value += '; report-uri /mock/csp-report'
            self.send_header(name, value)
        super().end_headers()

    # Quiet, except for the mock account and API calls, which are worth seeing.
    def log_message(self, fmt, *args):
        if MOCK and ('/auth/' in self.path or '/rest/' in self.path or '/api/' in self.path):
            sys.stderr.write('mock %s\n' % (fmt % args))

    # ------------------------------------------------------------ helpers
    # A JSON reply, readable from any origin (as the real services are).
    def _json(self, status, body, extra=None):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Access-Control-Allow-Origin', '*')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    # The request's JSON body, or {} if it has none or it is not JSON.
    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b'{}')
        except ValueError:
            return {}

    # The mock user a request's bearer token belongs to, if any.
    def _user(self):
        auth = self.headers.get('Authorization', '')
        return TOKENS.get(auth.replace('Bearer ', '', 1))

    # A new mock sign-in for an email, in the shape Supabase answers with.
    def _session(self, email):
        uid = USERS.setdefault(email, str(uuid.uuid4()))
        token = 'tok_' + uuid.uuid4().hex
        TOKENS[token] = {'id': uid, 'email': email}
        return {'access_token': token, 'refresh_token': 'ref_' + token, 'expires_in': 3600,
                'user': {'id': uid, 'email': email}}

    # ------------------------------------------------------------- routes
    # The CORS preflight the browser sends before a cross-origin call.
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'authorization, apikey, content-type, prefer')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
        self.end_headers()

    def send_error(self, code, message=None, explain=None):
        # An address with nothing at it gets the site's own 404 page, as it
        # does on Netlify, and still says 404.
        page = ROOT / '404.html'
        if code == 404 and page.is_file() and self.command in ('GET', 'HEAD'):
            raw = page.read_bytes()
            self.send_response(404)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            if self.command == 'GET':
                self.wfile.write(raw)
            return
        super().send_error(code, message, explain)

    # GET: the mock's inspection pages (visits, enquiries, CSP reports), the mock
    # services in --mock mode, otherwise a file from the repository.
    def do_GET(self):
        path = urlparse(self.path).path
        if MOCK and path == '/mock/visits':
            return self._json(200, VISITS)
        if MOCK and path == '/mock/enquiries':
            return self._json(200, ENQUIRIES)
        if MOCK and path == '/mock/csp-reports':
            return self._json(200, CSP_REPORTS)
        if MOCK and path.startswith('/mock/'):
            return self._mock('GET', path[5:])
        if MOCK and path == '/src/config.js':
            return self._mock_config()
        self._clean_address()
        return super().do_GET()

    def _mock_config(self):
        """src/config.js with the Supabase project swapped for this server's
        stand-in, in memory only. Testing sign-in, sync, the assistant or the
        Canvas feed locally used to mean editing config.js, which could then be
        committed by mistake and ship a site that signs in to localhost."""
        import re
        text = (ROOT / 'src' / 'config.js').read_text()
        host = self.headers.get('Host') or f'localhost:{PORT}'
        text = re.sub(r"supabaseUrl:\s*'[^']*'", f"supabaseUrl: 'http://{host}/mock'", text, count=1)
        text = re.sub(r"supabaseKey:\s*'[^']*'", "supabaseKey: 'sb_publishable_mockmockmockmockmockmock'", text, count=1)
        raw = text.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/javascript; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    # HEAD: the same clean addresses as GET.
    def do_HEAD(self):
        self._clean_address()
        return super().do_HEAD()

    def _clean_address(self):
        """The same clean addresses netlify.toml sets up: /app is app.html."""
        parts = urlparse(self.path)
        name = parts.path.strip('/')
        if name and '.' not in name and '/' not in name and (ROOT / f'{name}.html').is_file():
            self.path = f'/{name}.html' + (('?' + parts.query) if parts.query else '')

    # POST: CSP reports, form sends and the mock services in --mock mode.
    def do_POST(self):
        path = urlparse(self.path).path
        if MOCK and path == '/mock/csp-report':
            n = int(self.headers.get('Content-Length') or 0)
            try:
                report = json.loads(self.rfile.read(n) or b'{}').get('csp-report', {})
            except ValueError:
                report = {}
            CSP_REPORTS.append({k: report.get(k) for k in ('document-uri', 'violated-directive', 'blocked-uri', 'source-file', 'line-number')})
            self.send_response(204)
            self.end_headers()
            return
        if MOCK and path.startswith('/mock/'):
            return self._mock('POST', path[5:])
        if MOCK and path == '/api/agent':
            return self._agent()
        if MOCK and path == '/api/visit':
            return self._visit()
        if MOCK and path == '/api/canvas-feed':
            return self._canvas_feed()
        if MOCK and 'application/x-www-form-urlencoded' in self.headers.get('Content-Type', ''):
            return self._form(path)
        self._json(404, {'message': 'not found'})

    do_PATCH = do_POST
    do_PUT = do_POST

    # The stand-ins for Supabase (sign-in with a code, the saved plan, Crew) and
    # Cadence's server functions, kept in memory for as long as the server runs.
    def _mock(self, method, path):
        body = self._body() if method != 'GET' else {}
        query = urlparse(self.path).query

        if path == '/auth/v1/otp':
            email = str(body.get('email', ''))
            if '@' not in email:
                return self._json(422, {'error_code': 'validation_failed', 'msg': 'Unable to validate email address: invalid format'})
            # Two addresses stand in for the two ways a real project refuses:
            # its built-in email only reaches the project's own team, and it
            # sends only a couple of emails an hour.
            if email.startswith('outsider@'):
                return self._json(400, {'code': 400, 'error_code': 'email_address_not_authorized', 'msg': 'Email address not authorized'})
            if email.startswith('toomany@'):
                return self._json(429, {'code': 429, 'error_code': 'over_email_send_rate_limit', 'msg': 'email rate limit exceeded'})
            return self._json(200, {})
        if path == '/auth/v1/verify':
            token = str(body.get('token', ''))
            if not token.isdigit() or not 6 <= len(token) <= 10 or token.startswith('000'):
                return self._json(403, {'code': 403, 'error_code': 'otp_expired', 'msg': 'Token has expired or is invalid'})
            return self._json(200, self._session(body.get('email')))
        if path == '/auth/v1/signup' and not body.get('email'):
            # A hidden anonymous account, as a name-only student gets.
            return self._json(200, self._session(f'anon-{uuid.uuid4().hex[:8]}@mock'))
        if path == '/auth/v1/token' and 'grant_type=password' in query:
            email = str(body.get('email', '')).lower()
            if PASSWORDS.get(email) is None or PASSWORDS[email] != body.get('password'):
                return self._json(400, {'code': 400, 'error_code': 'invalid_credentials', 'msg': 'Invalid login credentials'})
            return self._json(200, self._session(email))
        if path == '/auth/v1/reauthenticate':
            who = self._user()
            if not who:
                return self._json(401, {'msg': 'invalid JWT'})
            return self._json(200, {})
        if path == '/auth/v1/user' and self.command == 'PUT':
            # A password set or changed. Mock accounts whose email starts with
            # "secure@" stand in for a project that wants a code first: the
            # change needs nonce 123456, as one sent by /reauthenticate.
            who = self._user()
            if not who:
                return self._json(401, {'msg': 'invalid JWT'})
            password = str(body.get('password', ''))
            if len(password) < 8:
                return self._json(422, {'code': 422, 'error_code': 'weak_password', 'msg': 'Password should be at least 8 characters.', 'weak_password': {'reasons': ['length']}})
            if who['email'].startswith('secure@') and body.get('nonce') != '123456':
                if body.get('nonce'):
                    return self._json(400, {'code': 400, 'error_code': 'reauthentication_not_valid', 'msg': 'Verification code is not valid'})
                return self._json(400, {'code': 400, 'error_code': 'reauthentication_needed', 'msg': 'Password update requires reauthentication'})
            if PASSWORDS.get(who['email']) == password:
                return self._json(422, {'code': 422, 'error_code': 'same_password', 'msg': 'New password should be different from the old password.'})
            PASSWORDS[who['email']] = password
            return self._json(200, {'id': who['id'], 'email': who['email']})
        if path == '/auth/v1/token':
            old = str(body.get('refresh_token', '')).replace('ref_', '', 1)
            who = TOKENS.get(old)
            if not who:
                return self._json(400, {'error_description': 'Invalid Refresh Token'})
            return self._json(200, self._session(who['email']))
        if path == '/auth/v1/user':
            who = self._user()
            return self._json(200, who) if who else self._json(401, {'msg': 'invalid JWT'})

        who = self._user()
        if not who:
            return self._json(401, {'message': 'JWT expired'})

        if path == '/rest/v1/planner_state':
            # Enough of PostgREST to exercise what lib/cloud.js relies on:
            # a filtered PATCH that changes nothing returns [], and an insert
            # with ignore-duplicates returns [] when the row already exists.
            row = ROWS.get(who['id'])
            prefer = self.headers.get('Prefer', '')
            want = (parse_qs(query).get('updated_at') or [''])[0]
            if method == 'GET':
                return self._json(200, [row] if row else [])
            stamp = body.get('updated_at') or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            if self.command == 'PATCH':
                if not row or (want and _moment(want[3:]) != _moment(row['updated_at'])):
                    return self._json(200, [])
                row.update({'data': body.get('data', row['data']), 'updated_at': stamp})
                return self._json(200, [{'updated_at': stamp}])
            if row and 'ignore-duplicates' in prefer:
                return self._json(201, [])
            ROWS[who['id']] = {'user_id': who['id'], 'data': body.get('data'), 'updated_at': stamp}
            return self._json(201, [{'updated_at': stamp}])
        if path == '/rest/v1/rpc/delete_my_account':
            ROWS.pop(who['id'], None)
            PROFILES.pop(who['id'], None)
            return self._json(200, None)
        if path == '/rest/v1/profiles':
            PROFILES[who['id']] = {**body, 'id': who['id']}
            return self._json(201, [PROFILES[who['id']]])
        # Just enough of Crew to try invite links: one club whose code is
        # ROBOT-ABC234, and partner invites that work once.
        if path == '/rest/v1/invites' and method == 'POST':
            INVITES[str(body.get('code', '')).upper()] = who['id']
            return self._json(201, None)
        if path == '/rest/v1/rpc/accept_invite':
            owner = INVITES.pop(str(body.get('invite_code', '')).upper(), None)
            if not owner or owner == who['id']:
                return self._json(400, {'message': 'That invite code is not valid or has already been used.'})
            return self._json(200, owner)
        if path == '/rest/v1/rpc/join_club':
            if str(body.get('club_code', '')).upper() != 'ROBOT-ABC234':
                return self._json(400, {'message': 'No club with that code. Check it with your leader.'})
            return self._json(200, MOCK_CLUB['id'])
        if path == '/rest/v1/clubs' and 'id=eq.' in query:
            return self._json(200, [{'id': MOCK_CLUB['id'], 'name': MOCK_CLUB['name']}])
        if path == '/rest/v1/rpc/bump_agent_usage':
            USAGE[who['id']] = USAGE.get(who['id'], 0) + 1
            return self._json(200, [{'mine': USAGE[who['id']], 'total': sum(USAGE.values())}])
        return self._json(200, [])

    def _canvas_feed(self):
        """Stand-in for netlify/functions/canvas-feed.mjs. A signed-in request
        for a Canvas feed address gets a small calendar with three assignments
        due in the coming days; an address containing "broken" gets the 404
        Canvas sends for a link that no longer works."""
        body = self._body()
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or not TOKENS.get(auth[7:]):
            return self._json(401, {'error': 'Open Cadence again to sync Canvas.'})
        url = str(body.get('url', ''))
        kind = mock_feed_kind(url)
        if not kind:
            return self._json(400, {'error': "That isn't a calendar link Cadence can use."})
        if 'broken' in url:
            return self._json(404, {'error': f'{kind} did not recognise that link. Copy it again from {kind}.'})
        import datetime
        today = datetime.date.today()
        if kind != 'Canvas':
            # Busy time from a personal calendar: a few timed events this week.
            def busy(n, days, start, end, title):
                d = (today + datetime.timedelta(days=days)).strftime('%Y%m%d')
                return (f'BEGIN:VEVENT\r\nUID:mock-{kind}-{n}\r\nDTSTART:{d}T{start}00\r\nDTEND:{d}T{end}00\r\n'
                        f'SUMMARY:{title}\r\nEND:VEVENT\r\n')
            ics = ('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:mock\r\n'
                   + busy(1, 1, '1700', '1800', 'Orthodontist') + busy(2, 2, '1830', '2000', 'Family dinner') + busy(3, 4, '1600', '1730', 'Tutoring')
                   + 'END:VCALENDAR\r\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/calendar; charset=utf-8')
            self.send_header('Content-Length', str(len(ics)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            return self.wfile.write(ics)
        def ev(n, days, title, course):
            d = today + datetime.timedelta(days=days)
            stamp = d.strftime('%Y%m%d') + 'T065900Z'
            return (f'BEGIN:VEVENT\r\nUID:event-assignment-{n}@school.instructure.com\r\nDTSTART:{stamp}\r\nDTEND:{stamp}\r\n'
                    f'SUMMARY:{title} [{course}]\r\nURL:https://school.instructure.com/courses/1/assignments/{n}\r\nEND:VEVENT\r\n')
        ics = ('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:mock\r\n'
               + ev(9001, 2, 'Lab report: enzymes', 'BIO-11') + ev(9002, 3, 'Problem set 4', 'MATH-11') + ev(9003, 5, 'Essay draft', 'ENG-11')
               + 'END:VCALENDAR\r\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/calendar; charset=utf-8')
        self.send_header('Content-Length', str(len(ics)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(ics)

    def _agent(self):
        """Stand-in for netlify/functions/agent.mjs. The conversation has no
        model behind it (501, so the app reads the message on the device), but
        outline mode answers with a fixed sample, so its card can be seen."""
        body = self._body()
        AGENT_CALLS.append(body)
        if body.get('mode') == 'outline':
            auth = self.headers.get('Authorization', '')
            if not auth.startswith('Bearer ') or not TOKENS.get(auth[7:]):
                return self._json(401, {'error': 'Sign in to use the assistant.'})
            title = str((body.get('assignment') or {}).get('title', 'the assignment'))[:200]
            return self._json(200, {'outline': {
                'asks': f'Sample outline from the mock server for "{title}": what it asks would be summed up here.',
                'steps': ['Read the instructions and the rubric once, start to finish', 'List what you already know and what you need to look up',
                          'Work through the first part on your own', 'Check your work against the rubric', 'Submit it on Canvas'],
                'structure': ['Part 1: the setup', 'Part 2: your work', 'Part 3: what you found'],
                'review': ['Your class notes on this unit', 'The rubric'],
                'questions': ['Which part will take you longest?', 'What would a strong answer include?'],
            }})
        self._json(501, {'error': 'The mock server has no model behind it. The assistant falls back to reading the message itself.'})

    def _form(self, path):
        """Stand-in for Netlify Forms. A post with a form-name is kept; one with
        the hidden box filled in is accepted and thrown away, as Netlify does
        with spam. A script gets 200; a plain form post is sent on to the page
        named in the form's action, which is the address it was posted to."""
        n = int(self.headers.get('Content-Length') or 0)
        fields = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode('utf-8', 'replace'), keep_blank_values=True).items()}
        if not fields.get('form-name'):
            return self._json(404, {'message': 'not found'})
        if not fields.get('bot-field'):
            ENQUIRIES.append({k: v for k, v in fields.items() if k != 'bot-field'})
        if path in ('', '/'):
            self.send_response(200)
            self.send_header('Content-Length', '0')
            return self.end_headers()
        self.send_response(303)
        self.send_header('Location', path)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _visit(self):
        """Stand-in for netlify/functions/visit.mjs: the same rule, kept in memory."""
        body = self._body()
        labels = [body.get(k, '') if isinstance(body.get(k, ''), str) else None for k in ('source', 'medium', 'campaign')]
        if any(v is None or not LABEL.match(v) for v in labels) or not any(labels):
            self.send_response(400)
            return self.end_headers()
        key = '|'.join(labels)
        VISITS[key] = VISITS.get(key, 0) + 1
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    print(f'Cadence dev server on http://localhost:{PORT}  (mock backends: {"on" if MOCK else "off"})')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
