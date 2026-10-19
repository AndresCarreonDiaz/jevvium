## With the model in the loop: `jevvium explore`

| Flow | Passed | Outcomes | Exploring | Exploring, all runs | Whole command | Decisions | Requests | Looks | Input tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [login-plan](../../../criteria/login-plan.md) | 3 of 3 | passed 3 | 9.4 s | 9.4 s | 23.4 s | 6 | 6 | 0 | 6777 | $0.0003 |
| [login](../../../criteria/login.yml) | 3 of 3 | passed 3 | 9.2 s | 9.2 s | 23.4 s | 4 | 4 | 0 | 3757 | $0.0002 |
| [bike-light](../../../criteria/mydemo-ios/bike-light.md) | 3 of 3 | passed 3 | 9.7 s | 9.7 s | 24.7 s | 6 | 6 | 0 | 8082 | $0.0003 |
| [checkout-plan](../../../criteria/mydemo-ios/checkout-plan.md) | 3 of 3 | passed 3 | 22.0 s | 22.0 s | 57.8 s (with a 26.7 s failed replay) | 17 | 17 | 0 | 39333 | $0.0017 |
| [add-to-cart](../../../criteria/mydemo-ios/add-to-cart.yml) | 3 of 3 | passed 3 | 5.7 s | 5.7 s | 17.4 s | 4 | 4 | 0 | 5050 | $0.0002 |
| [cart-two-backpacks](../../../criteria/mydemo-ios/cart-two-backpacks.yml) | 3 of 3 | passed 3 | 8.8 s | 8.8 s | 22.3 s | 7 | 7 | 0 | 9435 | $0.0004 |

## Without: plain Appium

| Flow | Replay, in the explore session | `jevvium test`: the test | `jevvium test`: whole command | Test passed |
| --- | --- | --- | --- | --- |
| [login-plan](../../../criteria/login-plan.md) | 5.4 s (3 of 3 passed) | 6.1 s | 11.3 s | 3 of 3 |
| [login](../../../criteria/login.yml) | 5.4 s (3 of 3 passed) | 6.2 s | 11.3 s | 3 of 3 |
| [bike-light](../../../criteria/mydemo-ios/bike-light.md) | 5.9 s (3 of 3 passed) | 6.7 s | 11.8 s | 3 of 3 |
| [checkout-plan](../../../criteria/mydemo-ios/checkout-plan.md) | n/a (0 of 3 passed) | n/a | 31.3 s (failing) | 0 of 3 |
| [add-to-cart](../../../criteria/mydemo-ios/add-to-cart.yml) | 2.4 s (3 of 3 passed) | 3.2 s | 8.4 s | 3 of 3 |
| [cart-two-backpacks](../../../criteria/mydemo-ios/cart-two-backpacks.yml) | 4.6 s (3 of 3 passed) | 5.2 s | 10.4 s | 3 of 3 |

Every explore ran with `--vision`. Rounds: 3, one command per flow per round, on one simulator (iPhone 17, iOS 26.5), with jev-1.13.0. Every number is the median over the rounds. Exploring, decisions, requests, tokens and cost are over the runs whose outcome was passed; the whole-command times are over all the rounds. "Exploring" is the time from the first screen read to the verdict, with the model deciding each step; "whole command" adds starting Appium, the session, the app restart and the replay with plain Appium, and writing the test. "Outcomes" counts every round's verdict, and "Exploring, all runs" is the median exploring time over all of them, whatever their outcome. "Decisions" counts every answer the run kept, the "step done" and "goal reached" verdicts included; "Requests" adds the answers thrown away because the screen was still changing or the chosen element was covered, which cost tokens all the same. "Looks" is the median number of requests that carried a screenshot, over all rounds (they are in "Requests" too). "Replay" is that replay: the same selectors and commands as the generated test, in the same session, right after exploring. "`jevvium test`" runs the generated spec with WebdriverIO: "the test" is the time WebdriverIO reports for it, "whole command" adds starting Appium and the session. Cost is input tokens at TypeSafe's list price of $0.042 per million; output tokens are free at that price. The generated tests call no model, so a run costs $0 in model calls. Adding up the per-flow medians: exploring all 6 flows took 64.8 s and $0.0030. Over the 5 flows whose generated test passes (15 of 15 test runs), exploring took 42.8 s and $0.0014, and the tests 27.4 s and $0.
