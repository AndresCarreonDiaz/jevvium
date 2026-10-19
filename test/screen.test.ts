import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { controlStates, redactScreen } from '../src/actions.ts'
import { toSelector } from '../src/locator.ts'
import { redactor } from '../src/redact.ts'
import { isBusy, maskRegions, needsFullRead, parseScreen } from '../src/screen.ts'
import type { Screen } from '../src/types.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8')
const summary = (screen: Screen) =>
  screen.elements.map((e) => `${e.kind} ${e.label} @${e.region} -> ${toSelector(e.locator)}`)

// The ios-*.xml fixtures are real page sources from the WebdriverIO demo app on an iOS 26.5 simulator.
describe('parseScreen on iOS', () => {
  it('finds React Native touchables, inputs and tab bar buttons on the login screen', () => {
    assert.deepEqual(summary(parseScreen(fixture('ios-login'), 'ios')), [
      'button Login @top -> ~button-login-container',
      'button Sign up @top -> ~button-sign-up-container',
      'input Email @top -> ~input-email',
      'input Password @middle -> ~input-password',
      'button LOGIN @middle -> ~button-LOGIN',
      'button Home @bottom -> ~Home',
      'button Webview @bottom -> ~Webview',
      // "Login" is also a text on this screen, so the accessibility id alone is ambiguous.
      'button Login @bottom -> -ios predicate string:type == "XCUIElementTypeButton" AND name == "Login"',
      'button Forms @bottom -> ~Forms',
      'button Swipe @bottom -> ~Swipe',
      'button Drag @bottom -> ~Drag',
      'button Menu @bottom -> ~Menu',
    ])
  })

  it('collects visible text without icon glyphs or duplicates', () => {
    assert.deepEqual(parseScreen(fixture('ios-login'), 'ios').texts, [
      'Login / Sign up Form',
      'Login',
      'Sign up',
      'When the device has Touch/FaceID (iOS) or FingerPrint enabled a biometrics button will be shown to use and test the login.',
      'LOGIN',
    ])
  })

  it('offers to scroll a list whose content sticks out of it, but not an alert whose message fits', () => {
    const lists = (name: string) => parseScreen(fixture(name), 'ios').elements.filter((e) => e.kind === 'list')
    // The shop app's catalog: a collection view whose last row of cells starts near its bottom edge.
    assert.deepEqual(summary({ ...parseScreen(fixture('ios-catalog'), 'ios'), elements: lists('ios-catalog') }), [
      'list screen @middle -> (//XCUIElementTypeCollectionView)[1]',
    ])
    assert.deepEqual(lists('ios-catalog')[0].scrolls, ['down'])
    // Its cells have no ids, so each is found by the product name it shows, not by its position in the list.
    const cells = parseScreen(fixture('ios-catalog'), 'ios').elements.filter((e) => e.label.startsWith('Sauce Labs'))
    assert.equal(toSelector(cells[0].locator), '//XCUIElementTypeCell[.//XCUIElementTypeStaticText[@label="Sauce Labs Backpack - Black"]]')
    assert.deepEqual(cells.map((e) => e.label).slice(0, 2), ['Sauce Labs Backpack - Black', 'Sauce Labs Backpack - Green'])
    // The demo app's Swipe tab: a page three screens tall with a carousel across it.
    assert.deepEqual(lists('ios-swipe')[0].scrolls, ['down', 'right'])
    // The alert's message scroll view reports "2 pages", but its text fits.
    assert.deepEqual(lists('ios-login-success'), [])
    assert.deepEqual(lists('ios-login'), [])
    assert.deepEqual(lists('ios-forms'), [], 'the Forms screen fits on one page')
  })

  it('only sees the alert when one covers the screen', () => {
    const screen = parseScreen(fixture('ios-login-success'), 'ios')
    assert.deepEqual(summary(screen), ['button OK @middle -> ~OK'])
    assert.deepEqual(screen.texts, ['Success', 'You are logged in!'])
  })

  it('names inputs by placeholder, never by the value typed into them', () => {
    const screen = parseScreen(fixture('ios-login-filled'), 'ios')
    const labels = screen.elements.map((e) => e.label)
    assert.ok(labels.includes('Email'))
    assert.ok(!JSON.stringify(screen).includes('qa.demo@example.com'))
    const inputs = (name: string) => parseScreen(fixture(name), 'ios').elements.filter((e) => e.kind === 'input').map((e) => e.empty)
    assert.deepEqual(inputs('ios-login'), [true, true], 'placeholders only')
    assert.deepEqual(inputs('ios-login-filled'), [false, false], 'both typed into')
  })

  it('offers the keyboard return key but not the rest of the keyboard window', () => {
    const labels = parseScreen(fixture('ios-login-filled'), 'ios').elements.map((e) => `${e.kind} ${e.label}`)
    assert.ok(labels.includes('key done'))
    for (const chrome of ['button Passwords', 'button Next keyboard', 'button shift']) {
      assert.ok(!labels.includes(chrome), `${chrome} should be left out`)
    }
  })

  it('names a field after the text just above it, but not after the error under the field before it', () => {
    const login = fixture('ios-login')
    const labels = (xml: string) => parseScreen(xml, 'ios').elements.filter((e) => e.kind === 'input').map((e) => `${e.label} (${e.placeholder ?? '-'})`)
    // The demo app shows its email error in an empty text between the two fields.
    const withError = login.replace(/(x="35" y="301" width="332" height="15" index="6")/, '$1 label="Please enter a valid email address"')
    assert.notEqual(withError, login)
    assert.deepEqual(labels(withError), ['Email (-)', 'Password (-)'])
    const captioned = login.replace(/(x="35" y="301" width="332" height="15" index="6")/, 'label="Your password" x="69" y="320" width="200" height="15" index="6"')
    assert.deepEqual(labels(captioned), ['Email (-)', 'Your password (Password)'])
  })

  it('reads whether a switch is on, since the text beside it is ambiguous', () => {
    const switchIn = (name: string) => parseScreen(fixture(name), 'ios').elements.find((e) => e.kind === 'switch')
    assert.equal(switchIn('ios-forms')?.checked, false)
    assert.equal(switchIn('ios-forms-switch-on')?.checked, true)
    assert.deepEqual(controlStates(parseScreen(fixture('ios-forms-switch-on'), 'ios')), ['The switch "switch" is on'])
  })

  it('knows the screen is busy while a spinner shows', () => {
    assert.equal(isBusy(fixture('ios-login-submitting'), 'ios'), true)
    assert.equal(isBusy(fixture('ios-login-success'), 'ios'), false)
  })
})

