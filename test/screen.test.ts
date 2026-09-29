import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { redactScreen } from '../src/actions.ts'
import { toSelector } from '../src/locator.ts'
import { isBusy, parseScreen } from '../src/screen.ts'
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
  })

  it('offers the keyboard return key but not the rest of the keyboard window', () => {
    const labels = parseScreen(fixture('ios-login-filled'), 'ios').elements.map((e) => `${e.kind} ${e.label}`)
    assert.ok(labels.includes('key done'))
    for (const chrome of ['button Passwords', 'button Next keyboard', 'button shift']) {
      assert.ok(!labels.includes(chrome), `${chrome} should be left out`)
    }
  })

  it('knows the screen is busy while a spinner shows', () => {
    assert.equal(isBusy(fixture('ios-login-submitting'), 'ios'), true)
    assert.equal(isBusy(fixture('ios-login-success'), 'ios'), false)
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
