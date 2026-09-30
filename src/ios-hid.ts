import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SOURCE = fileURLToPath(new URL('../native/ios-hid/main.m', import.meta.url))
/** Commands normally answer in milliseconds; this only catches a helper that stopped responding. */
const COMMAND_TIMEOUT_MS = 10_000
const PER_CHARACTER_MS = 200

/**
 * How key presses reach the simulator: `dtuhidd` (Xcode 27 and later), the
 * legacy HID port (earlier Xcodes), or `none` when this simulator ignores the
 * legacy port and dtuhidd didn't answer, so typing must go through Appium.
 */
export type Keyboard = 'dtuhidd' | 'legacy' | 'none'

type Helper = ChildProcessByStdio<Writable, Readable, null>
type Waiter = { resolve: (line: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/**
 * Taps and types straight into a booted iOS Simulator through jevvium's native
 * helper (native/ios-hid), skipping XCTest: a tap takes about 25 ms instead of 400.
 * The helper is compiled with the machine's own Xcode on first use and cached.
 */
export class IosHid {
  keyboard: Keyboard = 'none'
  private readonly helper: Helper
  private readonly waiting: Waiter[] = []
  private stopped: Error | undefined

  private constructor(helper: Helper) {
    this.helper = helper
    createInterface({ input: helper.stdout }).on('line', (line) => {
      const waiter = this.waiting.shift()
      if (!waiter) return
      clearTimeout(waiter.timer)
      waiter.resolve(line)
    })
    // Once the helper is gone, everything waiting on it and every later command fails at once.
    const stop = (error: Error) => {
      this.stopped ??= error
      for (const waiter of this.waiting.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(this.stopped)
      }
    }
    helper.on('exit', (code, signal) => stop(new Error(`The iOS input helper stopped (${signal ?? `exit ${code}`})`)))
    helper.on('error', (error) => stop(new Error(`The iOS input helper failed: ${error.message}`)))
    helper.stdin.on('error', (error) => stop(new Error(`The iOS input helper stopped reading: ${error.message}`)))
  }

  static async start(udid: string): Promise<IosHid> {
    const developerDir = (await run('xcode-select', ['-p'])).stdout.trim()
    const binary = await build(developerDir)
    const hid = new IosHid(spawn(binary, [developerDir, udid], { stdio: ['pipe', 'pipe', 'ignore'] }))
    try {
      // Connecting includes waiting for the simulator's keyboard service to start.
      const ready = await hid.reply(COMMAND_TIMEOUT_MS * 2)
      if (!ready.startsWith('ready')) throw new Error(`The iOS input helper could not connect: ${ready.replace(/^error /, '')}`)
      hid.keyboard = ready.includes('dtuhidd') ? 'dtuhidd' : ready.includes('legacy') ? 'legacy' : 'none'
      return hid
    } catch (error) {
      hid.helper.kill()
      throw error
    }
  }

  /** Taps at a point given as fractions of the screen, from the top left. */
  tap(x: number, y: number): Promise<void> {
    return this.command(`tap ${x.toFixed(5)} ${y.toFixed(5)}`)
  }

  /** Types printable ASCII into the focused field. */
  type(text: string): Promise<void> {
    return this.command(`text ${text}`, COMMAND_TIMEOUT_MS + PER_CHARACTER_MS * text.length)
  }

  /** Selects everything in the focused field and deletes it. */
  clear(): Promise<void> {
    return this.command('clear')
  }

  close(): void {
    if (!this.stopped) this.helper.stdin.end('quit\n')
  }

  private async command(line: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
    const answer = this.reply(timeoutMs)
    if (!this.stopped) this.helper.stdin.write(`${line}\n`)
    const result = await answer
    if (result !== 'ok') throw new Error(`iOS input helper: ${result.replace(/^error /, '')}`)
  }

  private reply(timeoutMs: number): Promise<string> {
    if (this.stopped) return Promise.reject(this.stopped)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1)
          reject(new Error(`The iOS input helper did not answer within ${timeoutMs} ms`))
        }, timeoutMs),
      }
      this.waiting.push(waiter)
    })
  }
}

/** True when `text` can go through the helper, which types printable ASCII only. */
export function canTypeDirectly(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text)
}

const builds = new Map<string, Promise<string>>()

/**
 * Compiles the helper for this Xcode unless a build of the same source already
 * exists. Simulators started side by side share one build, and the binary is
 * written under a temporary name first, so no one runs a half-written file.
 */
function build(developerDir: string): Promise<string> {
  const source = readFileSync(SOURCE)
  const key = createHash('sha256').update(source).update(developerDir).digest('hex').slice(0, 12)
  const dir = join(homedir(), 'Library', 'Caches', 'jevvium')
  const binary = join(dir, `jevvium-hid-${key}`)
  if (existsSync(binary)) return Promise.resolve(binary)
  if (!builds.has(binary)) {
    const building = (async () => {
      mkdirSync(dir, { recursive: true })
      const partial = `${binary}.${process.pid}.partial`
      try {
        await run('xcrun', ['clang', '-fobjc-arc', '-O2', '-framework', 'Foundation', '-framework', 'CoreGraphics', SOURCE, '-o', partial])
        renameSync(partial, binary)
        return binary
      } catch (error) {
        rmSync(partial, { force: true })
        throw new Error(`Could not build the iOS input helper with Xcode: ${(error as { stderr?: string }).stderr ?? error}`, {
          cause: error,
        })
      }
    })()
    builds.set(binary, building)
    building.catch(() => builds.delete(binary))
  }
  return builds.get(binary)!
}
