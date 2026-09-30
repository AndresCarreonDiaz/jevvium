# Jev against Claude Sonnet 5.5

The nine criteria in `criteria/` (the WebdriverIO demo app) and `criteria/mydemo-ios` (Sauce Labs' shop app), explored three times with each model on one iPhone 17 simulator with iOS 26.5 (Xcode 27.0), replays off:

```bash
npm run benchmark -- --providers jev,claude-sonnet --repeat 3 --suites demo,shop --platform-version 26.5
```

- [`results.md`](results.md) is the table the script wrote, with its notes.
- Each round folder (`jev/demo-1` and so on) holds that round's traces.
- The Claude round folders also hold `claude-calls.jsonl`, one line per CLI run: its effort, API time, tokens and thinking tokens.

Jev answered as `jev-1.13.0`. Claude ran with `--provider claude` and `CLAUDE_MODEL=sonnet`, which the Claude Code CLI (2.1.285) resolved to `claude-sonnet-5-5`. It was signed in with a Claude subscription, and ran at medium effort with no tools and prompt caching off.

Given a one-character system prompt and a one-character prompt, that CLI sends 447 input tokens, so about 445 tokens of every Claude request are the CLI's own. At $2 per million input tokens, they account for about $0.89 of the $5.53 per 1,000 requests in the table.
