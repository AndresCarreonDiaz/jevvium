# Where jevvium fits in a team

jevvium is a way to get the Appium tests you don't have. It is not a runner to adopt instead of Appium: what it leaves behind is a plain WebdriverIO spec, so a team with no automation and a team with a large suite end up in the same place, ordinary tests that run wherever Appium runs, with no model in the loop.

So the answer to "jevvium alone, or Appium plus jevvium?" is both, in that order. jevvium writes the tests; Appium runs them.

## What runs where

| | Exploring a plan (`jevvium explore`) | Running the test it wrote |
| --- | --- | --- |
| Where | A Mac with Xcode and an iOS Simulator: a laptop, an office Mac mini, a macOS CI runner | Anywhere Appium runs: the same Mac, a macOS CI job, a device cloud |
| Needs | A TypeSafe key | No key, no model |
| Model cost | Hundredths to tenths of a cent per plan ([measured](../README.md#explore-once-run-as-often-as-you-like-what-each-costs)) | $0 |
| How often | Once per plan, and again when the app's UI changes | Every build |

## The journey

### 1. One Mac, no automation

The trigger is usually a release where checking by hand took a day. One engineer with a Mac that can build the app for the simulator writes the flows the team checks by hand as plans: a title, numbered steps, and `Expected:` lines. They explore each plan, read the per-step lines and the run report (each step's screen, with typed text painted over), and commit the tests whose replay with plain Appium passed. Runs that end `failed` or `stuck` are findings about the app or the plan, not noise: on the demo apps in this repo, they found an app that sorts prices as text and a form whose keyboard covers its own button.

What this stage needs that jevvium has: plans in plain words, the replay proof before a test is written, test data replaced by `{name}` in what the model is sent and painted over in screenshots, as far as jevvium can recognize it (see [what gets sent](../README.md#what-gets-sent-to-the-decision-model)), and the run report. What it doesn't have yet: Android on an emulator (experimental, never run on one), and a way to start a plan where another test ends.

### 2. The generated tests run in CI, without jevvium

Once a generated test has caught something on a laptop, the team runs the tests on every pull request: `npx jevvium test` or their own WebdriverIO config, in a macOS job or on an office Mac mini registered as a self-hosted runner. This job needs no key and calls no model. A team that already has an Appium suite skips straight here: the generated specs go next to its own, under its own config.

### 3. jevvium proposes the test from the pull request (planned)

The step nobody does is writing the test for each new feature, even when the pull request already says how to check it in a "## Test plan" section. The planned proposer is a CI job that reads that section, explores it on a macOS runner, replays the path with plain Appium a few times, and posts one comment with the plan, the run report's frames, the replay result and the spec. The design rules:

- **Opt-in**: a label or a "## Test plan" section; a `no-jevvium` label mutes it; never on pull requests from forks, since the job holds the key.
- **Silent when nothing was proven**: a run that ends stuck or escalated goes into a neutral check's details, not a comment. A run where the goal was reached but a check failed gets one line, because that is usually an app bug.
- **Never pushes to the pull request's branch**: the spec arrives in the comment, or later in a draft pull request of its own, and a person merges it.
- **Never blocks a merge**: the check is neutral.

### 4. A UI change breaks a generated test (planned)

Nobody patches the test by hand and nothing swaps selectors at run time. The job explores the same plan again on the new build and proposes the difference, old steps against new, with both runs' frames. If the old path still passes, the failure was the runner, not the app, and nothing is proposed. If the new exploration fails on the same `Expected` check, the comment says the app changed, not the test, and quotes what is missing: that is the regression the test exists to catch.

## What jevvium is not

- **Not self-healing.** It proposes a reviewable change; it never rewrites a test while it runs.
- **Not AI in CI.** The generated tests call no model. The model runs while exploring, once per plan.
- **Not cross-platform yet.** iOS Simulators work; Android is unit-tested on a page source only.
- **Not for screens with real customer data.** Use made-up test data, and read [what gets sent to the model](../README.md#what-gets-sent-to-the-decision-model), screenshots included, before pointing it at an app.

## A sketch of the proposer job (not built, not run)

What it would look like on GitHub Actions. `jevvium propose` doesn't exist yet; the rest is standard.

```yaml
name: jevvium proposes tests
on:
  pull_request:
    types: [opened, synchronize, labeled]
permissions:
  contents: read
  pull-requests: write   # the one comment
  checks: write          # the neutral check
concurrency:
  group: jevvium-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  propose:
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository
      && !contains(github.event.pull_request.labels.*.name, 'no-jevvium')
      && contains(github.event.pull_request.body, '## Test plan')
    runs-on: macos-15
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7          # pin actions to commit SHAs
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: xcrun simctl boot "iPhone 17" || true
      - run: xcodebuild -scheme YourApp -sdk iphonesimulator -configuration Debug -derivedDataPath build build -quiet
      - run: npx jevvium propose --from-pr ${{ github.event.pull_request.number }} --app build/Build/Products/Debug-iphonesimulator/YourApp.app
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Before quoting a cost per pull request, one hosted run has to be measured: the app's own build is usually the longest step, and WebDriverAgent's first build took 47 s on an M4 Max but hasn't been timed on a hosted runner.
