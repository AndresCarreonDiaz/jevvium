# Jev against Claude Sonnet 5.5 on the test plans

The three test plans, three rounds each, exploring only (`--no-verify`), on one iOS 26.5 simulator (iPhone 17; Apple M4 Max with 36 GB, Xcode 27.0), on 2026-10-10:

```bash
npm run benchmark -- --providers jev,claude-sonnet --suites plans-demo,plans-shop --repeat 3 --platform-version 26.5 --out benchmarks/2026-10-10-plans-jev-vs-claude-sonnet
```

[`results.md`](results.md) is the script's own table, over all three plans. Each `<provider>/<suite>-<round>/` folder holds the traces; `claude-calls.jsonl` logs every Claude Code CLI run. Sonnet ran through the Claude Code CLI on a Claude subscription, at medium effort, with prompt caching off; its token counts include the text the CLI adds to every run.

Per plan, medians over the three rounds:

| Plan | Model | Passed | Exploring | Requests | Input tokens | Output tokens | Cost per exploration | Decision latency, median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Log in](../../criteria/login-plan.md) | Jev (`jev-1.13.0`) | 3 of 3 | 5.6 s | 6 | 6,777 | 1,067 | $0.0003 | 109 ms |
| | Claude Sonnet 5.5 | 3 of 3 | 16.3 s | 6 | 10,298 | 336 | $0.024 | 1,866 ms |
| [Add the bike light to the cart](../../criteria/mydemo-ios/bike-light.md) | Jev | 3 of 3 | 6.9 s | 8 | 11,538 | 2,151 | $0.0005 | 132 ms |
| | Claude Sonnet 5.5 | 3 of 3 | 20.0 s | 8 | 17,605 | 431 | $0.040 | 1,838 ms |
| [Buy a backpack](../../criteria/mydemo-ios/checkout-plan.md) | Jev | 3 of 3 | 15.5 s | 24 | 63,391 | 12,547 | $0.0027 | 112 ms |
| | Claude Sonnet 5.5 | 3 of 3 | 59.5 s | 24 | 89,118 | 2,467 | $0.20 | 1,865 ms |

Cost is at list prices: Jev $0.042 per million input tokens, output free; Sonnet 5.5 $2 per million input tokens and $10 per million output tokens. Both models took the same number of decisions in every run, and the same number of requests in all but one: in one login round, Sonnet had an answer thrown away because the screen was still changing, and was asked once more.

These runs explore only. The test written from the checkout plan doesn't pass when it runs with plain Appium, because of the app's on-screen keyboard (see [the comparison with the generated tests](../2026-10-10-explore-vs-appium/README.md)); the other two pass.
