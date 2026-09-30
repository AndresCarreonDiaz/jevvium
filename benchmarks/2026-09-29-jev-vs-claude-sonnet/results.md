Suites: demo, shop. Rounds: 3. Replays off. † Over the 7 criteria every provider passed at least once, averaged per criterion. Pass rates differ on signup (jev 0 of 3, claude-sonnet 1 of 3).

| | jev | claude-sonnet |
| --- | --- | --- |
| Runs passed | 21 of 27 (78%) | 22 of 27 (81%) |
| Runs that broke (not counted) | 0 | 0 |
| Decisions kept per passed run † | 6.1 | 6.2 |
| Requests per passed run † | 8.8 | 8.9 |
| Exploring time per passed run † | 5.9 s | 21.7 s |
| Decision latency, median | 125 ms | 1814 ms |
| Decision latency, 90th percentile | 186 ms | 2516 ms |
| Input tokens per request | 1,702 | 2,353 |
| Cost per 1,000 requests | $0.071 | $5.53 |
| "Goal reached" Brier score (lower is better) | 0.009 | 0.016 |

claude-sonnet (claude-sonnet-5-5) ran through the Claude Code CLI on a Claude subscription, one CLI run per answer, at medium effort, with prompt caching off. It thought before answering in 25 of 224 CLI runs (5,345 thinking tokens): the CLI can't turn thinking off for a model that decides for itself when to think. Every reply was a usable answer. Its latency includes starting the CLI (212 ms on average); the API time alone had a median of 1600 ms and a 90th percentile of 2325 ms. Input tokens are each model's own count: the tokenizers differ, and Claude's include the answer format and text the CLI adds to every run. Its confidence is its own estimate, not a probability the model computed.
