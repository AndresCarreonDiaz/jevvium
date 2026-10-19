import { literalBody } from './codegen.ts'
import { describeExpectation } from './expectations.ts'
import type { Step, TakenAction, Trace } from './explorer.ts'
import { quoted } from './locator.ts'
import { redactor } from './redact.ts'
import { stopReport } from './report.ts'

/** TypeSafe's list price per million input tokens for Jev; output tokens are free. */
export const JEV_PRICE_PER_M_INPUT = 0.042
/** The "goal reached" probability a verdict-only step is shown as reaching the goal at: the default --goal-threshold. */
const GOAL_SHOWN = 0.8

/** What a run report says besides the trace: where things are and what was run on. */
export type ReportContext = {
  /** The plan or criteria file explored. */
  planFile?: string
  /** The device, as people call it: "iPhone 17, iOS 26.5". */
  device?: string
  /** The generated test, when one was written. */
  specFile?: string
  /** Its code, shown at the end of the HTML report with the test data in `inputs` replaced by `{name}`. */
  spec?: string
  /** The plan's test data. The test holds the values; the report shows `{name}` instead, like the trace. */
  inputs?: Record<string, string>
  /** The "goal reached" probability the run used (`--goal-threshold`), for naming verdict-only steps. Default 0.8. */
  goalThreshold?: number
  /** Each step's frame by name, as JPEG bytes, for the HTML report, which embeds them. */
  frames?: Map<string, Buffer>
}

/**
 * A run report for people: `report.md`, which reads well in a pull request, and
 * `report.html`, one file with the frames inside it, to open or attach anywhere. Both come
 * from the trace, so test data is already replaced with `{name}`, and the frames are the
 * masked ones the run kept.
 */
export function runReport(trace: Trace, context: ReportContext = {}): { markdown: string; html: string } {
  return { markdown: markdown(trace, context), html: html(trace, context) }
}

/** "Passed in 6.7 s: Goal reached and all 2 expectations hold." */
export function verdict(trace: Trace): string {
  return `${capitalize(trace.outcome)} in ${seconds(trace.durationMs)}: ${trace.reason}`
}

/** "Replayed with plain Appium in 5.9 s: passed." or undefined when there was no replay. */
export function replayLine(trace: Trace): string | undefined {
  const replayed = trace.replay
  if (!replayed) return undefined
  if (replayed.outcome === 'error') return `The replay with plain Appium couldn't run: ${replayed.reason}`
  return `Replayed with plain Appium in ${seconds(replayed.durationMs)}: ${replayed.outcome === 'passed' ? 'passed' : `failed. ${replayed.reason}`}`
}

/** The models that answered: the one that decided, and the one that looked, when it did. */
export function modelsLine(trace: Trace): string {
  const decided = unique(trace.steps.map((step) => step.decision.model))
  const looked = unique(trace.steps.flatMap((step) => (step.look ? [step.look.decision.model] : [])))
  const decidedBy = decided.length > 0 ? decided.join(', ') : trace.provider
  return looked.length > 0 ? `${decidedBy}, looking with ${looked.join(', ')}` : decidedBy
}

/** Requests, tokens and, for Jev, the cost at list price. */
export function usageLine(trace: Trace): string {
  const { requests, inputTokens, looks } = trace.usage
  const withShots = looks ? ` (${looks} with a screenshot)` : ''
  const cost = trace.provider === 'jev' ? `, about $${((inputTokens * JEV_PRICE_PER_M_INPUT) / 1_000_000).toFixed(4)}` : ''
  return `${requests} ${requests === 1 ? 'request' : 'requests'}${withShots}, ${inputTokens.toLocaleString('en-US')} input tokens${cost}`
}

/** What left the machine: text only, or which steps' screenshots went with a request. */
export function sentLine(trace: Trace): string {
  const looked = trace.steps.filter((step) => step.look || step.lookError)
  const sent = Math.max(looked.length, trace.usage.looks ?? 0)
  if (sent === 0) return 'Text only: the screen text and the actions it offered, with test data replaced by {name}. No screenshot was sent.'
  const which = looked.length > 0 ? ` of ${looked.length === 1 ? 'step' : 'steps'} ${looked.map((step) => step.index).join(', ')}` : ''
  const unanswered = looked.filter((step) => step.lookError).length
  const failed = unanswered > 0 ? ` (${unanswered} of them got no answer)` : ''
  return `The text, with test data replaced by {name}, and ${sent === 1 ? 'a masked screenshot' : `${sent} masked screenshots`}${which}, where the model looked${failed}.`
}

