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

export type ParseOptions = {
  /**
   * How to tell what is on screen, on iOS:
   * - `attribute` trusts XCTest's `visible`, which is accurate but makes a read several times slower
   * - `geometry` works it out from positions, for a read without `visible`: on screen, not under
   *   the keyboard, not behind an alert. Only safe when `needsFullRead` says the screen is simple
   * - `all` treats everything as visible, to find where a known element is now
   */
  visibility?: 'attribute' | 'geometry' | 'all'
}

/** Turns an Appium page source into the elements a user could act on. */
export function parseScreen(xml: string, platform: Platform, options: ParseOptions = {}): Screen {
  const root = parseTree(xml)
  const all = flatten(root)
  if (platform === 'ios' && options.visibility === 'geometry') markVisibleByGeometry(all)
  if (platform === 'ios' && options.visibility === 'all') for (const node of all) node.attrs.visible = 'true'
  const height = screenHeight(all, platform)
  const found = platform === 'ios' ? iosElements(root, all, height) : androidElements(all, height)
  const elements = found.map((element, i) => ({ ...element, key: `e${i + 1}` }))
  const texts = unique(platform === 'ios' ? iosTexts(all) : androidTexts(all))
  return { platform, elements, texts }
}

/**
 * True while a loading spinner is on screen, so the screen isn't finished yet.
 * On a read without `visible`, the spinner's visibility is worked out from
 * positions like the rest of the screen, so one below the fold doesn't count.
 * UIKit takes a stopped spinner out of the tree, and one that stays reports 0.
 */
export function isBusy(xml: string, platform: Platform): boolean {
  if (platform === 'android') {
    return [...xml.matchAll(/<android\.widget\.ProgressBar\b[^>]*>/g)].some(([tag]) => tag.includes('displayed="true"'))
  }
  if (!xml.includes('<XCUIElementTypeActivityIndicator')) return false
  const all = flatten(parseTree(xml))
  if (!xml.includes(' visible="')) markVisibleByGeometry(all)
  return all.some(
    (n) => n.tag === 'XCUIElementTypeActivityIndicator' && n.attrs.visible === 'true' && n.attrs.value !== '0',
  )
}

/**
 * Whether a read without `visible` can't be trusted to show what's on screen:
 * sheets and popovers, or content spread over more than one window (a modal,
 * a toast), where only XCTest's hit testing can tell what is on top.
 */
export function needsFullRead(xml: string): boolean {
  if (/<XCUIElementType(Sheet|Popover|Dialog)\b/.test(xml)) return true
  const windows = flatten(parseTree(xml)).filter((n) => n.tag === IOS_WINDOW)
  const withContent = windows.filter(
    (window) => !descendants(window).some((n) => n.tag === IOS_KEYBOARD) && descendants(window).some(hasContent),
  )
  return withContent.length > 1
}

function hasContent(node: Node): boolean {
  if (node.tag === IOS_TEXT) return Boolean(node.attrs.label || node.attrs.value)
  return node.tag in IOS_KINDS && Boolean(node.attrs.label || node.attrs.name)
}

/**
 * Sets `visible` from positions, the way XCTest would see it on a simple screen:
 * the element's centre is on screen, above the keyboard, and inside the alert if
 * one is showing. Keyboard keys are left visible.
 */
function markVisibleByGeometry(all: Node[]): void {
  const app = all.find((n) => n.tag === 'XCUIElementTypeApplication')
  const width = Number(app?.attrs.width)
  const height = Number(app?.attrs.height)
  const keyboardWindow = all.find((n) => n.tag === IOS_WINDOW && descendants(n).some((d) => d.tag === IOS_KEYBOARD))
  const keyboard = new Set(keyboardWindow ? descendants(keyboardWindow) : [])
  // The keyboard's area starts at its highest part, the suggestion bar above the keys.
  const keyboardTop = Math.min(
    ...[...keyboard].filter((n) => Number(n.attrs.height) > 0 && Number(n.attrs.height) < height).map((n) => Number(n.attrs.y)),
  )
  const alerts = all.filter((n) => n.tag === 'XCUIElementTypeAlert')
  const inAlert = new Set(alerts.flatMap((alert) => [alert, ...descendants(alert)]))

  for (const node of all) {
    const w = Number(node.attrs.width)
    const h = Number(node.attrs.height)
    const x = Number(node.attrs.x) + w / 2
    const y = Number(node.attrs.y) + h / 2
    let visible = w > 0 && h > 0 && x >= 0 && x <= width && y >= 0 && y <= height
    if (visible && !keyboard.has(node)) {
      if (y >= keyboardTop) visible = false
      if (alerts.length > 0 && !inAlert.has(node)) visible = false
    }
    node.attrs.visible = visible ? 'true' : 'false'
  }
}

// iOS -----------------------------------------------------------------------