// A read without XCTest's `visible` is several times faster; these check that working
// visibility out from positions agrees with XCTest on the real screens.
describe('parseScreen from a read without visibility', () => {
  const fast = (name: string) => fixture(name).replace(/ visible="(?:true|false)"/g, '')

  it('sees the same screen as XCTest when nothing covers it', () => {
    for (const name of ['ios-home', 'ios-login', 'ios-login-submitting']) {
      const full = parseScreen(fixture(name), 'ios')
      const geometric = parseScreen(fast(name), 'ios', { visibility: 'geometry' })
      assert.deepEqual(summary(geometric), summary(full), name)
      assert.deepEqual(geometric.texts, full.texts, name)
    }
  })

  it('treats what is under the keyboard as covered, and still offers its return key', () => {
    const labels = parseScreen(fast('ios-login-filled'), 'ios', { visibility: 'geometry' }).elements.map((e) => `${e.kind} ${e.label}`)
    assert.ok(labels.includes('key done'))
    assert.ok(labels.includes('button LOGIN'))
    for (const covered of ['button Webview', 'button Forms', 'button Swipe', 'button Drag']) {
      assert.ok(!labels.includes(covered), `${covered} is under the keyboard`)
    }
  })

  it('asks for a full read when an alert sits in its own window', () => {
    assert.equal(needsFullRead(fast('ios-login-success')), true)
    assert.equal(needsFullRead(fast('ios-login')), false)
    assert.equal(needsFullRead(fast('ios-login-filled')), false, 'the keyboard window does not count')
  })

  it('still knows when a spinner is showing', () => {
    assert.equal(isBusy(fast('ios-login-submitting'), 'ios'), true)
    assert.equal(isBusy(fast('ios-login'), 'ios'), false)
  })

  it('ignores a spinner below the fold', () => {
    const offScreen = fast('ios-login-submitting').replace(/(<XCUIElementTypeActivityIndicator[^>]*?) y="\d+"/, '$1 y="1400"')
    assert.notEqual(offScreen, fast('ios-login-submitting'))
    assert.equal(isBusy(offScreen, 'ios'), false)
  })
})

// android-login.xml is hand-written in UiAutomator2's format to cover each locator fallback.
describe('parseScreen on Android', () => {
  it('picks the most stable unique locator for each element', () => {
    assert.deepEqual(summary(parseScreen(fixture('android-login'), 'android')), [
      'button Login @top -> ~button-login-container',
      'input Email @top -> ~input-email',
      'input Password @top -> ~input-password',
      'button LOGIN @middle -> ~button-LOGIN',
      'button Retry @middle -> android=new UiSelector().resourceId("com.wdiodemoapp:id/retry")',
      'button Help @middle -> //android.widget.Button[@text="Help"]',
      'button Login @bottom -> ~Login',
      'switch switch @middle -> ~switch',
    ])
  })

  it('leaves out hidden elements and the text inside inputs', () => {
    const screen = parseScreen(fixture('android-login'), 'android')
    assert.ok(!screen.elements.some((e) => e.label === 'Hidden'))
    assert.ok(!screen.texts.includes('qa.demo@example.com'))
  })
})