function markdown(trace: Trace, context: ReportContext): string {
  const title = trace.criterion.title ?? trace.criterion.goal
  const lines: string[] = [`# ${oneLine(title)}`, '', `**${verdict(trace)}**`]
  const threshold = context.goalThreshold ?? GOAL_SHOWN
  const replayed = replayLine(trace)
  if (replayed) lines.push('', replayed)
  lines.push('', '| | |', '| --- | --- |')
  if (context.planFile) lines.push(`| Plan | \`${cell(context.planFile)}\` |`)
  lines.push(`| Platform | ${cell(context.device ?? trace.platform)} |`)
  lines.push(`| Model | ${cell(modelsLine(trace))} |`)
  lines.push(`| Requests | ${cell(usageLine(trace))} |`)
  lines.push(`| Sent to the model | ${cell(sentLine(trace))} |`)
  if (context.specFile) lines.push(`| Test | \`${cell(context.specFile)}\` |`)

  if (trace.criterion.steps?.length) {
    lines.push('', '## Plan', '', ...trace.criterion.steps.map((step, i) => `${i + 1}. ${oneLine(step)}`))
  }
  if (trace.criterion.expect.length > 0) {
    lines.push('', `Expected: ${trace.criterion.expect.map(describeExpectation).join(', ')}`)
  }

  lines.push('', '## Steps')
  for (const step of trace.steps) {
    lines.push('', `### ${step.index}. ${oneLine(headline(step, trace, threshold))}`, '')
    if (step.frame) lines.push(`<img src="${step.frame}" width="220" alt="The screen at step ${step.index}">`, '')
    for (const detail of details(step)) lines.push(`- ${detail}`)
  }

  const stop = stopReport(trace)
  if (stop.length > 0) lines.push('', '## Why it stopped', '', ...stop.map((line) => `- ${line}`))
  return `${lines.join('\n')}\n`
}

function html(trace: Trace, context: ReportContext): string {
  const title = trace.criterion.title ?? trace.criterion.goal
  const spec = context.spec && redactCode(context.spec, context.inputs ?? {})
  const facts: [string, string][] = [
    ...(context.planFile ? ([['Plan', context.planFile]] as [string, string][]) : []),
    ['Platform', context.device ?? trace.platform],
    ['Model', modelsLine(trace)],
    ['Requests', usageLine(trace)],
    ['Sent to the model', sentLine(trace)],
    ...(context.specFile ? ([['Test', context.specFile]] as [string, string][]) : []),
  ]
  const plan = trace.criterion.steps?.length
    ? `<ol class="plan">${trace.criterion.steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>`
    : ''
  const expected = trace.criterion.expect.length
    ? `<p class="expected">Expected: ${escape(trace.criterion.expect.map(describeExpectation).join(', '))}</p>`
    : ''
  const cards = trace.steps.map((step) => card(step, trace, context.frames, context.goalThreshold ?? GOAL_SHOWN)).join('\n')
  const stop = stopReport(trace)
  const replayed = replayLine(trace)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(oneLine(title))} · jevvium</title>
