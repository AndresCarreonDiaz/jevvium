# Log in

A test plan for jevvium: a title, the steps a tester would follow, and what the screen
shows when it worked. jevvium explores your app to find the taps and the typing that
carry the plan out, then writes them down as a plain WebdriverIO test.

Check it without a device with `npx jevvium validate criteria/example.md`, and explore it
with `npx jevvium explore criteria/example.md --app path/to/YourApp.app`. Paragraphs like
these two are context for the model; delete them once you don't need them.

1. Open the Login tab at the bottom of the screen
2. Enter qa.demo@example.com as the email and Str0ngPassw0rd as the password
3. Tap LOGIN

Expected: "You are logged in!"

<!--
Steps: numbered lines, in order. jevvium works through them one at a time.
Test data: "Enter <value> as the <name>" in a step. Only the name reaches the model; the
  value is typed and ends up in the test, so use made-up data.
Expected: each quoted text must be on screen, whole, at the end. Say "contains" for a part
  of a text (contains "Order #"), or "id X" for an accessibility id. Checked without any
  model: the run only passes if every check holds.
-->
