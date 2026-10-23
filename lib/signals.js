/**
 * Deterministic signal detection and prefiltering.
 *
 * The pattern table mirrors claude-reflect's approach (named patterns with
 * per-pattern confidence), and the secret floor mirrors komi-learn's stage-0
 * rejection: credentials never enter the store, even locally.
 *
 * @module dsh-code-taste/signals
 */

/**
 * Named patterns per signal kind. Order of kinds in `KIND_ORDER` decides which
 * signal wins when one sentence matches several.
 */
export const PATTERNS = {
  guardrail: [
    { name: 'never', re: /(永远不要|千万别|绝对不要|坚决不|never\s+\w+|do not ever|don't ever)/i, weight: 0.9 },
    { name: 'forbid', re: /(禁止|严禁|不许|不允许|must not|not allowed to)/i, weight: 0.88 },
  ],
  explicit: [
    { name: 'remember', re: /(记住|记下|记一下|以后都|以后就|从今往后|from now on|remember that|remember:)/i, weight: 0.9 },
    { name: 'always', re: /(一律|总是|always\s+\w+|whenever you)/i, weight: 0.82 },
  ],
  positive: [
    { name: 'affirm', re: /(对，?就这样|就这样|完美|没错|正合适|很好|exactly|perfect|that's right|nailed it|looks good)/i, weight: 0.8 },
  ],
  correction: [
    { name: 'not-use', re: /(不要用|别用|不要|不该|不应该|stop using|don't use|do not use)/i, weight: 0.7 },
    { name: 'swap', re: /(改成|换成|改为|应该是|改成用|use .{1,30} not |instead of|rather than|switch to)/i, weight: 0.65 },
    { name: 'wrong', re: /(不对|错了|不是这样|that's wrong|that is wrong|incorrect)/i, weight: 0.62 },
    { name: 'actually', re: /^(actually|wait|hmm, no)\b/i, weight: 0.55 },
  ],
}

const KIND_ORDER = ['guardrail', 'explicit', 'positive', 'correction']

/** Credential shapes that are rejected outright, never stored. */
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,120}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,80}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,120}\b/,
  /\bgithub_pat_[A-Za-z0-9_-]{20,120}\b/,
  /\bglpat-[A-Za-z0-9_-]{16,120}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,120}\b/,
  /\bnpm_[A-Za-z0-9]{30,120}\b/,
  /\bhf_[A-Za-z0-9]{20,120}\b/,
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{8,400}\b/,
  /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,100}:[^\s:/@]{1,100}@[^\s]{1,200}/i,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|bearer|client[_-]?secret)\b\s*[:=]\s*['"]?[^\s'"]{6,120}/i,
]

const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,10}\b/g

const QUESTION_RE = /([?？]\s*$)|(吗\s*$)|^(为什么|怎么|如何|是什么|能不能|可不可以)/
const ONE_OFF_RE = /(这次|这一回|临时|暂时|先这样|just this once|temporarily|for now)/i

const MIN_LENGTH = 4
const MAX_LENGTH = 600

/**
 * Classify one user message.
 * @param {string} text - trimmed user text.
 * @returns {{kind: string, patterns: string[], weight: number} | null} the strongest signal.
 */
export function classify(text) {
  for (const kind of KIND_ORDER) {
    const matched = PATTERNS[kind].filter(pattern => pattern.re.test(text))
    if (matched.length === 0) continue
    return {
      kind,
      patterns: matched.map(pattern => pattern.name),
      weight: Math.max(...matched.map(pattern => pattern.weight)),
    }
  }
  return null
}

/**
 * Decide whether a message may become evidence.
 * @param {string} raw - raw user text.
 * @returns {{ok: true, text: string} | {ok: false, reason: string}} the filtered result.
 */
export function prefilter(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-text' }
  let text = raw.trim()
  if (text.length < MIN_LENGTH) return { ok: false, reason: 'too-short' }
  if (text.length > MAX_LENGTH) text = text.slice(0, MAX_LENGTH)
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return { ok: false, reason: 'secret' }
  }
  if (QUESTION_RE.test(text) && classify(text) === null) return { ok: false, reason: 'question' }
  if (ONE_OFF_RE.test(text) && classify(text)?.kind !== 'explicit') return { ok: false, reason: 'one-off' }
  text = text
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(EMAIL_RE, '<email>')
  return { ok: true, text }
}

/**
 * Turn a user sentence into a rule body: drop leading meta-words and punctuation.
 * @param {string} text - filtered user text.
 * @returns {string} a short imperative rule body.
 */
export function toRuleText(text) {
  const stripped = text
    .replace(/^(记住|记下|记一下|请注意|注意|以后都|以后就|从今往后|remember that|remember:|from now on)[：:，,\s]*/i, '')
    .replace(/^[,，。;；:：\s]+/, '')
    .replace(/[,，。;；\s]+$/, '')
    .trim()
  return stripped.length > 0 ? stripped.slice(0, 200) : text.slice(0, 200)
}

const CATEGORY_HINTS = [
  [/圆角|间距|颜色|配色|字体|布局|设计|风格|ui|ux|tailwind|css|动画/i, 'design'],
  [/commit|测试|test|ci|发布|部署|分支|workflow|流程|脚本/i, 'workflow'],
  [/中文|回复|语气|口吻|沟通|communication|tone/i, 'communication'],
  [/不要|禁止|never|别/i, 'avoid'],
  [/前缀|路径|端口|接口|api|目录|命名空间|项目/i, 'project-detail'],
  [/依赖|框架|版本|node|python|typescript|react|vue|package/i, 'stack'],
]

/**
 * Guess a category from the rule text; code style is the default.
 * @param {string} text - rule body.
 * @returns {string} one of the store's categories.
 */
export function inferCategory(text) {
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(text)) return category
  }
  return 'code-style'
}

/** @returns {number} the base confidence for one signal kind. */
export function baseConfidence(kind) {
  switch (kind) {
    case 'guardrail':
      return 0.88
    case 'explicit':
      return 0.85
    case 'correction':
      return 0.6
    case 'positive':
      return 0.5
    // A rule the agent adds through the tool is a deliberate distillation, not a
    // guess: it starts active. Implicit signals stay below the 0.55 threshold.
    case 'tool':
      return 0.55
    default:
      return 0.4
  }
}