<style>
:root { --bg: #fafaf7; --ink: #1d1d1b; --muted: #6b6b66; --line: #deddd6; --card: #ffffff; --pass: #1f7a3f; --fail: #b3261e; --act: #1f7a3f; --look: #d9730d; }
@media (prefers-color-scheme: dark) { :root { --bg: #171716; --ink: #ecebe6; --muted: #a3a29b; --line: #34332f; --card: #201f1d; --pass: #5cc489; --fail: #f2867c; --act: #5cc489; --look: #f5a35c; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; }
.verdict { font-weight: 600; margin: 0; }
.verdict.passed { color: var(--pass); }
.verdict.other { color: var(--fail); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 16px 0; font-size: 14px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.plan { margin: 8px 0; padding-left: 22px; }
.expected { margin: 4px 0 16px; color: var(--muted); }
.strip { display: flex; gap: 12px; overflow-x: auto; padding: 8px 2px 16px; scroll-snap-type: x proximity; }
.card { flex: 0 0 236px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 8px; scroll-snap-align: start; }
.card.undone { opacity: 0.55; }
.shot { position: relative; width: 218px; margin: 0 auto 6px; }
.shot img { display: block; width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--line); }
.shot svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.noshot { height: 120px; display: grid; place-items: center; color: var(--muted); font-size: 13px; border: 1px dashed var(--line); border-radius: 6px; margin-bottom: 6px; }
.card h2 { font-size: 14px; margin: 0 0 4px; }
.card ul { margin: 0; padding-left: 16px; font-size: 12.5px; color: var(--muted); }
.legend { font-size: 13px; color: var(--muted); }
.legend span { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 12px; vertical-align: -1px; }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 12.5px; }
</style>
</head>
<body>
<main>
<h1>${escape(oneLine(title))}</h1>
<p class="verdict ${trace.outcome === 'passed' && (!trace.replay || trace.replay.outcome === 'passed') ? 'passed' : 'other'}">${escape(verdict(trace))}</p>
${replayed ? `<p>${escape(replayed)}</p>` : ''}
<dl class="facts">${facts.map(([term, value]) => `<dt>${escape(term)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>
${plan}
${expected}
<p class="legend">Each frame is the screen the decision saw, with typed text, test data and the keyboard painted grey, and empty fields marked empty.<span style="background: var(--act)"></span>acted on<span style="background: var(--look)"></span>where the model pointed, looking</p>
<div class="strip">
${cards}
</div>
${stop.length > 0 ? `<h2>Why it stopped</h2><ul>${stop.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : ''}
${spec ? `<h2>The test, with test data shown as {name}</h2><pre><code>${escape(spec)}</code></pre>` : ''}
</main>
</body>
</html>
`
}

function card(step: Step, trace: Trace, frames: Map<string, Buffer> | undefined, threshold: number): string {
  const image = step.frame ? frames?.get(step.frame) : undefined
  const shot = image
    ? `<div class="shot"><img src="data:image/jpeg;base64,${image.toString('base64')}" alt="The screen at step ${step.index}">${overlay(step, trace)}</div>`
    : `<div class="noshot">no frame</div>`
  return `<section class="card${step.undone || step.covered ? ' undone' : ''}">${shot}<h2>${step.index}. ${escape(headline(step, trace, threshold))}</h2><ul>${details(step)
    .map((detail) => `<li>${escape(detail)}</li>`)
    .join('')}</ul></section>`
}

/** The element acted on and, when the model looked, its box, drawn over the frame. */
function overlay(step: Step, trace: Trace): string {
  const size = trace.screen
  if (!size) return ''
  const shapes: string[] = []
  for (const taken of step.taken ?? []) {
    if (!taken.frame) continue
    const { x, y, w, h } = taken.frame
    shapes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="var(--act)" stroke-width="3" rx="4"/>`)
  }
  const box = step.look?.box
  if (box) {
    const x = box.left * size.width
    const y = box.top * size.height
    shapes.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${((box.right - box.left) * size.width).toFixed(1)}" height="${((box.bottom - box.top) * size.height).toFixed(1)}" fill="none" stroke="var(--look)" stroke-width="3" stroke-dasharray="6 4" rx="4"/>`,
    )
  }
  if (shapes.length === 0) return ''
  return `<svg viewBox="0 0 ${size.width} ${size.height}" preserveAspectRatio="none" aria-hidden="true">${shapes.join('')}</svg>`
}

/** One line for what a step did. The last step, when it acted on nothing, says how the run ended. */
function headline(step: Step, trace: Trace, threshold: number): string {
  if (step.taken?.length) return step.taken.map(describeTaken).join(', then ')
  if (step.covered) return 'Its choice was covered, so the model decided again'
  if (step.completed !== undefined) return `Step ${step.completed} of the plan done`
  const decision = step.look && step.look.used !== 'none' ? step.look.decision : step.decision
  if (step === trace.steps.at(-1)) {
    switch (trace.outcome) {
      case 'passed':
        return decision.goalMet >= threshold ? 'Goal reached' : 'Stopped, and the checks hold'
      case 'failed':
        return 'Goal reached, but a check failed'
      case 'escalated':
        return 'Too unsure to act'
      case 'gave-up':
        return 'Step limit reached'
      case 'error':
        return 'Broke off'
      case 'stuck':
        return decision.action === 'STUCK' ? 'No way forward' : 'Stopped going round in circles'
    }
  }
  if (decision.goalMet >= threshold) return 'Goal reached'
  return decision.action === 'STUCK' ? 'No way forward' : 'Unsure'
}