describe('redactScreen', () => {
  it('replaces test data values anywhere on screen with their names', () => {
    const screen = redactScreen(parseScreen(fixture('android-login'), 'android'), {
      email: 'qa.demo@example.com',
    })
    assert.ok(screen.texts.includes('Signed in as {email}'))
    assert.ok(!JSON.stringify(screen).includes('qa.demo@example.com'))
  })
})

describe('geometry for screenshots', () => {
  it('gives the screen size and each element its frame, in points', () => {
    const screen = parseScreen(fixture('ios-login-filled'), 'ios')
    assert.deepEqual(screen.size, { width: 402, height: 874 })
    const email = screen.elements.find((e) => e.id === 'input-email')!
    assert.deepEqual(email.frame, { x: 69, y: 211, w: 303, h: 40 })
    assert.deepEqual(email.centre, { x: 220.5, y: 231 })
  })

  it('keeps controls without a label apart, never offered from text, with a selector by position', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT>
      <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="app" label="app" visible="true" x="0" y="0" width="402" height="874">
        <XCUIElementTypeWindow type="XCUIElementTypeWindow" visible="true" x="0" y="0" width="402" height="874">
          <XCUIElementTypeButton type="XCUIElementTypeButton" visible="true" enabled="true" x="340" y="60" width="44" height="44"/>
          <XCUIElementTypeButton type="XCUIElementTypeButton" label="Checkout" name="checkout" visible="true" enabled="true" x="20" y="800" width="362" height="50"/>
          <XCUIElementTypeButton type="XCUIElementTypeButton" label="" visible="true" enabled="true" x="20" y="60" width="44" height="44"/>
        </XCUIElementTypeWindow>
      </XCUIElementTypeApplication></AppiumAUT>`
    const screen = parseScreen(xml, 'ios')
    assert.deepEqual(screen.elements.map((e) => e.label), ['Checkout'])
    assert.deepEqual(
      screen.unlabeled?.map((e) => [e.key, e.region, toSelector(e.locator)]),
      [
        ['u1', 'top', '(//XCUIElementTypeButton)[1]'],
        // An icon font's private-use character says nothing either. Its position counts every
        // button, named or not, since that is what the path matches.
        ['u2', 'top', '(//XCUIElementTypeButton)[3]'],
      ],
    )
  })
})

describe('maskRegions', () => {
  it('covers typed fields with what they hold, test data anywhere, and the keyboard', () => {
    const regions = maskRegions(fixture('ios-login-filled'), 'ios', redactor({ email: 'qa.demo@example.com' }))
    const labels = regions.map((r) => r.label)
    assert.ok(labels.includes('{email}'), labels.join(', '))
    assert.ok(labels.includes('secure text'), labels.join(', '))
    const keyboard = regions.find((r) => r.label === 'keyboard')!
    assert.equal(keyboard.frame.x, 0)
    assert.equal(keyboard.frame.w, 402)
    assert.equal(keyboard.frame.y + keyboard.frame.h, 874)
  })

  it('masks a text that shows test data even when it is not a field, and nothing on a screen without any', () => {
    const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="402" height="874">
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Signed in as QA.DEMO@EXAMPLE.COM" visible="true" x="10" y="100" width="380" height="20"/>
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Welcome" visible="true" x="10" y="140" width="380" height="20"/>
    </XCUIElementTypeApplication></AppiumAUT>`
    assert.deepEqual(maskRegions(xml, 'ios', redactor({ email: 'qa.demo@example.com' })), [
      { frame: { x: 10, y: 100, w: 380, h: 20 }, label: 'Signed in as {email}' },
    ])
    assert.deepEqual(maskRegions(fixture('ios-home'), 'ios', redactor({ email: 'qa.demo@example.com' })), [])
  })

  it('works on Android, where a field shows what was typed as its text', () => {
    const regions = maskRegions(fixture('android-login'), 'android', redactor({ email: 'qa.demo@example.com' }))
    assert.deepEqual(regions, [
      { frame: { x: 60, y: 500, w: 960, h: 120 }, label: '{email}' },
      { frame: { x: 60, y: 660, w: 960, h: 120 }, label: 'empty' },
      { frame: regions[2].frame, label: 'Signed in as {email}' },
    ])
  })
})

