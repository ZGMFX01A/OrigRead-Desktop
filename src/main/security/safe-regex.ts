/** Conservative structural preflight for externally supplied JavaScript patterns. */
export const MAX_REGEX_PATTERN_LENGTH = 512
const MAX_REGEX_REPEAT_BOUND = 100

interface Structure {
  repeated: boolean
  alternation: boolean
  lookaround: boolean
  nullable: boolean
  characters: Set<number>
}

// ASCII sets are exact (case folded conservatively); 128 represents any non-ASCII
// character. Unknown Unicode/class intersections are conservatively treated as overlap.
function characters(source: string): Set<number> {
  const regex = new RegExp(`^(?:${source})$`, 'is')
  const result = new Set<number>()
  for (let code = 0; code < 128; code++) if (regex.test(String.fromCharCode(code))) result.add(code)
  if (source.startsWith('[') || source === '.' || source.startsWith('\\') || source.charCodeAt(0) >= 128) result.add(128)
  return result
}
const overlaps = (a: Set<number>, b: Set<number>): boolean => [...a].some(code => b.has(code))

export function assertSafeRegexPattern(pattern: string): void {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) throw new Error('正则表达式超过安全长度限制')
  // Validate grammar before walking it; escapes and classes are consumed as atoms below.
  new RegExp(pattern)
  let index = 0
  const unsafe = (): never => { throw new Error('正则表达式包含不安全的重复或反向引用') }
  function sequence(inLookaround = false): Structure {
    const result: Structure = { repeated: false, alternation: false, lookaround: inLookaround, nullable: true, characters: new Set() }
    let branchNullable = true
    let alternativeNullable = false
    const pendingRepeats = new Set<number>()
    while (index < pattern.length && pattern[index] !== ')') {
      const start = index
      let atom: Structure = { repeated: false, alternation: false, lookaround: false, nullable: false, characters: new Set() }
      const char = pattern[index++]!
      if (char === '|') { result.alternation = true; alternativeNullable ||= branchNullable; branchNullable = true; pendingRepeats.clear(); continue }
      if (char === '\\') {
        const escaped = pattern[index++]
        if (escaped && /[1-9k]/.test(escaped)) unsafe()
        // Property/code-point notation changes grammar with u/v. Reject it rather
        // than interpreting legacy identity escapes as Unicode syntax.
        if ((escaped === 'p' || escaped === 'P' || escaped === 'u') && pattern[index] === '{') unsafe()
        if (escaped === 'c') unsafe() // legacy control escapes have mode-dependent tokenization
        if (escaped === 'x' && /^[\da-f]{2}/i.test(pattern.slice(index))) index += 2
        if (escaped === 'u' && /^[\da-f]{4}/i.test(pattern.slice(index))) index += 4
        if (escaped === '0' && /[0-9]/.test(pattern[index] ?? '')) unsafe()
        if (escaped === 'b' || escaped === 'B') atom.nullable = true
      } else if (char === '[') {
        while (index < pattern.length) {
          const item = pattern[index++]
          if (item === '\\') index++
          else if (item === ']') break
        }
      } else if (char === '(') {
        let lookaround = false
        if (pattern[index] === '?') {
          index++
          if (pattern[index] === ':') index++
          else if (pattern[index] === '=' || pattern[index] === '!') { lookaround = true; index++ }
          else if (pattern[index] === '<') {
            index++
            if (pattern[index] === '=' || pattern[index] === '!') { lookaround = true; index++ }
            else { while (index < pattern.length && pattern[index++] !== '>') { /* group name */ } }
          }
        }
        atom = sequence(inLookaround || lookaround)
        atom.lookaround ||= lookaround
        if (lookaround) { atom.nullable = true; atom.characters.clear() }
        index++ // closing parenthesis, guaranteed by syntax validation
      }
      if (char === '^' || char === '$') atom.nullable = true
      if (char !== '(' && !atom.nullable) atom.characters = characters(pattern.slice(start, index))
      let repeats = false
      let quantified = false
      const quantifier = pattern[index]
      if (quantifier === '+' || quantifier === '*') { repeats = true; if (quantifier === '*') atom.nullable = true; index++ }
      else if (quantifier === '?') { quantified = true; atom.nullable = true; index++ }
      else if (quantifier === '{') {
        const bound = /^\{(\d+)(?:,(\d*)?)?\}/.exec(pattern.slice(index))
        if (bound) {
          const min = Number(bound[1])
          const max = bound[0].includes(',') ? (bound[2] ? Number(bound[2]) : Infinity) : min
          if (min > MAX_REGEX_REPEAT_BOUND || (max !== Infinity && max > MAX_REGEX_REPEAT_BOUND)) unsafe()
          repeats = max > 1
          quantified = min !== max
          if (min === 0) atom.nullable = true
          index += bound[0].length
        }
      }
      if (pattern[index] === '?' && quantifier && '*+?{'.includes(quantifier)) index++ // lazy suffix
      if (repeats && (atom.repeated || atom.alternation || atom.lookaround || inLookaround)) unsafe()
      const repeated = repeats || atom.repeated
      if (repeated && overlaps(pendingRepeats, atom.characters)) unsafe()
      if (!atom.nullable && !overlaps(pendingRepeats, atom.characters)) pendingRepeats.clear()
      if (repeated) for (const code of atom.characters) pendingRepeats.add(code)
      for (const code of atom.characters) result.characters.add(code)
      branchNullable &&= atom.nullable
      result.repeated ||= repeats || quantified || atom.repeated
      result.alternation ||= atom.alternation
      result.lookaround ||= atom.lookaround
    }
    result.nullable = alternativeNullable || branchNullable
    return result
  }
  sequence()
}

export function compileSafeRegex(pattern: string, flags = ''): RegExp {
  assertSafeRegexPattern(pattern)
  // Unicode set grammar changes the meaning of character classes; unsupported by this walker.
  if (flags.includes('v')) throw new Error('不支持 Unicode 集合正则标志')
  return new RegExp(pattern, flags)
}
