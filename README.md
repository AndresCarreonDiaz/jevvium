# jevvium

[![CI](https://github.com/AndresCarreonDiaz/jevvium/actions/workflows/ci.yml/badge.svg)](https://github.com/AndresCarreonDiaz/jevvium/actions/workflows/ci.yml)

**Turn acceptance criteria into Appium tests.** You describe the behaviour a new feature should have. A decision model finds the path through the app, one tap at a time. jevvium then writes that path down as a plain WebdriverIO test, with fixed selectors and real assertions, that runs in CI with no AI in the loop.

```yaml
# criteria/login.yml
goal: A registered user logs in with a valid email and password and is told they are logged in.
inputs:
  email: qa.demo@example.com
  password: Str0ngPassw0rd
expect:
  - text: You are logged in!
```

```ts
// generated/login.ios.spec.ts
describe('login', () => {
  it('A registered user logs in with a valid email and password and is told they are logged in.', async () => {
    await $('~Login').click()
    await $('~input-email').setValue('qa.demo@example.com')
    await $('~input-password').setValue('Str0ngPassw0rd')
    await $('~Done').click()
    await expect($('-ios predicate string:label == "You are logged in!"')).toBeDisplayed()
  })
})
```

## Why

When a feature ships, someone has to work out which screens to go through, which elements to use and in what order, and then write that down as a test. AI agents that drive the app can do the working out, but running one on every CI build is slow, costs money on every run, and doesn't give the same result twice.

jevvium splits the job in two:

1. **Explore once.** A decision model picks each next action from the elements that are actually on screen, until the goal is reached.
2. **Run forever.** The path it found becomes an ordinary test. You review it, commit it, and CI runs it like any other test.

## How it works

```
criteria.yml ──► explore loop ─────────────────────────────► trace.json ──► generated spec ──► CI
                   │                                        (no test data)   (plain WebdriverIO)
                   ├─ read the page source
                   ├─ list what can be done: tap each button, type each input into each field
                   ├─ ask the model: which action next? is the goal reached?
                   ├─ stop and escalate if its confidence is low
                   └─ act, wait for the screen to settle, repeat
```

Each step is one request to [Jev](https://docs.typesafe.ai), TypeSafe's decision model. Jev doesn't write text: it picks one option from a list you give it and says how sure it is. That fits this problem well:

- **It can only pick elements that exist.** The options are built from the page source, so there is no invented selector to debug.
- **Its confidence is calibrated.** When it is unsure, jevvium stops and reports the step as `escalated` instead of tapping something at random.
- **One request answers both questions.** "What next?" and "Is the goal reached?" go out together, so each step is a single round trip.

The model never decides whether a test passes. When it thinks the goal is reached, jevvium checks the `expect` entries against the device, and the run only passes if all of them hold.

## Guardrails

| Risk | What jevvium does |
| --- | --- |
| The model is guessing | Stops below `--min-confidence` and marks the run `escalated` |
| The model is wrong about success | Pass or fail comes from the `expect` checks, never from the model |
| It goes round in circles | Stops when the same action is chosen 3 times on an unchanged screen, and after `--max-steps` |
| The screen is still loading | Waits until the page source stops changing and no spinner is showing |
| Test data leaks | Input values are replaced with `{name}` everywhere before anything is sent, and traces store input names only |

## Quick start

Requirements: Node 22, and Xcode with an iOS simulator or Android Studio with an emulator running.

```bash
npm ci
npm run apps                   # downloads the pinned WebdriverIO demo app builds
cp .env.example .env           # then add your TYPESAFE_API_KEY
npx appium                     # in another terminal
```

Explore a criterion and generate its test:

```bash
npm run jevvium -- explore criteria/login.yml --platform ios --app apps/wdiodemoapp.app --platform-version 26.5
```

It prints each step with the model's confidence and goal probability, then the outcome, the trace path and, if it passed, the generated spec in `generated/`.

Then run the generated tests the normal way:

```bash
npm run test:generated:ios
```

## Writing criteria

| Field | Required | Meaning |
| --- | --- | --- |
| `goal` | yes | The behaviour to reach, written the way you'd write an acceptance criterion |
| `inputs` | no | Test data the flow may type, by name. The model sees the names, never the values |
| `expect` | strongly recommended | Checks that must hold at the end: `id` (accessibility id) or `text` (visible text) |
| `id` | no | Name of the generated test. Defaults to the file name |

A criterion without `expect` can still pass, but only on the model's word, and the generated test gets a TODO where the assertion should be.

## Outcomes

| Outcome | Meaning | Test generated? |
| --- | --- | --- |
| `passed` | Goal reached and every expectation holds | yes |
| `failed` | The model thought the goal was reached, but an expectation doesn't hold. Often a real bug | no |
| `escalated` | Confidence dropped below the threshold. A person should look at that step | no |
| `stuck` | No action moves toward the goal, or it was repeating itself | no |
| `gave-up` | Step limit reached | no |

Every run writes a trace with each step's options, choice, probabilities, goal probability and latency. Traces contain no test data values, so they are safe to attach to CI runs or share.

## Using it as a library

The explorer only needs a small `Device` interface, so it runs inside an existing WebdriverIO session. jevvium isn't on npm yet, so for now import it from a clone:

```ts
import { explore, webdriverDevice, JevProvider, generateSpec, loadCriterion } from './jevvium/src/index.ts'

const criterion = loadCriterion('criteria/login.yml')
const trace = await explore(webdriverDevice(browser), criterion, { provider: new JevProvider() })
if (trace.outcome === 'passed') console.log(generateSpec(trace, criterion))
```

A different model can be plugged in by implementing `DecisionProvider`.

## What gets sent to TypeSafe

For each step: the goal, the visible text on screen, a description of each available action (element label, accessibility id, rough position), the steps already taken, and the names of the inputs. Test data values are replaced before sending. Screenshots are never sent. Still, don't point jevvium at screens that show real customer data.

## Status

Early, and built in the open.

- The explore, generate and run cycle has been run end to end on an iOS simulator against the demo app, driven by a scripted provider, and the generated test passes on its own.
- The Jev provider follows the [documented API](https://docs.typesafe.ai/api) and is unit tested against mocked responses.
- The Android parser is covered by unit tests on a hand-written page source, not yet on a real emulator.

### Next

- **Appium plugin**, so any Appium client (Java, Python, WebdriverIO) can call `driver.execute('jevvium: explore', ...)` in its own flows
- **Maestro export**, to write the found path as a Maestro YAML flow
- **Benchmark**: Jev against a general LLM on the same criteria, measuring success rate, steps, cost, latency, and whether the confidence is calibrated
- **Fallback provider** for escalated steps
- Android keyboard handling, scrolling to elements below the fold

## Development

```bash
npm test            # unit tests (no device needed)
npm run typecheck
npm run lint
```

Unit tests use real page sources captured from the demo app, in `test/fixtures`.

## License

[MIT](LICENSE)
