#!/usr/bin/env python3
"""Copy the homepage's worked example into index.html, or check the copy.

    python3 scripts/copy_example.py           # write the copy into index.html
    python3 scripts/copy_example.py --check   # only say whether it still matches

The example ("How Cadence plans a week", src/site/evening.js) is worked out
by the real planner in the visitor's browser. index.html also holds a copy of
what it shows at first, so the page reads the same without scripts: Sam's
week, what Sam has and why the week looks that way, between the
evening:week, evening:have and evening:why markers. The assistant's reply
under "When plans change, just tell it" is a copy too, of what Cadence's own
reader answers on Sam's week.

When the planner, the reader or the example changes, those copies go stale
without anything failing. This runs the same code in JavaScriptCore (the
JavaScript shell that comes with macOS, so no Node is needed), with the time
zone set to Los Angeles (the example reads the same in every time zone; the
copy was checked in several), and either writes the new copy in or reports
what no longer matches.
"""
import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / 'index.html'
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'
MARKERS = ('week', 'have', 'why')


def run():
    """The example as the code works it out, from scripts/example_run.mjs."""
    if not os.path.exists(JSC):
        sys.exit('JavaScriptCore was not found (it comes with macOS). Nothing was checked.')
    env = {**os.environ, 'TZ': 'America/Los_Angeles'}
    out = subprocess.run([JSC, '-m', str(ROOT / 'scripts' / 'example_run.mjs')], capture_output=True, text=True, env=env, cwd=ROOT)
    lines = [l for l in out.stdout.splitlines() if l.startswith('{')]
    if out.returncode or not lines:
        sys.exit(f'The example did not run:\n{out.stdout}{out.stderr}')
    return json.loads(lines[-1])


def block(page, name):
    pattern = re.compile(r'(<!-- evening:' + name + r' -->)(.*?)(<!-- /evening:' + name + r' -->)', re.S)
    found = pattern.findall(page)
    if len(found) != 1:
        sys.exit(f'index.html should have one evening:{name} block, and has {len(found)}.')
    return pattern, found[0][1]


def reply_problems(page, reply):
    """What the page's copy of the assistant's reply says that Cadence's reader does not."""
    copy = page[page.find('class="rp rp-agent"'):]
    copy = html.unescape(copy[:copy.find('</figure>')])
    wanted = [reply['sentence'], reply['text']] + [c['summary'] for c in reply['changes']] + [c['label'] for c in reply['changes']]
    missing = [w for w in wanted if w and w not in copy]
    return [f'the assistant copy is missing "{w}"' for w in missing]


def main():
    check = '--check' in sys.argv[1:]
    made = run()
    page = PAGE.read_text()
    stale = [name for name in MARKERS if block(page, name)[1] != made[name]]
    problems = [f'the evening:{name} copy no longer matches what the code shows' for name in stale]
    problems += reply_problems(page, made['reply'])
    if check:
        for p in problems:
            print(f'  stale  {p}')
        print('The homepage example matches the code.' if not problems else f'{len(problems)} out of date.')
        sys.exit(1 if problems else 0)
    for name in stale:
        pattern, _ = block(page, name)
        page = pattern.sub(lambda m: m.group(1) + made[name] + m.group(3), page)
    if stale:
        PAGE.write_text(page)
    print(f'Copied: {", ".join(stale)}' if stale else 'The copy was already up to date.')
    for p in reply_problems(page, made['reply']):
        print(f'  by hand  {p} (reply: {json.dumps(made["reply"])})')


if __name__ == '__main__':
    main()
