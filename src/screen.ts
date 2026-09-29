import { XMLParser } from 'fast-xml-parser'
import { quoted, xpathLiteral } from './locator.ts'
import type { ElementKind, Locator, Platform, Screen, ScreenElement } from './types.ts'

type Node = { tag: string; attrs: Record<string, string>; children: Node[] }

const IOS_KINDS: Record<string, ElementKind> = {
  XCUIElementTypeButton: 'button',
  XCUIElementTypeCell: 'button',
  XCUIElementTypeLink: 'button',
  XCUIElementTypeTextField: 'input',
  XCUIElementTypeSecureTextField: 'input',
  XCUIElementTypeTextView: 'input',
  XCUIElementTypeSearchField: 'input',
  XCUIElementTypeSwitch: 'switch',
}
const IOS_OTHER = 'XCUIElementTypeOther'
const IOS_KEYBOARD = 'XCUIElementTypeKeyboard'
const IOS_WINDOW = 'XCUIElementTypeWindow'
/** Keyboard buttons worth offering: the return key under its common names. The rest are typing keys. */
const RETURN_KEY = /^(done|return|go|next|search|send|join|continue)$/i
const IOS_TEXT = 'XCUIElementTypeStaticText'

/** Icon fonts render as private-use characters, which mean nothing to a model. */
const ICON_ONLY = /^[\p{Co}\s]*$/u

/** Turns an Appium page source into the elements a user could act on. */
export function parseScreen(xml: string, platform: Platform): Screen {
  const root = parseTree(xml)
  const all = flatten(root)
  const height = screenHeight(all, platform)
  const found = platform === 'ios' ? iosElements(root, all, height) : androidElements(all, height)
  const elements = found.map((element, i) => ({ ...element, key: `e${i + 1}` }))
  const texts = unique(platform === 'ios' ? iosTexts(all) : androidTexts(all))
  return { platform, elements, texts }
}

/** True while a loading spinner is on screen, so the screen isn't finished yet. */
export function isBusy(xml: string, platform: Platform): boolean {
  const pattern = platform === 'ios'
    ? /<XCUIElementTypeActivityIndicator\b[^>]*>/g
    : /<android\.widget\.ProgressBar\b[^>]*>/g
  const shown = platform === 'ios' ? 'visible="true"' : 'displayed="true"'
  return [...xml.matchAll(pattern)].some(([tag]) => tag.includes(shown))
}

// iOS -----------------------------------------------------------------------

function iosElements(root: Node, all: Node[], height: number): Omit<ScreenElement, 'key'>[] {
  const result: Omit<ScreenElement, 'key'>[] = []
  // The keyboard's window also holds system chrome (password autofill, the globe key).
  const keyboardWindows = all.filter((n) => n.tag === IOS_WINDOW && descendants(n).some((d) => d.tag === IOS_KEYBOARD))
  const keyboard = new Set(keyboardWindows.flatMap(descendants))
  walk(root, (node) => {
    if (node.attrs.visible !== 'true' || node.attrs.enabled === 'false') return
    let kind: ElementKind | undefined = IOS_KINDS[node.tag] ?? (isIosTouchable(node) ? 'button' : undefined)
    if (keyboard.has(node)) kind = kind === 'button' && RETURN_KEY.test(node.attrs.label ?? '') ? 'key' : undefined
    if (!kind) return
    const label = kind === 'input'
      ? node.attrs.placeholderValue || node.attrs.label || node.attrs.name
      : node.attrs.label || firstText(node, IOS_TEXT, 'label') || node.attrs.name
    if (!label || ICON_ONLY.test(label)) return
    const centre = Number(node.attrs.y) + Number(node.attrs.height) / 2
    result.push({ kind, label, id: node.attrs.name || undefined, region: region(centre, height), locator: iosLocator(node, all) })
  })
  return result
}

/**
 * React Native renders touchables as `XCUIElementTypeOther` named after their
 * testID. A named Other with no label is a touchable only if it doesn't wrap
 * other named controls; otherwise it is a screen or section container.
 */
function isIosTouchable(node: Node): boolean {
  if (node.tag !== IOS_OTHER || !node.attrs.name || node.attrs.label) return false
  return !descendants(node).some((child) => child.attrs.name && (child.tag === IOS_OTHER || child.tag in IOS_KINDS))
}

function iosLocator(node: Node, all: Node[]): Locator {
  const { name } = node.attrs
  if (name && all.filter((n) => n.attrs.name === name).length === 1) {
    return { using: 'accessibility id', value: name }
  }
  const sameType = all.filter((n) => n.tag === node.tag && n.attrs.name === name)
  if (name && sameType.length === 1) {
    return { using: '-ios predicate string', value: `type == ${quoted(node.tag)} AND name == ${quoted(name)}` }
  }
  const path = name ? `//${node.tag}[@name=${xpathLiteral(name)}]` : `//${node.tag}`
  return { using: 'xpath', value: `(${path})[${sameType.indexOf(node) + 1}]` }
}

function iosTexts(all: Node[]): string[] {
  return all
    .filter((n) => n.tag === IOS_TEXT && n.attrs.visible === 'true')
    .map((n) => n.attrs.label || n.attrs.value || '')
}

// Android -------------------------------------------------------------------

