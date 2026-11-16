#!/usr/bin/env python3
"""Does this Groq key work for Cadence's assistant?

    read -s GROQ_API_KEY && export GROQ_API_KEY && python3 scripts/groq_check.py

`read -s` takes the key without showing it or saving it in your shell
history. The key is read from the environment, sent only to Groq, and never
printed or written anywhere. Optional: GROQ_MODEL to try another model.

It sends three requests to Groq and reports what came back:
  1. a small one with one tool, to check the key, the model and tool calling;
  2. one the size of a plain assistant question (Cadence's real instructions
     plus filler, about 6,600 tokens, with room for a 1,500-token reply);
  3. one the size of a question that has read email (about 15,000 tokens).
Groq refuses any single request larger than the plan's tokens per minute,
which on its free plan is 8,000, so 2 and 3 show whether the plan is enough.
Together they use about 25,000 of the day's tokens.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = 'https://api.groq.com/openai/v1/chat/completions'


def default_model():
    m = re.search(r"export const GROQ_MODEL = '([^']+)'", (ROOT / 'src/lib/groq.js').read_text(encoding='utf-8'))
    return m.group(1) if m else ''


def instructions():
    m = re.search(r'export const SYSTEM = `(.*?)`;', (ROOT / 'src/lib/agentspec.js').read_text(encoding='utf-8'), re.S)
    return m.group(1) if m else 'You are a scheduling assistant.'


def ask(key, body):
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method='POST', headers={
        'content-type': 'application/json', 'authorization': f'Bearer {key}', 'user-agent': 'cadence-groq-check'})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b'null'), dict(r.headers), time.time() - started
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read() or b'null')
        except ValueError:
            data = None
        return e.code, data, dict(e.headers), time.time() - started


def limits(headers):
    keys = ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens']
    found = {k: v for k, v in ((k, headers.get(k) or headers.get(k.title())) for k in keys) if v}
    return ', '.join(f'{k.replace("x-ratelimit-", "")}: {v}' for k, v in found.items()) or 'not reported'


TOOL = {'type': 'function', 'function': {
    'name': 'check_free', 'description': 'Find when the student is free on a date.',
    'parameters': {'type': 'object', 'additionalProperties': False, 'required': ['date'],
                   'properties': {'date': {'type': 'string', 'description': 'A date as YYYY-MM-DD'}}}}}


def main():
    key = os.environ.get('GROQ_API_KEY', '').strip()
    if not key:
        sys.exit('Set GROQ_API_KEY first:  read -s GROQ_API_KEY && export GROQ_API_KEY')
    model = os.environ.get('GROQ_MODEL', '').strip() or default_model()
    print(f'Model: {model}')

    status, data, headers, took = ask(key, {
        'model': model, 'temperature': 0.2, 'max_completion_tokens': 300, 'tool_choice': 'auto', 'tools': [TOOL],
        'messages': [{'role': 'system', 'content': 'Use the tool to answer.'}, {'role': 'user', 'content': 'Am I free on 2026-11-20?'}]})
    if status != 200:
        message = (data or {}).get('error', {}).get('message', '') if isinstance(data, dict) else ''
        sys.exit(f'1. Small request: refused ({status}). {message}'.strip())
    choice = (data.get('choices') or [{}])[0]
    calls = (choice.get('message') or {}).get('tool_calls') or []
    print(f'1. Small request: OK in {took:.1f}s. Tool call: {"yes, " + calls[0]["function"]["name"] + " " + calls[0]["function"]["arguments"] if calls else "no (" + str(choice.get("finish_reason")) + ")"}')
    print(f'   Limits for this key and model: {limits(headers)}')

    # Cadence sends its instructions, 15 tool definitions and the student's
    # week with every step: about 6,600 tokens for a plain question, about
    # 15,000 once email has been read, plus up to 1,500 for the reply. Groq
    # counts the reply allowance against the per-minute limit too.
    filler = ' '.join(['Practice moved to 5pm on Thursday because the gym is closed.'] * 4000)
    fits = {}
    for n, (name, chars) in enumerate([('A plain question', 17500), ('A question that read email', 52000)], start=2):
        status, data, headers, took = ask(key, {
            'model': model, 'temperature': 0.2, 'max_completion_tokens': 1500,
            'messages': [{'role': 'system', 'content': instructions()},
                         {'role': 'user', 'content': f'{filler[:chars]}\n\nIn one sentence: what changed?'}]})
        fits[name] = status == 200
        if status == 200:
            used = (data.get('usage') or {}).get('prompt_tokens')
            print(f'{n}. {name} ({used} tokens plus the reply): OK in {took:.1f}s.')
        else:
            message = (data or {}).get('error', {}).get('message', '') if isinstance(data, dict) else ''
            print(f'{n}. {name}: refused ({status}). {message}'.strip())
        print(f'   Limits now: {limits(headers)}')
    if all(fits.values()):
        print('\nThis key and model can run Cadence\'s assistant, including reading email.')
    else:
        print('\nThis key\'s plan allows fewer tokens a minute than Cadence\'s assistant needs, so the site would')
        print('answer "cannot answer right now". Groq\'s Developer plan (console.groq.com/settings/billing) lifts the')
        print('limit; set a spend limit there. Or set assistant to \'gemini\' (free plan: no email reading; paid')
        print('plan: email allowed) or \'claude\' in src/config.js, then run python3 scripts/stamp_pages.py.')

if __name__ == '__main__':
    main()
