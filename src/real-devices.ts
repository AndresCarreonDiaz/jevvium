import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A physical iPhone or iPad that this Mac knows about, from `devicectl list devices`. */
export type RealDevice = {
  udid: string
  name: string
  model: string
  version: string
  paired: boolean
  developerMode: boolean
}

type DevicectlDevice = {
  hardwareProperties?: { udid?: string; reality?: string; platform?: string; marketingName?: string; deviceType?: string }
  deviceProperties?: { name?: string; osVersionNumber?: string; developerModeStatus?: string }
  connectionProperties?: { pairingState?: string }
}

/** The physical iOS devices in `devicectl list devices --json-output` output. */
export function parseRealDevices(json: string): RealDevice[] {
  const { result } = JSON.parse(json) as { result?: { devices?: DevicectlDevice[] } }
  return (result?.devices ?? [])
    .filter(({ hardwareProperties: hw }) => hw?.reality === 'physical' && hw.platform === 'iOS' && hw.udid)
    .map(({ hardwareProperties: hw, deviceProperties: dp, connectionProperties: cp }) => ({
      udid: hw!.udid!,
      name: dp?.name ?? hw!.marketingName ?? 'iPhone',
      model: hw!.marketingName ?? hw!.deviceType ?? 'iPhone',
      version: dp?.osVersionNumber ?? '',
      paired: cp?.pairingState === 'paired',
      developerMode: dp?.developerModeStatus === 'enabled',
    }))
}

/** Physical iOS devices paired with this Mac. Empty when devicectl isn't there (Xcode older than 15). */
export async function realDevices(): Promise<RealDevice[]> {
  try {
    const { stdout } = await run('xcrun', ['devicectl', 'list', 'devices', '--quiet', '--json-output', '-'], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return parseRealDevices(stdout)
  } catch {
    return []
  }
}

/** The device with this udid or name (any case), ready to test on, or an error that says what to fix. */
export function pickRealDevice(available: RealDevice[], wanted: string): RealDevice | undefined {
  const device =
    available.find((d) => d.udid.toLowerCase() === wanted.toLowerCase()) ??
    available.find((d) => d.name.toLowerCase() === wanted.toLowerCase())
  if (!device) return undefined
  if (!device.paired) {
    throw new Error(`${device.name} isn't paired with this Mac: connect it with a cable, unlock it and tap Trust`)
  }
  if (!device.developerMode) {
    throw new Error(`${device.name} needs Developer Mode: Settings > Privacy & Security > Developer Mode, then restart it`)
  }
  return device
}

/** Team ids of the Apple Development certificates in this PEM text that haven't expired. */
export function teamsOf(pem: string, now = new Date()): string[] {
  const teams = new Set<string>()
  for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(block)
    } catch {
      continue
    }
    if (new Date(certificate.validTo) < now) continue
    const team = certificate.subject.match(/^OU=([A-Z0-9]{10})$/m)?.[1]
    if (team) teams.add(team)
  }
  return [...teams]
}

/** Teams that can sign WebDriverAgent on this Mac, from the keychain's Apple Development certificates. */
export async function developmentTeams(): Promise<string[]> {
  try {
    const { stdout } = await run('security', ['find-certificate', '-a', '-c', 'Apple Development', '-p'], { maxBuffer: 16 * 1024 * 1024 })
    return teamsOf(stdout)
  } catch {
    return []
  }
}

/** A WebDriverAgent bundle id under the team. Xcode registers it the first time it signs. */
export function wdaBundleId(team: string): string {
  return `jevvium.${team.toLowerCase()}.WebDriverAgentRunner`
}

/**
 * The team that signs WebDriverAgent: the one given, or the only one this Mac has a
 * certificate for. With several, the user has to say which.
 */
export function chooseTeam(given: string | undefined, found: string[]): string {
  if (given) {
    if (!/^[A-Z0-9]{10}$/.test(given)) throw new Error(`--team-id must be a 10-character Apple team id like AB12CD34EF, not "${given}"`)
    return given
  }
  if (found.length === 1) return found[0]
  if (found.length === 0) {
    throw new Error(
      'A real iPhone needs WebDriverAgent signed with your Apple Developer team, and this Mac has no Apple Development ' +
        'certificate. Sign in to Xcode (Settings > Accounts) with your Apple ID, or pass --team-id',
    )
  }
  throw new Error(`This Mac has certificates for several teams (${found.join(', ')}); pick one with --team-id`)
}