function details(step: Step): string[] {
  const out: string[] = []
  const { decision } = step
  // When the action came from looking, the text answer's numbers are about something else: say so.
  const replaced = (step.look?.used === 'action' || step.look?.used === 'box') && step.look.decision.action !== decision.action
  const answer = !replaced ? '' : decision.action === 'STUCK' ? ' there was no way forward' : ' of another action'
  out.push(`model: ${decision.confidence.toFixed(2)} sure${answer}, goal ${decision.goalMet.toFixed(2)}, ${decision.latencyMs} ms`)
  if (step.planStep !== undefined) out.push(`on plan step ${step.planStep}`)
  if (step.look) out.push(`looked at the screen (${step.look.why}): ${lookSummary(step)}`)
  if (step.lookError) out.push(`looked at the screen, but got no answer: ${step.lookError}`)
  if (step.covered) out.push('the element it chose was covered')
  for (const taken of step.taken ?? []) {
    out.push(`selector: ${taken.selector}`)
    if (taken.unlabeled) out.push('no label or id in the page source: found by looking, located by position')
  }
  for (const note of step.notes ?? []) out.push(note)
  if (step.backtrack) out.push(`dead end: went back to step ${step.backtrack.to} to try "${step.backtrack.instead}"`)
  if (step.retry) out.push(`step ${step.retry.of} again, with the model's runner-up`)
  if (step.undone) out.push('undone by a backtrack')
  return out
}

/** What a look concluded, in a few words. */
export function lookSummary(step: Step): string {
  const look = step.look!
  const answered = `${look.decision.latencyMs} ms`
  switch (look.used) {
    case 'goal':
      return `it sees the ${step.planStep !== undefined && step.completed !== undefined ? 'step' : 'goal'} done (${look.decision.goalMet.toFixed(2)}), ${answered}`
    case 'action':
      return look.decision.action === step.decision.action
        ? `it confirmed the same action (${look.decision.confidence.toFixed(2)} sure), ${answered}`
        : `it chose this action instead (${look.decision.confidence.toFixed(2)} sure), ${answered}`
    case 'box':
      return `it pointed at ${(look.pointedAt ?? 'a control').replace(/^Tap /, '')} (visible ${look.targetShown.toFixed(2)}), ${answered}`
    default:
      return `it saw no better way (${look.decision.action === 'STUCK' ? 'no way forward' : `${look.decision.confidence.toFixed(2)} sure`}, goal ${look.decision.goalMet.toFixed(2)}), ${answered}`
  }
}

function describeTaken(taken: TakenAction): string {
  if (taken.type === 'type') return `type ${taken.input} into "${taken.target}"`
  if (taken.type === 'scroll') return `scroll ${taken.direction} ${taken.target === 'screen' ? 'the screen' : `"${taken.target}"`}`
  if (taken.kind === 'key') return `press "${taken.target}"`
  if (taken.unlabeled) return 'tap an unlabeled control'
  return `${taken.kind === 'switch' ? 'toggle' : 'tap'} "${taken.target}"`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))]
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Text safe inside a Markdown table cell. */
function cell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|')
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

/**
 * Generated code with its test data replaced by `{name}`. The code holds each value as the app
 * showed it and, inside its string literals, escaped: an apostrophe as \\', and a quote in an
 * iOS predicate as \\\\\\". So besides the redactor's forms, each escaped form is replaced too.
 */
export function redactCode(code: string, inputs: Record<string, string>): string {
  let out = redactor(inputs)(code)
  for (const [name, value] of Object.entries(inputs)) {
    const predicate = quoted(value).slice(1, -1)
    for (const form of new Set([literalBody(value), predicate, literalBody(predicate)])) {
      if (form !== value && form.length >= 3) out = out.split(form).join(`{${name}}`)
    }
  }
  return out
}
