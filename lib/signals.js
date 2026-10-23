/**
 * Deterministic signal detection and prefiltering. No model calls here: this is
 * the cheap gate that decides whether anything is worth extracting at all.
 *
 * @module dsh-taste/signals
 */

/** Explicit instruction: the user states a lasting preference. */
export const EXPLICIT_RE =
  /(记住|记下|以后都|以后就|从今往后|永久|always|never|from now on|remember that|remember:)/i

/** Correction: the user redirects the agent. */
export const CORRECTIVE_RE =
  /(不要用|别用|不要|应该|不该|改成|换成|换成用|而不是|统一用|一律|确实要|don't use|don't|instead of|should be|use .{1,30} not |not .{1,20}, use )/i

/** Positive reinforcement: only strengthens whatever was just applied. */
export const POSITIVE_RE =
  /(对，?就这样|就这样|完美|没错|正确|很好|exactly|perfect|that's right|looks good|good job)/i

const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/

const QUESTION_RE = /([?？]\s*$)|(吗\s*$)|^(为什么|怎么|如何|是什么|能不能|可不可以)/

const ONE_OFF_RE = /(这次|这一回|临时|暂时|先这样|just this once|temporarily|for now)/i

const MIN_LENGTH = 4
const MAX_LENGTH = 600

/**
 * Classify one user message.
 * @param {string} text - trimmed user text.
 * @returns {'explicit'|'corrective'|'positive'|null} the strongest matching signal.
 */
export function classify(text) {
  if (POSITIVE_RE.test(text)) return 'positive'
  if (EXPLICIT_RE.test(text)) return 'explicit'
  if (CORRECTIVE_RE.test(text)) return 'corrective'
  return null
}

/**
 * Decide whether a message may become evidence. Pure function, no I/O.
 * @param {string} raw - raw user text.
 * @returns {{ok: true, text: string} | {ok: false, reason: string}} the filtered result.
 */
export function prefilter(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-text' }
  let text = raw.trim()
  if (text.length < MIN_LENGTH) return { ok: false, reason: 'too-short' }
  if (text.length > MAX_LENGTH) text = text.slice(0, MAX_LENGTH)
  if (SECRET_RE.test(text)) return { ok: false, reason: 'secret' }
  if (QUESTION_RE.test(text) && !CORRECTIVE_RE.test(text)) return { ok: false, reason: 'question' }
  if (ONE_OFF_RE.test(text) && !EXPLICIT_RE.test(text)) return { ok: false, reason: 'one-off' }
  text = text
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
  return { ok: true, text }
}

/**
 * Turn a user sentence into a rule body: drop leading meta-words and trailing punctuation.
 * @param {string} text - filtered user text.
 * @returns {string} a short imperative rule body.
 */
export function toRuleText(text) {
  const stripped = text
    .replace(/^(记住|记下|请注意|注意|以后都|以后就|从今往后|remember that|remember:|from now on)[：:，,\s]*/i, '')
    .replace(/^[,，。;；:：\s]+/, '')
    .replace(/[,，。;；\s]+$/, '')
    .trim()
  return stripped.length > 0 ? stripped.slice(0, 200) : text.slice(0, 200)
}

const CATEGORY_HINTS = [
  [/圆角|间距|颜色|配色|字体|布局|设计|ui|ux|tailwind|css|圆角|动画/i, 'design'],
  [/commit|测试|test|ci|发布|部署|分支|workflow|流程|脚本/i, 'workflow'],
  [/中文|回复|语气|口吻|沟通|communication|tone/i, 'communication'],
  [/不要|禁止|avoid|never|别/i, 'avoid'],
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