function iosElements(root: Node, all: Node[], height: number): Omit<ScreenElement, 'key'>[] {
  const found: { node: Node; element: Omit<ScreenElement, 'key'> }[] = []
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
    const centre = {
      x: Number(node.attrs.x) + Number(node.attrs.width) / 2,
      y: Number(node.attrs.y) + Number(node.attrs.height) / 2,
    }
    found.push({
      node,
      element: {
        kind,
        label,
        id: node.attrs.name || undefined,
        region: region(centre.y, height),
        centre,
        ...(kind === 'switch' && { checked: node.attrs.value === '1' }),
        // An empty field reports its placeholder as its value.
        ...(kind === 'input' && { empty: !node.attrs.value || node.attrs.value === node.attrs.placeholderValue }),
        locator: iosLocator(node, all),
      },
    })
  })

  // Plain text outside any control can caption a field; a button's own text can't.
  const inControls = new Set(found.flatMap(({ node }) => [node, ...descendants(node)]))
  const captions = all
    .filter((n) => n.tag === IOS_TEXT && n.attrs.visible === 'true' && !inControls.has(n) && !keyboard.has(n))
    .map((n) => ({ frame: iosFrame(n), text: (n.attrs.label || n.attrs.value || '').trim() }))
    .filter(({ text }) => text !== '' && !ICON_ONLY.test(text))
  const fields = found.filter(({ element }) => element.kind === 'input').map(({ node }) => iosFrame(node))
  return found.map(({ node, element }) =>
    element.kind === 'input' ? withCaption(element, captionFor(iosFrame(node), captions, fields)) : element,
  )
}

function iosFrame(node: Node): Frame {
  return { x: Number(node.attrs.x), y: Number(node.attrs.y), w: Number(node.attrs.width), h: Number(node.attrs.height) }
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
  // A field with no id often has a unique placeholder, which outlives what is typed into it.
  const placeholder = node.attrs.placeholderValue
  if (placeholder && all.filter((n) => n.tag === node.tag && n.attrs.placeholderValue === placeholder).length === 1) {
    return { using: '-ios predicate string', value: `type == ${quoted(node.tag)} AND placeholderValue == ${quoted(placeholder)}` }
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
  const found: { node: Node; element: Omit<ScreenElement, 'key'> }[] = []
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
    const frame = androidFrame(node)
    found.push({
      node,
      element: {
        kind,
        label,
        id: attrs['content-desc'] || id || undefined,
        region: region(frame.y + frame.h / 2, height),
        centre: { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 },
        ...(kind === 'switch' && { checked: attrs.checked === 'true' }),
        ...(kind === 'input' && { empty: !attrs.text || attrs.text === attrs.hint }),
        locator: androidLocator(node, all),
      },
    })
  }

  const inControls = new Set(found.flatMap(({ node }) => [node, ...descendants(node)]))
  const captions = all
    .filter((n) => n.attrs.text && n.attrs.displayed !== 'false' && !isAndroidInput(n) && !inControls.has(n))
    .map((n) => ({ frame: androidFrame(n), text: n.attrs.text.trim() }))
    .filter(({ text }) => text !== '' && !ICON_ONLY.test(text))
  const fields = found.filter(({ element }) => element.kind === 'input').map(({ node }) => androidFrame(node))
  return found.map(({ node, element }) =>
    element.kind === 'input' ? withCaption(element, captionFor(androidFrame(node), captions, fields)) : element,
  )
}

function androidFrame(node: Node): Frame {
  const [top, bottom] = androidVerticalBounds(node.attrs.bounds)
  const [left, right] = androidHorizontalBounds(node.attrs.bounds)
  return { x: left, y: top, w: right - left, h: bottom - top }
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

/** `[x1,y1][x2,y2]` to `[x1, x2]`. */
function androidHorizontalBounds(bounds: string | undefined): [number, number] {
  const match = bounds?.match(/^\[(\d+),\d+\]\[(\d+),\d+\]$/)
  return match ? [Number(match[1]), Number(match[2])] : [NaN, NaN]
}

/** `[x1,y1][x2,y2]` to `[y1, y2]`. */
function androidVerticalBounds(bounds: string | undefined): [number, number] {
  const match = bounds?.match(/^\[\d+,(\d+)\]\[\d+,(\d+)\]$/)
  return match ? [Number(match[1]), Number(match[2])] : [NaN, NaN]
}

function shortResourceId(resourceId: string | undefined): string | undefined {
  return resourceId?.split(':id/').pop()
}

// Captions ------------------------------------------------------------------

type Frame = { x: number; y: number; w: number; h: number }

/**
 * The text a person reads as a field's name: the nearest plain text just above
 * it (overlapping it horizontally) or just to its left on the same line. Forms
 * often use example values as placeholders ("03/25", "123"), so the caption is
 * what tells an expiration date from a security code. Text that sits closer
 * under another field, such as that field's error or hint, is not a caption.
 */
function captionFor(field: Frame, texts: { frame: Frame; text: string }[], fields: Frame[]): string | undefined {
  const reach = field.h * 1.5
  let best: { gap: number; text: string } | undefined
  for (const { frame, text } of texts) {
    const bottom = frame.y + frame.h
    const right = frame.x + frame.w
    const above = bottom <= field.y + 2 && field.y - bottom <= reach && overlapsHorizontally(frame, field)
    const beside = right <= field.x + 2 && field.x - right <= reach && Math.abs(frame.y + frame.h / 2 - (field.y + field.h / 2)) <= field.h / 2
    if (!above && !beside) continue
    const gap = above ? field.y - bottom : field.x - right
    const underAnother = fields.some((other) => {
      const otherBottom = other.y + other.h
      return other.y < field.y && frame.y >= otherBottom - 2 && overlapsHorizontally(frame, other) && frame.y - otherBottom < gap
    })
    if (underAnother) continue
    if (!best || gap < best.gap) best = { gap, text }
  }
  return best?.text
}

function overlapsHorizontally(a: Frame, b: Frame): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x
}

/** Names a field after its caption, keeping the placeholder as a detail. */
function withCaption(element: Omit<ScreenElement, 'key'>, caption: string | undefined): Omit<ScreenElement, 'key'> {
  if (!caption || caption === element.label) return element
  return { ...element, label: caption, placeholder: element.label }
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
