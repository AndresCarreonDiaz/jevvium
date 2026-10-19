## With the model in the loop: `jevvium explore`

| Flow | Passed | Outcomes | Exploring | Exploring, all runs | Whole command | Decisions | Requests | Looks | Input tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [sort-by-price](../../../criteria/mydemo-ios/sort-by-price.yml) | 0 of 3 | failed 3 | n/a | 31.2 s | 37.6 s | n/a | n/a | 4 | n/a | n/a |
| [signup](../../../criteria/signup.yml) | 0 of 3 | stuck 3 | n/a | 39.5 s | 45.8 s | n/a | n/a | 5 | n/a | n/a |
| [price-7-99](../../../criteria/mydemo-ios/price-7-99.md) | 0 of 3 | stuck 3 | n/a | 85.1 s | 92.4 s | n/a | n/a | 2 | n/a | n/a |

## Without: plain Appium

| Flow | Replay, in the explore session | `jevvium test`: the test | `jevvium test`: whole command | Test passed |
| --- | --- | --- | --- | --- |
| [sort-by-price](../../../criteria/mydemo-ios/sort-by-price.yml) | n/a | n/a | n/a | no test written |
| [signup](../../../criteria/signup.yml) | n/a | n/a | n/a | no test written |
| [price-7-99](../../../criteria/mydemo-ios/price-7-99.md) | n/a | n/a | n/a | no test written |

Every explore ran with `--vision`. Rounds: 3, one command per flow per round, on one simulator (iPhone 17, iOS 26.5), with jev-1.13.0, jev-1.14.0 (looking). Every number is the median over the rounds. Exploring, decisions, requests, tokens and cost are over the runs whose outcome was passed; the whole-command times are over all the rounds. "Exploring" is the time from the first screen read to the verdict, with the model deciding each step; "whole command" adds starting Appium, the session, the app restart and the replay with plain Appium, and writing the test. "Outcomes" counts every round's verdict, and "Exploring, all runs" is the median exploring time over all of them, whatever their outcome. "Decisions" counts every answer the run kept, the "step done" and "goal reached" verdicts included; "Requests" adds the answers thrown away because the screen was still changing or the chosen element was covered, which cost tokens all the same. "Looks" is the median number of requests that carried a screenshot, over all rounds (they are in "Requests" too). "Replay" is that replay: the same selectors and commands as the generated test, in the same session, right after exploring. "`jevvium test`" runs the generated spec with WebdriverIO: "the test" is the time WebdriverIO reports for it, "whole command" adds starting Appium and the session. Cost is input tokens at TypeSafe's list price of $0.042 per million; output tokens are free at that price. The generated tests call no model, so a run costs $0 in model calls. Adding up the per-flow medians: exploring all 3 flows took 0.0 s and $0.0000. Over the 0 flows whose generated test passes (0 of 0 test runs), exploring took 0.0 s and $0.0000, and the tests 0.0 s and $0.
