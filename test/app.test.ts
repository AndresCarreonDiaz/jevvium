import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { checkSimulatorBuild, platformOf, supportedPlatforms } from '../src/app.ts'

describe('platformOf', () => {
  it('tells the platform from the app file', () => {
    assert.equal(platformOf('build/My App.app'), 'ios')
    assert.equal(platformOf('dist/App.IPA'), 'ios')
    assert.equal(platformOf('out/app.zip'), 'ios')
    assert.equal(platformOf('app-debug.apk'), 'android')
    assert.equal(platformOf('builds/latest'), undefined)
  })
})

// plutil and unzip come with macOS; elsewhere the build check is skipped, as it is in the CLI.
describe('the simulator build check', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevvium-app-test-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const app = (name: string, platforms: string[]) => {
    const path = join(dir, `${name}.app`)
    mkdirSync(path, { recursive: true })
    const items = platforms.map((platform) => `<string>${platform}</string>`).join('')
    writeFileSync(
      join(path, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleSupportedPlatforms</key><array>${items}</array></dict></plist>`,
    )
    return path
  }

  it('reads the platforms of an .app, and of the .app inside an .ipa', async () => {
    assert.deepEqual(await supportedPlatforms(app('Sim', ['iPhoneSimulator'])), ['iPhoneSimulator'])
    mkdirSync(join(dir, 'Payload'), { recursive: true })
    app('Payload/Device', ['iPhoneOS'])
    execFileSync('zip', ['-q', '-r', 'Device.ipa', 'Payload'], { cwd: dir })
    assert.deepEqual(await supportedPlatforms(join(dir, 'Device.ipa')), ['iPhoneOS'])
  })

  it('refuses a device build and says how to build for the simulator', async () => {
    await assert.doesNotReject(checkSimulatorBuild(app('Fine', ['iPhoneSimulator'])))
    await assert.rejects(checkSimulatorBuild(app('Phone', ['iPhoneOS'])), /built for iPhoneOS, not for the iOS Simulator[\s\S]*-sdk iphonesimulator/)
  })

  it('lets an app through when its platforms are unreadable', async () => {
    const odd = join(dir, 'Odd.app')
    mkdirSync(odd, { recursive: true })
    await assert.doesNotReject(checkSimulatorBuild(odd))
  })
})
