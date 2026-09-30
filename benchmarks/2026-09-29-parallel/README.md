# One simulator against four

The five shop-app criteria in `criteria/mydemo-ios`, explored with replays off, on an
iPhone 17 simulator with iOS 26.5 (Xcode 27.0) and `jev-1.13.0`, twice each way:

```bash
npm run jevvium -- explore criteria/mydemo-ios/*.yml --platform ios --app "apps/mydemo-ios/Payload/My Demo App.app" \
  --max-steps 20 --device "iPhone 17" --platform-version 26.5 --no-verify [--parallel 4]
```

The CLI's closing lines, with the wall clock including the sessions starting:

| Run | Summary |
| --- | --- |
| one-simulator-1 | 5 criteria in 42.1 s: 4 passed, 1 stuck |
| four-simulators-1 | 5 criteria in 21.7 s on 4 simulators: 4 passed, 1 stuck |
| one-simulator-2 | 5 criteria in 49.8 s: 4 passed, 1 stuck |
| four-simulators-2 | 5 criteria in 21.1 s on 4 simulators: 4 passed, 1 stuck |
| four-simulators-video | 5 criteria in 22.0 s on 4 simulators: 4 passed, 1 stuck |

`four-simulators-video` is the run in the demo GIF, recorded with the four simulators' screens being captured at the same time.

The stuck criterion is the app's sorting bug (see the README). Each folder holds the traces of one run.
