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
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8123)

USERS = {}      # email -> user id
TOKENS = {}     # access token -> {id, email}
ROWS = {}       # user id -> {data, updated_at}
PROFILES = {}   # user id -> row
USAGE = {}      # user id -> count
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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if MOCK and ('/auth/' in self.path or '/rest/' in self.path or '/api/' in self.path):
            sys.stderr.write('mock %s\n' % (fmt % args))

    # ------------------------------------------------------------ helpers
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

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b'{}')
        except ValueError:
            return {}

    def _user(self):
        auth = self.headers.get('Authorization', '')
        return TOKENS.get(auth.replace('Bearer ', '', 1))

    def _session(self, email):
        uid = USERS.setdefault(email, str(uuid.uuid4()))
        token = 'tok_' + uuid.uuid4().hex
        TOKENS[token] = {'id': uid, 'email': email}
        return {'access_token': token, 'refresh_token': 'ref_' + token, 'expires_in': 3600,
                'user': {'id': uid, 'email': email}}

    # ------------------------------------------------------------- routes
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

    def do_GET(self):
        path = urlparse(self.path).path
        if MOCK and path == '/mock/visits':
            return self._json(200, VISITS)
        if MOCK and path == '/mock/enquiries':
            return self._json(200, ENQUIRIES)
        if MOCK and path.startswith('/mock/'):
            return self._mock('GET', path[5:])
        self._clean_address()
        return super().do_GET()

    def do_HEAD(self):
        self._clean_address()
        return super().do_HEAD()

    def _clean_address(self):
        """The same clean addresses netlify.toml sets up: /app is app.html."""
        parts = urlparse(self.path)
        name = parts.path.strip('/')
        if name and '.' not in name and '/' not in name and (ROOT / f'{name}.html').is_file():
            self.path = f'/{name}.html' + (('?' + parts.query) if parts.query else '')

    def do_POST(self):
        path = urlparse(self.path).path
        if MOCK and path.startswith('/mock/'):
            return self._mock('POST', path[5:])
        if MOCK and path == '/api/agent':
            return self._agent()
        if MOCK and path == '/api/visit':
            return self._visit()
        if MOCK and 'application/x-www-form-urlencoded' in self.headers.get('Content-Type', ''):
            return self._form(path)
        self._json(404, {'message': 'not found'})

    do_PATCH = do_POST

    def _mock(self, method, path):
        body = self._body() if method != 'GET' else {}
        query = urlparse(self.path).query

        if path == '/auth/v1/otp':
            if '@' not in str(body.get('email', '')):
                return self._json(422, {'msg': 'Unable to validate email address: invalid format'})
            return self._json(200, {})
        if path == '/auth/v1/verify':
            if not str(body.get('token', '')).isdigit() or len(str(body.get('token'))) != 6:
                return self._json(403, {'msg': 'Token has expired or is invalid'})
            return self._json(200, self._session(body.get('email')))
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
        if path == '/rest/v1/rpc/bump_agent_usage':
            USAGE[who['id']] = USAGE.get(who['id'], 0) + 1
            return self._json(200, [{'mine': USAGE[who['id']], 'total': sum(USAGE.values())}])
        return self._json(200, [])

    def _agent(self):
        """Stand-in for netlify/functions/agent.mjs: echoes a scripted reply."""
        body = self._body()
        AGENT_CALLS.append(body)
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