function androidElements(all: Node[], height: number): Omit<ScreenElement, 'key'>[] {
  const result: Omit<ScreenElement, 'key'>[] = []
  for (const node of all) {
    const { attrs } = node
    if (attrs.displayed === 'false' || attrs.enabled === 'false') continue
    const kind: ElementKind | undefined = isAndroidInput(node)
      ? 'input'
      : attrs.checkable === 'true'
        ? 'switch'
        : attrs.clickable === 'true'
          ? 'button'
          : undefined
    if (!kind) continue
    const id = shortResourceId(attrs['resource-id'])
    // An input's `text` is what was typed, so it is never used as its name.
    const label = kind === 'input'
      ? attrs.hint || attrs['content-desc'] || id
      : attrs.text || firstText(node, undefined, 'text') || attrs['content-desc'] || id
    if (!label || ICON_ONLY.test(label)) continue
    const [top, bottom] = androidVerticalBounds(attrs.bounds)
    result.push({
      kind,
      label,
      id: attrs['content-desc'] || id || undefined,
      region: region((top + bottom) / 2, height),
      locator: androidLocator(node, all),
    })
  }
  return result
}

function isAndroidInput(node: Node): boolean {
  return node.attrs.class?.endsWith('EditText') ?? false
}

function androidLocator(node: Node, all: Node[]): Locator {
  const desc = node.attrs['content-desc']
  if (desc && all.filter((n) => n.attrs['content-desc'] === desc).length === 1) {
    return { using: 'accessibility id', value: desc }
  }
  const resourceId = node.attrs['resource-id']
  if (resourceId && all.filter((n) => n.attrs['resource-id'] === resourceId).length === 1) {
    return { using: '-android uiautomator', value: `new UiSelector().resourceId(${quoted(resourceId)})` }
  }
  const text = node.attrs.text
  if (text && !isAndroidInput(node) && all.filter((n) => n.tag === node.tag && n.attrs.text === text).length === 1) {
    return { using: 'xpath', value: `//${node.tag}[@text=${xpathLiteral(text)}]` }
  }
  const sameType = all.filter((n) => n.tag === node.tag && n.attrs['content-desc'] === desc)
  const path = desc ? `//${node.tag}[@content-desc=${xpathLiteral(desc)}]` : `//${node.tag}`
  return { using: 'xpath', value: `(${path})[${sameType.indexOf(node) + 1}]` }
}

function androidTexts(all: Node[]): string[] {
  return all
    .filter((n) => n.attrs.displayed !== 'false' && !isAndroidInput(n))
    .map((n) => n.attrs.text ?? '')
}

/** `[x1,y1][x2,y2]` to `[y1, y2]`. */
function androidVerticalBounds(bounds: string | undefined): [number, number] {
  const match = bounds?.match(/^\[\d+,(\d+)\]\[\d+,(\d+)\]$/)
  return match ? [Number(match[1]), Number(match[2])] : [NaN, NaN]
}

function shortResourceId(resourceId: string | undefined): string | undefined {
  return resourceId?.split(':id/').pop()
}

// Layout --------------------------------------------------------------------

function screenHeight(all: Node[], platform: Platform): number {
  if (platform === 'ios') {
    return Number(all.find((n) => n.tag === 'XCUIElementTypeApplication')?.attrs.height)
  }
  const hierarchy = all.find((n) => n.tag === 'hierarchy')
  return Number(hierarchy?.attrs.height) || androidVerticalBounds(hierarchy?.children[0]?.attrs.bounds)[1]
}

function region(centre: number, height: number): ScreenElement['region'] {
  if (!Number.isFinite(centre) || !(height > 0)) return undefined
  return centre < height / 3 ? 'top' : centre < (height * 2) / 3 ? 'middle' : 'bottom'
}

// Tree helpers --------------------------------------------------------------

type Parsed = Record<string, unknown> & { ':@'?: Record<string, string> }

function parseTree(xml: string): Node {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    preserveOrder: true,
    parseAttributeValue: false,
  })
  const toNode = (item: Parsed): Node | undefined => {
    const tag = Object.keys(item).find((key) => key !== ':@')
    if (!tag || tag === '?xml' || tag === '#text') return undefined
    const children = (item[tag] as Parsed[]).map(toNode).filter((n): n is Node => n !== undefined)
    return { tag, attrs: item[':@'] ?? {}, children }
  }
  const children = (parser.parse(xml) as Parsed[]).map(toNode).filter((n): n is Node => n !== undefined)
  return { tag: 'root', attrs: {}, children }
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function flatten(root: Node): Node[] {
  const nodes: Node[] = []
  walk(root, (node) => nodes.push(node))
  return nodes.slice(1)
}

function descendants(node: Node): Node[] {
  return node.children.flatMap((child) => [child, ...descendants(child)])
}

function firstText(node: Node, tag: string | undefined, attr: string): string | undefined {
  return descendants(node)
    .filter((n) => tag === undefined || n.tag === tag)
    .map((n) => n.attrs[attr])
    .find((value) => value && !ICON_ONLY.test(value))
}

function unique(texts: string[]): string[] {
  return [...new Set(texts.map((t) => t.trim()).filter((t) => t !== '' && !ICON_ONLY.test(t)))]
}
