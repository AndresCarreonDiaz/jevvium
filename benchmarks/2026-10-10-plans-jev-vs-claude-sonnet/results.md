Suites: plans-demo, plans-shop. Rounds: 3. Replays off. † Over the 3 criteria every provider passed at least once, averaged per criterion.

| | jev | claude-sonnet |
| --- | --- | --- |
| Runs passed | 9 of 9 (100%) | 9 of 9 (100%) |
| Runs that broke (not counted) | 0 | 0 |
| Decisions kept per passed run † | 9.7 | 9.7 |
| Requests per passed run † | 12.7 | 12.8 |
| Exploring time per passed run † | 9.4 s | 32.5 s |
| Decision latency, median | 116 ms | 1865 ms |
| Decision latency, 90th percentile | 179 ms | 2658 ms |
| Input tokens per request | 2,158 | 3,076 |
| Cost per 1,000 requests | $0.091 | $7.03 |
| "Goal reached" Brier score (lower is better) | 0.019 | 0.027 |

claude-sonnet (claude-sonnet-5-5) ran through the Claude Code CLI on a Claude subscription, one CLI run per answer, at medium effort, with prompt caching off. It thought before answering in 18 of 115 CLI runs (2,783 thinking tokens): the CLI can't turn thinking off for a model that decides for itself when to think. Every reply was a usable answer. Its latency includes starting the CLI (208 ms on average); the API time alone had a median of 1656 ms and a 90th percentile of 2452 ms. Input tokens are each model's own count: the tokenizers differ, and Claude's include the answer format and text the CLI adds to every run. Its confidence is its own estimate, not a probability the model computed.
