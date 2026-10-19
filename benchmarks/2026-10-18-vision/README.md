# Screenshots and looking at the screen: what they cost and what they change

Measured on 2026-10-18 and 19 on one iOS 26.5 simulator (iPhone 17; Apple M4 Max with 36 GB, macOS 26.6.2, Xcode 27.1), with `jev-1.13.0` deciding and, with `--vision`, `jev-1.14.0` looking. Each folder is one `npm run compare -- --repeat 3 --platform-version 26.5` ([`scripts/compare.ts`](../../scripts/compare.ts)) with different explore options, and holds its own `results.md`, with each round's trace, generated test and timings. The terminal logs and the run folders, with each step's masked frame and the run reports, were kept out of the repository, except [one run folder](hard-vision-always/round-1/price-7-99) as an example of a run report.

| Folder | Explore options | Flows |
| --- | --- | --- |
| [`frames`](frames/results.md) | none: the default, which keeps a masked frame of each step | the six flows of [the October 10 benchmark](../2026-10-10-explore-vs-appium) |
| [`no-frames`](no-frames/results.md) | `--screenshots off` | the same six |
| [`vision`](vision/results.md) | `--vision` | the same six |
| [`vision-always`](vision-always/results.md) | `--vision=always` | the same six |
| [`hard-text`](hard-text/results.md) | none | the two criteria that end `stuck` on these apps, and [a plan that needs a price only the screen shows](../../criteria/mydemo-ios/price-7-99.md) |
| [`hard-vision`](hard-vision/results.md) | `--vision` | the same three |
| [`hard-vision-always`](hard-vision-always/results.md) | `--vision=always` | the same three |

## What came out

| The six flows | Passed | Exploring, sum of the medians | Input tokens, sum of the medians | Requests with a screenshot, per run |
| --- | --- | --- | --- | --- |
| Frames kept | 18 of 18 | 65.2 s | 73,010 | 0 |
| `--screenshots off` | 18 of 18 | 64.4 s | 73,014 | 0 |
| `--vision` | 18 of 18 | 64.8 s | 72,434 | 0 |
| `--vision=always` | 18 of 18 | 73.2 s | 161,472 | 3 to 11 |

| Criterion | Text only | `--vision` | `--vision=always` |
| --- | --- | --- | --- |
| [Sort by price](../../criteria/mydemo-ios/sort-by-price.yml) | stuck 3 of 3, 52.0 s | failed 3 of 3, 31.2 s | failed 3 of 3, 32.0 s |
| [Sign up](../../criteria/signup.yml) | stuck 3 of 3, 24.4 s | stuck 3 of 3, 39.5 s | stuck 3 of 3, 37.6 s |
| [Open the product that costs $7.99](../../criteria/mydemo-ios/price-7-99.md) | stuck 3 of 3, 85.2 s | stuck 3 of 3, 85.1 s | passed 3 of 3, 20.7 s |

Times in the second table are the median exploring time over the three rounds, whatever their outcome.

- **Keeping frames costs about 1%.** The screenshot is taken while the model decides, and its masks are drawn off the decision's path: 0.8 s more over the 44 decisions of the six flows.
- **`--vision` never looked on the six flows.** It looks only where the answer from text alone would end the run, and on these flows it never would.
- **`--vision=always` costs about 12% more time and 2.2 times the tokens on the six flows.** That is a second request at every step the model hasn't called done, with a 402 x 874 frame: 2,746 input tokens per look request (the median over 202), and 151 ms per look against 128 ms per decision from text. All six flows, explored once, came to $0.0068 at TypeSafe's list price, against $0.0031 without looking.
- **Sorting by price: `failed` is the right answer.** The app sorts prices as text, so the cheapest product, the Onesie, is not first. From text, every price reads "Product Price", the model can't tell whether the sort worked, and it wanders until it is stuck. Looking at the prices, it judges the sort done, the check for the Onesie fails, and the run ends `failed` on the app's bug, in about 60% of the time.
- **Sign up: looking doesn't help**, because the problem isn't what the model sees: the simulator drops characters typed into the form (see the README's Status).
- **The $7.99 plan passes only by looking at every step.** Every price reads "Product Price" in the page source. From text, the model keeps scrolling (a median confidence of 0.62 over 45 scrolls, never below 0.32), past the Onesie, so `--vision`, which looks only where the run would end, doesn't look until the run is stuck at the bottom of the list. With the Onesie on screen, the answer from text was to scroll on, at 0.41 to 0.46; looking, it was to open the Onesie, at 0.96 to 0.99, in all three rounds. Their replays passed, and the tests they wrote passed 3 of 3.

## What to know when reading the numbers

- **Xcode 27.1 broke the native helper's touches**, so in every run the first tap was lost, sent again through Appium, and every tap after it went through Appium. Exploring therefore takes longer than in the October 10 benchmark, which ran with Xcode 27.0 and direct taps: compare these folders with each other, not with that one.
- `vision-always`, `hard-vision` and `hard-vision-always` ran on 19 October from 13:58 to 14:28, on the code this folder was committed with. `frames`, `no-frames`, `vision` and `hard-text` ran from 09:20 to 10:19, on code whose later changes only touch what a look sees and does (empty fields marked `empty`, after a placeholder in the shipping form read as a value and the checkout plan looped on "To Payment"; a look's action taken only when surer than the text answer; how a look is worded), and when a lost tap is sent again, which on this simulator, where every direct tap is lost, happens at the same first tap either way. None of it changes a run that never looks, which is every run in those four folders.
- One generated login test failed 2 of its 3 runs in `no-frames` ("You are logged in!" never showed), while the same test, from the same path, passed in every other folder. Nothing of jevvium's runs there, only WebdriverIO and XCTest; the likely cause is the simulator dropping typed characters, as on the sign-up form.
- The checkout plan's replay and generated test fail in every folder, on the app's on-screen keyboard covering "To Payment", as in the October 10 benchmark.
- A first attempt at these runs, on 18 October, used code that two rounds of review changed afterwards; its numbers aren't published.
