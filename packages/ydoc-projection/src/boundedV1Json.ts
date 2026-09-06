import * as string from 'lib0/string'

export interface BoundedV1JsonBudget {
  visitValueNode(): void
  visitDecodedPayloadBytes(byteLength: number): void
  refuseCapacity(): never
}

export interface BoundedV1JsonObservation {
  onKeyMaterialized?(): void
}

const MAX_DEPTH = 128
class JsonScanner {
  private index = 0

  constructor(
    private readonly source: string,
    private readonly budget: BoundedV1JsonBudget,
    private readonly observation?: BoundedV1JsonObservation,
  ) {}

  scan(): void {
    this.skipWhitespace()
    this.scanValue(0)
    this.skipWhitespace()
    if (this.index !== this.source.length) this.invalid()
  }

  private scanValue(depth: number): void {
    if (depth > MAX_DEPTH) this.budget.refuseCapacity()
    this.budget.visitValueNode()
    const current = this.source.charCodeAt(this.index)
    switch (current) {
      case 0x22:
        this.scanString(true)
        return
      case 0x5b:
        this.scanArray(depth)
        return
      case 0x7b:
        this.scanObject(depth)
        return
      case 0x74:
        this.scanLiteral('true')
        return
      case 0x66:
        this.scanLiteral('false')
        return
      case 0x6e:
        this.scanLiteral('null')
        return
      default:
        this.scanNumber()
    }
  }

