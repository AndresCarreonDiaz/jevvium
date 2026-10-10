## With the model in the loop: `jevvium explore`

| Flow | Passed | Exploring | Whole command | Decisions | Requests | Input tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [login-plan](../../criteria/login-plan.md) | 3 of 3 | 5.9 s | 18.7 s | 6 | 6 | 6777 | $0.0003 |
| [login](../../criteria/login.yml) | 3 of 3 | 5.5 s | 18.4 s | 4 | 4 | 3757 | $0.0002 |
| [bike-light](../../criteria/mydemo-ios/bike-light.md) | 3 of 3 | 6.7 s | 19.8 s | 6 | 8 | 11538 | $0.0005 |
| [checkout-plan](../../criteria/mydemo-ios/checkout-plan.md) | 3 of 3 | 15.4 s | 48.5 s (with a 26.4 s failed replay) | 17 | 24 | 62811 | $0.0026 |
| [add-to-cart](../../criteria/mydemo-ios/add-to-cart.yml) | 3 of 3 | 4.1 s | 14.3 s | 5 | 8 | 12048 | $0.0005 |
| [cart-two-backpacks](../../criteria/mydemo-ios/cart-two-backpacks.yml) | 3 of 3 | 5.7 s | 17.2 s | 7 | 11 | 16876 | $0.0007 |

## Without: plain Appium

| Flow | Replay, in the explore session | `jevvium test`: the test | `jevvium test`: whole command | Test passed |
| --- | --- | --- | --- | --- |
| [login-plan](../../criteria/login-plan.md) | 5.3 s (3 of 3 passed) | 6.2 s | 11.3 s | 3 of 3 |
| [login](../../criteria/login.yml) | 5.4 s (3 of 3 passed) | 6.4 s | 11.4 s | 3 of 3 |
| [bike-light](../../criteria/mydemo-ios/bike-light.md) | 6.0 s (3 of 3 passed) | 6.6 s | 11.8 s | 3 of 3 |
| [checkout-plan](../../criteria/mydemo-ios/checkout-plan.md) | n/a (0 of 3 passed) | n/a | 30.8 s (failing) | 0 of 3 |
| [add-to-cart](../../criteria/mydemo-ios/add-to-cart.yml) | 3.2 s (3 of 3 passed) | 3.9 s | 9.0 s | 3 of 3 |
| [cart-two-backpacks](../../criteria/mydemo-ios/cart-two-backpacks.yml) | 4.7 s (3 of 3 passed) | 5.1 s | 10.1 s | 3 of 3 |

Rounds: 3, one command per flow per round, on one simulator (iPhone 17, iOS 26.5), with jev-1.13.0. Every number is the median over the rounds. Exploring, decisions, requests, tokens and cost are over the runs whose outcome was passed; the whole-command times are over all the rounds. "Exploring" is the time from the first screen read to the verdict, with the model deciding each step; "whole command" adds starting Appium, the session, the app restart and the replay with plain Appium, and writing the test. "Decisions" counts every answer the run kept, the "step done" and "goal reached" verdicts included; "Requests" adds the answers thrown away because the screen was still changing or the chosen element was covered, which cost tokens all the same. "Replay" is that replay: the same selectors and commands as the generated test, in the same session, right after exploring. "`jevvium test`" runs the generated spec with WebdriverIO: "the test" is the time WebdriverIO reports for it, "whole command" adds starting Appium and the session. Cost is input tokens at TypeSafe's list price of $0.042 per million; output tokens are free at that price. The generated tests call no model, so a run costs $0 in model calls. Adding up the per-flow medians: exploring all 6 flows took 43.4 s and $0.0048. Over the 5 flows whose generated test passes (15 of 15 test runs), exploring took 28.0 s and $0.0021, and the tests 28.2 s and $0.
