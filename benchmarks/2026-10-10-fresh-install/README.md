# Out of the box: a fresh install in an empty project

What a new user gets, measured on 2026-10-10 on the same Mac as the other benchmarks (Xcode 27.0, iOS 26.5 simulator "jevvium 2 (iPhone 17)", `jev-1.13.0`), by an agent that was told to follow the README's quick start and report everything that went wrong:

| Step | Command | Wall clock | Result |
| --- | --- | --- | --- |
| Pack 0.2.0 from the repo | `npm pack` | 1 s | 59 files, 91.9 kB |
| Install into an empty project | `npm init -y && npm i -D ./jevvium-0.2.0.tgz` | 14 s | 719 packages, 256 MB; npm reports 35 vulnerabilities and 4 deprecations, all inside Appium's and WebdriverIO's dependency trees |
| Starter files | `npx jevvium init` | | `criteria/example.md`, `.env.jevvium` (mode 0600), `.gitignore` entries |
| Check the plan | `npx jevvium validate criteria/example.md` | | 3 steps, 1 check, 2 inputs |
| Explore it | `npx jevvium explore criteria/example.md --app wdiodemoapp.app` | **77 s** | passed: exploring 6.1 s, replay with plain Appium 5.2 s; the other 61.7 s was the Appium session, 47 s of it Xcode building WebDriverAgent for the freshly installed driver |
| Run the test it wrote | `npx jevvium test --app wdiodemoapp.app` | **11 s** | passed |

[`example.md`](example.md) is the plan `init` wrote, [`example.trace.json`](example.trace.json) the explore's trace and [`example.ios.spec.ts`](example.ios.spec.ts) the test.

Two things this run found, both fixed afterwards:

- The generated test's name was the starter's whole explanation, 509 characters, with a period at every line wrap: the parser treated each wrapped line as its own paragraph, and the test was named after the goal rather than the plan's title. The explanation now lives in a comment the parser skips, paragraphs are joined, and the test takes the plan's title. The spec here shows the old behaviour.
- The documented command collided with a WebDriverAgent that an earlier run had left running for another simulator on port 8100, the default: the driver reuses whatever answers on that port, whichever simulator it belongs to. The agent worked around it with `--server`. jevvium now gives each simulator its own port, derived from its udid.

Also noted: nothing is printed while the session starts (now it is, with the time it took); `npm install` resolved `appium-xcuitest-driver` 12.17.0 where the repo's lockfile had 12.13.3, so the driver is now pinned; and jevvium leaves the simulator booted and WebDriverAgent running after a run, which is what makes the next session start in about 5 s.