  private scanArray(depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.consume(0x5d)) return
    while (true) {
      this.scanValue(depth + 1)
      this.skipWhitespace()
      if (this.consume(0x5d)) return
      if (!this.consume(0x2c)) this.invalid()
      this.skipWhitespace()
    }
  }

  private scanObject(depth: number): void {
    this.index += 1
    this.skipWhitespace()
    const keys = new Set<string>()
    if (this.consume(0x7d)) return
    while (true) {
      if (this.source.charCodeAt(this.index) !== 0x22) this.invalid()
      const key = this.scanString(false)
      if (key === undefined) this.invalid()
      if (keys.has(key)) this.invalid()
      keys.add(key)
      this.skipWhitespace()
      if (!this.consume(0x3a)) this.invalid()
      this.skipWhitespace()
      this.scanValue(depth + 1)
      this.skipWhitespace()
      if (this.consume(0x7d)) return
      if (!this.consume(0x2c)) this.invalid()
      this.skipWhitespace()
    }
  }

  private scanString(isValue: boolean): string | undefined {
    const tokenStart = this.index
    this.index += 1
    let decodedByteLength = 0
    let pendingHighSurrogate = false
    const measureUnit = (unit: number): void => {
      if (pendingHighSurrogate) {
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          decodedByteLength += 4
          pendingHighSurrogate = false
          return
        }
        decodedByteLength += 3
        pendingHighSurrogate = false
      }
      if (unit >= 0xd800 && unit <= 0xdbff) {
        pendingHighSurrogate = true
      } else if (unit <= 0x7f) {
        decodedByteLength += 1
      } else if (unit <= 0x7ff) {
        decodedByteLength += 2
      } else {
        decodedByteLength += 3
      }
    }

    while (this.index < this.source.length) {
      const unit = this.source.charCodeAt(this.index)
      if (unit === 0x22) {
        if (pendingHighSurrogate) decodedByteLength += 3
        const tokenEnd = this.index
        this.index += 1
        this.budget.visitDecodedPayloadBytes(decodedByteLength)
        if (isValue) return undefined
        this.observation?.onKeyMaterialized?.()
        return this.decodeKeyAfterCharge(tokenStart + 1, tokenEnd)
      }
      if (unit < 0x20) this.invalid()
      if (unit !== 0x5c) {
        measureUnit(unit)
        this.index += 1
        continue
      }

      this.index += 1
      const escape = this.source.charCodeAt(this.index)
      switch (escape) {
        case 0x22:
        case 0x2f:
        case 0x5c:
          measureUnit(escape)
          this.index += 1
          break
        case 0x62:
          measureUnit(0x08)
          this.index += 1
          break
        case 0x66:
          measureUnit(0x0c)
          this.index += 1
          break
        case 0x6e:
          measureUnit(0x0a)
          this.index += 1
          break
        case 0x72:
          measureUnit(0x0d)
          this.index += 1
          break
        case 0x74:
          measureUnit(0x09)
          this.index += 1
          break
        case 0x75: {
          if (this.index + 5 > this.source.length) this.invalid()
          let escapedUnit = 0
          for (let offset = 1; offset <= 4; offset += 1) {
            const nibble = this.hexValue(this.source.charCodeAt(this.index + offset))
            if (nibble < 0) this.invalid()
            escapedUnit = (escapedUnit * 16) + nibble
          }
          measureUnit(escapedUnit)
          this.index += 5
          break
        }
        default:
          this.invalid()
      }
    }
    return this.invalid()
  }

  private decodeKeyAfterCharge(start: number, end: number): string {
    const chunks: string[] = []
    let index = start
    let segmentStart = start
    while (index < end) {
      if (this.source.charCodeAt(index) !== 0x5c) {
        index += 1
        continue
      }
      if (segmentStart < index) chunks.push(this.source.slice(segmentStart, index))
      index += 1
      const escape = this.source.charCodeAt(index)
      let unit: number
      switch (escape) {
        case 0x22:
        case 0x2f:
        case 0x5c:
          unit = escape
          index += 1
          break
        case 0x62:
          unit = 0x08
          index += 1
          break
        case 0x66:
          unit = 0x0c
          index += 1
          break
        case 0x6e:
          unit = 0x0a
          index += 1
          break
        case 0x72:
          unit = 0x0d
          index += 1
          break
        case 0x74:
          unit = 0x09
          index += 1
          break
        case 0x75:
          unit = 0
          for (let offset = 1; offset <= 4; offset += 1) {
            unit = (unit * 16) + this.hexValue(this.source.charCodeAt(index + offset))
          }
          index += 5
          break
        default:
          return this.invalid()
      }
      chunks.push(String.fromCharCode(unit))
      segmentStart = index
    }
    if (segmentStart < end) chunks.push(this.source.slice(segmentStart, end))
    return chunks.join('')
  }

  private hexValue(unit: number): number {
    if (unit >= 0x30 && unit <= 0x39) return unit - 0x30
    if (unit >= 0x41 && unit <= 0x46) return unit - 0x41 + 10
    if (unit >= 0x61 && unit <= 0x66) return unit - 0x61 + 10
    return -1
  }

  private scanNumber(): void {
    if (this.consume(0x2d) && this.index >= this.source.length) this.invalid()
    const first = this.source.charCodeAt(this.index)
    if (first === 0x30) {
      this.index += 1
      if (this.isDigit(this.source.charCodeAt(this.index))) this.invalid()
    } else if (first >= 0x31 && first <= 0x39) {
      this.index += 1
      while (this.isDigit(this.source.charCodeAt(this.index))) this.index += 1
    } else {
      this.invalid()
    }

    if (this.consume(0x2e)) {
      if (!this.isDigit(this.source.charCodeAt(this.index))) this.invalid()
      while (this.isDigit(this.source.charCodeAt(this.index))) this.index += 1
    }
    const exponent = this.source.charCodeAt(this.index)
    if (exponent === 0x65 || exponent === 0x45) {
      this.index += 1
      const sign = this.source.charCodeAt(this.index)
      if (sign === 0x2b || sign === 0x2d) this.index += 1
      if (!this.isDigit(this.source.charCodeAt(this.index))) this.invalid()
      while (this.isDigit(this.source.charCodeAt(this.index))) this.index += 1
    }
  }

  private scanLiteral(literal: string): void {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.invalid()
    }
    this.index += literal.length
  }

  private skipWhitespace(): void {
    while (true) {
      const unit = this.source.charCodeAt(this.index)
      if (unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d) {
        this.index += 1
      } else {
        return
      }
    }
  }

  private consume(unit: number): boolean {
    if (this.source.charCodeAt(this.index) !== unit) return false
    this.index += 1
    return true
  }

  private isDigit(unit: number): boolean {
    return unit >= 0x30 && unit <= 0x39
  }

  private invalid(): never {
    throw new SyntaxError('invalid bounded v1 JSON')
  }
}

export function parseBoundedV1Json(
  source: Uint8Array | string,
  budget: BoundedV1JsonBudget,
  nativeParse: (source: string) => unknown,
  observation?: BoundedV1JsonObservation,
): unknown {
  let text: string
  try {
    text = typeof source === 'string' ? source : string.decodeUtf8(source)
  } catch {
    throw new SyntaxError('invalid bounded v1 JSON UTF-8')
  }
  new JsonScanner(text, budget, observation).scan()
  return nativeParse(text)
}
