#!/usr/bin/env node
/**
 * Compare two DSH session logs (`.jsonl.zstd`) for the context-suite A/B.
 *
 * Usage:
 *   node bench/analyze-sessions.mjs <stock.jsonl.zstd> <suite.jsonl.zstd>
 *
 * Only Node builtins and the system `zstd` binary are used. The script reads
 * the real event stream — `request/header`, `assistant/message` usage,
 * `compaction/prune`, `tool/call`, and injected `user/message` — and prints a
 * Markdown comparison table plus a short quality section.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const MARKER = '<available_skills>'

/** Read a zstd-compressed JSONL session log into an array of events. */
function readEvents(file) {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`)
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A truncated final line is normal for a live session; skip it.
    }
  }
  return events
}

/** The text parts of an assistant or user message event. */
function messageText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/** The usage block of an assistant message, if present. */
function usageOf(event) {
  return event?.data?.usage ?? event?.data?.message?.usage
}

/** Count skill names the model actually reported after the fold. */
function reportedSkills(events) {
  const answers = events
    .filter((event) => event.type === 'assistant/message')
    .map(messageText)
    .filter((text) => text.includes(MARKER) || /available_skills/i.test(text))
  if (answers.length === 0) return { count: 0, note: 'no skill answer found' }
  const answer = answers[answers.length - 1]
  if (/看不到|not visible|no\s+<available_skills>/i.test(answer)) {
    return { count: 0, note: 'model reported the catalog is not visible' }
  }
  const names = new Set()
  for (const match of answer.matchAll(/^-\s+`([a-z0-9][a-z0-9-]*)`/gim)) names.add(match[1])
  return { count: names.size, note: names.size === 0 ? 'answer had no skill list' : [...names].join(', ') }
}

/** Collect the metrics the report needs from one session. */
function summarize(file) {
  const events = readEvents(file)
  const headers = events.filter((event) => event.type === 'request/header')
  const usages = events.map(usageOf).filter(Boolean)
  const prunes = events.filter((event) => event.type === 'compaction/prune')
  const folds = events.filter(
    (event) =>
      event.type === 'tool/call' &&
      (event.data?.name === 'compress' || event.data?.toolName === 'compress'),
  )
  const userMessages = events.filter((event) => event.type === 'user/message')
  const skillCatalogs = userMessages.filter((event) => event.data?.source?.kind === 'skill-catalog')
  const foldedMessages = userMessages.filter((event) => messageText(event).includes('<context_folded>'))
  const first = usages[0] ?? {}
  const second = usages[1] ?? {}
  const sum = (key) => usages.reduce((total, usage) => total + (usage[key] ?? 0), 0)
  const input = sum('inputTokens')
  const cacheRead = sum('cacheReadTokens')
  const cacheWrite = sum('cacheWriteTokens')
  const output = sum('outputTokens')
  const promptTotal = input + cacheRead + cacheWrite
  const skills = reportedSkills(events)
  return {
    file,
    tools: headers[0]?.data?.header?.tools?.length ?? 0,
    temperature: headers[0]?.data?.header?.config?.temperature ?? null,
    steps: usages.length,
    first: {
      input: first.inputTokens ?? 0,
      cacheRead: first.cacheReadTokens ?? 0,
      total: first.totalTokens ?? 0,
    },
    second: {
      input: second.inputTokens ?? 0,
      cacheRead: second.cacheReadTokens ?? 0,
      total: second.totalTokens ?? 0,
    },
    input,
    cacheRead,
    cacheWrite,
    output,
    promptTotal,
    avgPrompt: usages.length === 0 ? 0 : Math.round(promptTotal / usages.length),
    prunes: prunes.length,
    prunedTokens: prunes.reduce((total, event) => total + (event.data?.shadowedTokenCount ?? 0), 0),
    folds: folds.length,
    skillCatalogs: skillCatalogs.length,
    foldedMessages: foldedMessages.length,
    visibleSkills: skills.count,
    skillNote: skills.note,
  }
}

/** Format a number with thousands separators. */
function n(value) {
  return typeof value === 'number' ? value.toLocaleString('en-US') : String(value)
}

/** Percentage saved going from stock to suite. */
function saved(stock, suite) {
  if (!stock) return '—'
  return `${(((stock - suite) / stock) * 100).toFixed(1)}%`
}

/** One Markdown table row. */
function row(label, stock, suite, delta) {
  return `| ${label} | ${stock} | ${suite} | ${delta} |`
}

const [stockFile, suiteFile] = process.argv.slice(2)
if (!stockFile || !suiteFile) {
  console.error('usage: node bench/analyze-sessions.mjs <stock.jsonl.zstd> <suite.jsonl.zstd>')
  process.exit(2)
}

const stock = summarize(stockFile)
const suite = summarize(suiteFile)

console.log('## Session A/B comparison\n')
console.log(`- stock: \`${stock.file}\``)
console.log(`- suite: \`${suite.file}\``)
console.log(`- temperature: stock ${stock.temperature ?? '—'}, suite ${suite.temperature ?? '—'}\n`)

console.log('| Metric | Stock | Suite | Saved |')
console.log('|---|---:|---:|---:|')
console.log(row('Tools in first request', n(stock.tools), n(suite.tools), saved(stock.tools, suite.tools)))
console.log(row('Step 1 prompt tokens', n(stock.first.total), n(suite.first.total), saved(stock.first.total, suite.first.total)))
console.log(row('Step 2 uncached input', n(stock.second.input), n(suite.second.input), saved(stock.second.input, suite.second.input)))
console.log(row('Step 2 cache read', n(stock.second.cacheRead), n(suite.second.cacheRead), saved(stock.second.cacheRead, suite.second.cacheRead)))
console.log(row('Step 2 total prompt', n(stock.second.total), n(suite.second.total), saved(stock.second.total, suite.second.total)))
console.log(row('Steps', n(stock.steps), n(suite.steps), '—'))
console.log(row('Average prompt per step', n(stock.avgPrompt), n(suite.avgPrompt), saved(stock.avgPrompt, suite.avgPrompt)))
console.log(row('Cumulative prompt load', n(stock.promptTotal), n(suite.promptTotal), saved(stock.promptTotal, suite.promptTotal)))
console.log(row('Cumulative uncached input', n(stock.input), n(suite.input), saved(stock.input, suite.input)))
console.log(row('Cumulative cache read', n(stock.cacheRead), n(suite.cacheRead), saved(stock.cacheRead, suite.cacheRead)))
console.log(row('Cumulative output', n(stock.output), n(suite.output), '—'))
console.log(row('`compaction/prune` events', n(stock.prunes), n(suite.prunes), '—'))
console.log(row('Pruned tokens', n(stock.prunedTokens), n(suite.prunedTokens), '—'))
console.log(row('Fold (`compress`) calls', n(stock.folds), n(suite.folds), '—'))
console.log(row('`<context_folded>` notices', n(stock.foldedMessages), n(suite.foldedMessages), '—'))
console.log(row('Visible skills reported after fold', n(stock.visibleSkills), n(suite.visibleSkills), '—'))
console.log('')
console.log(`- stock skill answer: ${stock.skillNote}`)
console.log(`- suite skill answer: ${suite.skillNote}`)
console.log('')
console.log('> `Saved` is `(stock − suite) / stock`. Cache reads are cheaper than')
console.log('> uncached input but still cost latency; both totals are shown.')