describe('selectors the path really finds', () => {
  it('counts an unnamed Android element among every one of its class, named or not', () => {
    const xml = `<hierarchy width="1080" height="2400"><android.widget.FrameLayout bounds="[0,0][1080,2400]" displayed="true">
      <android.widget.ImageButton content-desc="Back" clickable="true" enabled="true" displayed="true" bounds="[0,100][100,200]"/>
      <android.widget.ImageButton clickable="true" enabled="true" displayed="true" bounds="[980,100][1080,200]"/>
    </android.widget.FrameLayout></hierarchy>`
    const screen = parseScreen(xml, 'android')
    assert.equal(toSelector(screen.unlabeled![0].locator), '(//android.widget.ImageButton)[2]')
  })

  it("doesn't anchor a cell on a text that a cell around it shows too", () => {
    const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="402" height="874">
      <XCUIElementTypeCell type="XCUIElementTypeCell" visible="true" enabled="true" x="0" y="0" width="402" height="400">
        <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Bags" visible="true" x="10" y="10" width="200" height="20"/>
        <XCUIElementTypeCell type="XCUIElementTypeCell" visible="true" enabled="true" x="0" y="100" width="402" height="100">
          <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Backpack" visible="true" x="10" y="110" width="200" height="20"/>
        </XCUIElementTypeCell>
      </XCUIElementTypeCell>
    </XCUIElementTypeApplication></AppiumAUT>`
    const inner = parseScreen(xml, 'ios').elements.find((e) => e.label === 'Backpack')!
    // //XCUIElementTypeCell[.//XCUIElementTypeStaticText[@label="Backpack"]] would find the outer cell first.
    assert.equal(toSelector(inner.locator), '(//XCUIElementTypeCell)[2]')
  })
})

describe('maskRegions: fields', () => {
  it('masks an empty field whose placeholder shows test data, and a field holding exactly its placeholder when that is test data', () => {
    const xml = (value: string) => `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="402" height="874">
      <XCUIElementTypeTextField type="XCUIElementTypeTextField" value="${value}" placeholderValue="qa.demo@example.com" visible="true" x="10" y="100" width="380" height="40"/>
    </XCUIElementTypeApplication></AppiumAUT>`
    const redact = redactor({ email: 'qa.demo@example.com' })
    assert.deepEqual(maskRegions(xml(''), 'ios', redact).map((r) => r.label), ['{email}'])
    assert.deepEqual(maskRegions(xml('qa.demo@example.com'), 'ios', redact).map((r) => r.label), ['{email}'])
  })

  it('marks an empty field as empty, since in a screenshot its placeholder looks like a value', () => {
    const regions = maskRegions(fixture('ios-login'), 'ios', redactor({ email: 'qa.demo@example.com' }))
    assert.deepEqual(regions.map((r) => r.label), ['empty', 'empty'])
  })
})

describe('maskRegions: empty fields', () => {
  const form = (visible: boolean) => `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="402" height="874"${visible ? ' visible="true"' : ''}>
    <XCUIElementTypeWindow type="XCUIElementTypeWindow" x="0" y="0" width="402" height="874"${visible ? ' visible="true"' : ''}>
      <XCUIElementTypeTextField type="XCUIElementTypeTextField" value="Rebecca Winter" placeholderValue="Rebecca Winter" x="16" y="360" width="361" height="45"${visible ? ' visible="false"' : ''}/>
      <XCUIElementTypeAlert type="XCUIElementTypeAlert" label="Validation Error!" x="61" y="300" width="271" height="200"${visible ? ' visible="true"' : ''}>
        <XCUIElementTypeButton type="XCUIElementTypeButton" label="OK" x="61" y="457" width="271" height="45"${visible ? ' visible="true"' : ''}/>
      </XCUIElementTypeAlert>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication></AppiumAUT>`

  it("doesn't mark an empty field behind an alert, so nothing covers the alert's buttons, on a full read or a fast one", () => {
    assert.deepEqual(maskRegions(form(true), 'ios', redactor({})), [])
    assert.deepEqual(maskRegions(form(false), 'ios', redactor({})), [])
  })

  it("doesn't mark an empty field that holds a control of its own, such as a scan icon", () => {
    const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="402" height="874">
      <XCUIElementTypeSearchField type="XCUIElementTypeSearchField" placeholderValue="Search" visible="true" x="16" y="100" width="361" height="40">
        <XCUIElementTypeButton type="XCUIElementTypeButton" visible="true" x="340" y="105" width="30" height="30"/>
      </XCUIElementTypeSearchField>
      <XCUIElementTypeTextField type="XCUIElementTypeTextField" placeholderValue="Name" visible="true" x="16" y="200" width="361" height="40"/>
    </XCUIElementTypeApplication></AppiumAUT>`
    assert.deepEqual(maskRegions(xml, 'ios', redactor({})), [{ frame: { x: 16, y: 200, w: 361, h: 40 }, label: 'empty' }])
  })
})
