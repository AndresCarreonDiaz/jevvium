import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Platform } from './types.ts'

const run = promisify(execFile)

/** How to get an iOS app that runs on a simulator, for error messages. */
export const SIMULATOR_BUILD = [
  'Build it for the simulator, for example:',
  '  xcodebuild -scheme <YourScheme> -sdk iphonesimulator -configuration Debug -derivedDataPath build build',
  'and pass --app build/Build/Products/Debug-iphonesimulator/<YourApp>.app. Running the app on a simulator',
  'from Xcode leaves the same .app in ~/Library/Developer/Xcode/DerivedData/<YourApp>-*/Build/Products/Debug-iphonesimulator.',
].join('\n')

/** The platform an app file is for, from its extension, or undefined when it doesn't say. */
export function platformOf(app: string): Platform | undefined {
  const extension = extname(app).toLowerCase()
  if (extension === '.apk') return 'android'
  if (extension === '.app' || extension === '.ipa' || extension === '.zip') return 'ios'
  return undefined
}

/**
 * Throws when an iOS app can't run on a simulator. A build for devices (an archive,
 * TestFlight, most CI builds) lists only iPhoneOS among its platforms, and would
 * otherwise fail only when Appium installs it, after the session's wait.
 */
export async function checkSimulatorBuild(app: string): Promise<void> {
  const platforms = await supportedPlatforms(app)
  if (platforms === undefined || platforms.includes('iPhoneSimulator')) return
  throw new Error(`--app: ${app} is built for ${platforms.join(', ') || 'no platform'}, not for the iOS Simulator.\n${SIMULATOR_BUILD}`)
}

/**
 * The app's CFBundleSupportedPlatforms, read from the .app or from the .app inside an
 * .ipa or .zip, or undefined when it can't be read (no plutil, an unusual layout).
 */
export async function supportedPlatforms(app: string): Promise<string[] | undefined> {
  let plist = join(app, 'Info.plist')
  let scratch: string | undefined
  try {
    if (!statSync(app).isDirectory()) {
      // Only the Info.plist entries: listing a large app in full can overflow the output buffer.
      const { stdout } = await run('unzip', ['-Z1', app, '*.app/Info.plist'])
      const entry = stdout.split('\n').find((line) => /^(Payload\/)?[^/]+\.app\/Info\.plist$/.test(line))
      if (!entry) return undefined
      scratch = mkdtempSync(join(tmpdir(), 'jevvium-app-'))
      await run('unzip', ['-o', '-q', app, entry, '-d', scratch])
      plist = join(scratch, entry)
    }
    const { stdout } = await run('plutil', ['-extract', 'CFBundleSupportedPlatforms', 'json', '-o', '-', plist])
    const value = JSON.parse(stdout) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
  } catch {
    return undefined
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}
