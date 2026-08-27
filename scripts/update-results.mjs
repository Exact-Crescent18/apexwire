// Checks CAL_EVENTS in index.html for races that have no `result` yet,
// asks Groq's Compound Mini (which has real built-in web search) whether
// each one has actually happened and what the real result was, and
// refreshes the news ticker. Never invents a result — if Groq can't
// confirm one cleanly, the event is left untouched for a later run.
//
// Usage: GROQ_API_KEY=... node scripts/update-results.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const FILE = new URL('../index.html', import.meta.url);
const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = 'groq/compound-mini';

if (!GROQ_KEY) {
  console.error('GROQ_API_KEY is not set.');
  process.exit(1);
}

async function askGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function daysSince(dateStr) {
  const eventDate = new Date(dateStr + 'T12:00:00Z'); // midday UTC, avoids TZ edge cases
  return (Date.now() - eventDate.getTime()) / 86400000;
}

// Serializes a single CAL_EVENTS object back to the file's existing
// single-quote JS-literal style. Keeps key order stable and predictable.
function serializeEvent(ev) {
  const q = (s) => `'${String(s).replace(/'/g, "\\'")}'`;
  const parts = [`date:${q(ev.date)}`, `view:${q(ev.view)}`, `chip:${q(ev.chip)}`, `series:${q(ev.series)}`, `name:${q(ev.name)}`];
  if (ev.venue) parts.push(`venue:${q(ev.venue)}`);
  if (ev.result) {
    parts.push(`result:{winner:${q(ev.result.winner)}, note:${q(ev.result.note)}}`);
  } else {
    if (ev.sessions) {
      const sessions = ev.sessions.map((s) => `{label:${q(s.label)},time:${q(s.time)}}`).join(',');
      parts.push(`sessions:[${sessions}]`);
    }
    if (ev.watch) parts.push(`watch:${q(ev.watch)}`);
  }
  return `  {${parts.join(', ')}}`;
}

async function main() {
  let html = readFileSync(FILE, 'utf8');

  const startMarker = 'const CAL_EVENTS = [';
  const start = html.indexOf(startMarker);
  const end = html.indexOf('\n];\n\nconst CAL_EVENTS_BY_DATE', start);
  if (start === -1 || end === -1) {
    console.error('Could not locate CAL_EVENTS block.');
    process.exit(1);
  }

  const arrayLiteral = html.slice(start + 'const CAL_EVENTS = '.length, end + 2);
  // Trusted, self-authored content (this project's own data file) — not
  // third-party input — so evaluating it as JS is safe here.
  const events = new Function(`return ${arrayLiteral}`)();

  let changed = 0;
  const changedNames = [];

  for (const ev of events) {
    if (ev.result) continue;
    if (daysSince(ev.date) < 0.5) continue; // too soon, don't even ask

    const prompt = `Real-world race lookup. Series: ${ev.series}. Race: ${ev.name}. Venue: ${ev.venue || 'unknown'}. Scheduled date: ${ev.date}.
Has this specific real race actually taken place yet, and if so, who won? Search for it.
Respond with ONLY strict JSON, no other text:
{"happened": true, "winner": "Full Name", "note": "one terse factual sentence — margin of victory, notable storyline, or standings implication"}
or if it hasn't happened yet, or you cannot find a clearly confirmed result from a reliable source:
{"happened": false}
Never guess or invent a winner. Only report "happened": true if you found a real, verifiable result.`;

    let parsed;
    try {
      const reply = await askGroq(prompt);
      parsed = extractJson(reply);
    } catch (e) {
      console.error(`Groq call failed for ${ev.name}:`, e.message);
      continue;
    }

    if (parsed?.happened && parsed.winner && parsed.note) {
      ev.result = { winner: parsed.winner, note: parsed.note };
      delete ev.sessions;
      delete ev.watch;
      changed++;
      changedNames.push(ev.name);
      console.log(`Updated: ${ev.name} — ${parsed.winner}`);
    }
  }

  if (changed > 0) {
    const newLiteral = `[\n${events.map(serializeEvent).join(',\n')}\n]`;
    html = html.slice(0, start) + 'const CAL_EVENTS = ' + newLiteral + html.slice(end + 2);
    writeFileSync(FILE, html, 'utf8');
  }

  // --- Ticker refresh: one current headline per series, best-effort ---
  const tickerStart = html.indexOf('<div class="ticker-inner">');
  const tickerEnd = html.indexOf('</div>', tickerStart);
  if (tickerStart !== -1 && tickerEnd !== -1) {
    const tickerBlock = html.slice(tickerStart, tickerEnd);
    const seriesMatches = [...tickerBlock.matchAll(/alt="([^"]+)">\s*\n\s*([^<]+?)<\/span>/g)];
    let tickerChanged = false;
    let newTickerBlock = tickerBlock;

    for (const m of seriesMatches) {
      const [full, seriesAlt, oldLine] = m;
      const prompt = `Give me one current, verifiable, real racing news headline about ${seriesAlt} as of today — a race result, standings shift, or notable development. One short factual sentence, no preamble, suitable for a news ticker. If you can't confirm anything current, respond with exactly: NO_UPDATE`;
      let reply;
      try {
        reply = (await askGroq(prompt)).trim();
      } catch (e) {
        console.error(`Groq ticker call failed for ${seriesAlt}:`, e.message);
        continue;
      }
      if (!reply || reply === 'NO_UPDATE' || reply.length > 220) continue;
      if (reply === oldLine.trim()) continue;
      newTickerBlock = newTickerBlock.replace(full, full.replace(oldLine, `\n      ${reply}`));
      tickerChanged = true;
      console.log(`Ticker updated: ${seriesAlt}`);
    }

    if (tickerChanged) {
      html = html.slice(0, tickerStart) + newTickerBlock + html.slice(tickerEnd);
      writeFileSync(FILE, html, 'utf8');
      changed++;
    }
  }

  if (changed === 0) {
    console.log('Nothing to update this run.');
    return;
  }

  // Validate before letting the workflow commit: JS must still parse and
  // <style> braces must still balance, or we bail without writing.
  const scriptContent = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  try {
    new Function(scriptContent);
  } catch (e) {
    console.error('Validation failed after edit, aborting without commit:', e.message);
    process.exit(1);
  }
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open !== close) {
    console.error(`CSS brace mismatch after edit (${open} vs ${close}), aborting without commit.`);
    process.exit(1);
  }

  console.log(`Validation passed. ${changedNames.length ? 'Results: ' + changedNames.join(', ') : 'Ticker refreshed.'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
