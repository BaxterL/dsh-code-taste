/**
 * Client half: the collapsible configuration card on the plugin's own page
 * (Plugins → Installed → 鲸味), styled with the harness's own theme tokens.
 *
 * Hand-written in the browser module format — no build step. Reads and writes go
 * to the host route `/dsh-code-taste/config`, which stores them in
 * `~/.dsh/taste/settings.json` (the plugin market's pattern: the card owns its
 * state instead of depending on the settings-form service).
 */
window.__ModuleLoader__.load({
  id: 'dsh-code-taste',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const ENDPOINT = '/dsh-code-taste/config'

    const SOURCES = [
      ['none', '不使用模型（只做确定性采集）'],
      ['host', '跟随当前会话模型（默认，自带 DeepSeek）'],
      ['custom', '第三方 / 本地模型（OpenAI 或 Anthropic 兼容）'],
    ]

    const FORMATS = [
      ['openai', 'OpenAI 兼容 /chat/completions'],
      ['anthropic', 'Anthropic /v1/messages'],
    ]

    const NUMBER_FIELDS = [
      ['injectBudgetChars', '注入预算', '字符数，每轮写进提示词的规则上限'],
      ['maxOutputTokens', '输出上限', '单次抽取最多生成多少 token'],
      ['timeoutMs', '请求超时', '毫秒'],
      ['minPending', '触发阈值', '攒够多少条信号才抽取一次'],
      ['throttleMinutes', '节流间隔', '两次抽取之间至少隔几分钟'],
      ['maxInputChars', '输入上限', '单次抽取发送的字符数'],
      ['maxRulesPerRun', '单次规则数', '一次抽取最多接受几条规则'],
    ]

    /** Fetch JSON, but never let an empty or non-JSON body surface as a raw parse error. */
    async function request(init) {
      const response = await fetch(ENDPOINT, init)
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}${text ? ` · ${text.slice(0, 120)}` : ''}`)
      if (!text) throw new Error('empty response')
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`unexpected response: ${text.slice(0, 120)}`)
      }
    }

    const S = {
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '10px 14px',
        background: 'transparent',
        border: 'none',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        textAlign: 'left',
        cursor: 'pointer',
      },
      chevron: {
        display: 'inline-block',
        transition: 'transform 120ms ease',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
      },
      title: { fontWeight: 500 },
      summary: {
        marginLeft: 'auto',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '55%',
      },
      body: {
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        padding: '12px 14px 14px',
        display: 'grid',
        gap: 10,
      },
      section: {
        fontSize: 11,
        letterSpacing: '0.08em',
        color: 'var(--dsw-alias-label-secondary)',
        marginTop: 4,
      },
      row: {
        display: 'grid',
        gridTemplateColumns: 'minmax(150px, 220px) 1fr',
        gap: 12,
        alignItems: 'center',
      },
      label: { fontSize: 12.5, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, lineHeight: 1.4 },
      control: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        boxSizing: 'border-box',
      },
      error: { fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary)' },
      footer: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
    }

    function Row(props) {
      return React.createElement(
        'label',
        { style: S.row },
        React.createElement(
          'span',
          { style: S.label },
          props.title,
          props.hintText ? React.createElement('div', { style: S.hint }, props.hintText) : null,
        ),
        props.children,
      )
    }

    function summarize(value) {
      if (!value) return ''
      if (value.source === 'none') return '抽取模型：不使用（零调用）'
      if (value.source === 'host') return '抽取模型：跟随当前会话'
      return `抽取模型：${value.format} · ${value.modelId || '未选模型'}`
    }

    function SettingsCard(props) {
      const [open, setOpen] = React.useState(false)
      const [value, setValue] = React.useState(null)
      const [error, setError] = React.useState('')
      const [attempt, setAttempt] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        request({ cache: 'no-store' })
          .then(body => {
            if (!alive) return
            setError('')
            setValue(body)
          })
          .catch(cause => {
            if (alive) setError(String(cause && cause.message ? cause.message : cause))
          })
        return () => {
          alive = false
        }
      }, [attempt])

      const save = (field, next) => {
        setValue(current => (current ? { ...current, [field]: next } : current))
        request({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ field, value: next }),
        })
          .then(body => {
            if (body && body.error) setError(String(body.error))
            else {
              setError('')
              setValue(body)
            }
          })
          .catch(cause => setError(String(cause && cause.message ? cause.message : cause)))
      }

      if (props && props.view === 'summary') {
        return React.createElement('div', { style: { ...S.summary, maxWidth: 'none', marginLeft: 0 } }, summarize(value))
      }

      const source = value ? value.source || 'none' : 'none'
      const format = value ? value.format || 'openai' : 'openai'

      const header = React.createElement(
        'button',
        {
          type: 'button',
          style: S.header,
          onClick: () => setOpen(current => !current),
          'aria-expanded': open,
        },
        React.createElement('span', { style: { ...S.chevron, transform: open ? 'rotate(90deg)' : 'none' } }, '▶'),
        React.createElement('span', { style: S.title }, '鲸味设置'),
        React.createElement('span', { style: S.summary }, error ? '服务未就绪' : summarize(value)),
      )

      if (!open) return React.createElement('div', { style: S.card }, header)

      if (!value) {
        return React.createElement(
          'div',
          { style: S.card },
          header,
          React.createElement(
            'div',
            { style: { ...S.body, justifyItems: 'start' } },
            React.createElement('div', { style: S.footer }, error ? `设置服务未就绪：${error}` : '加载中…'),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => setAttempt(count => count + 1),
                style: { ...S.control, width: 'auto', cursor: 'pointer' },
              },
              '重试',
            ),
          ),
        )
      }

      const body = React.createElement(
        'div',
        { style: S.body },
        React.createElement('div', { style: S.section }, '抽取模型'),
        React.createElement(
          Row,
          { title: '模型来源' },
          React.createElement(
            'select',
            { style: S.control, value: source, onChange: event => save('source', event.target.value) },
            SOURCES.map(([key, text]) => React.createElement('option', { key, value: key }, text)),
          ),
        ),
        source === 'custom'
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                Row,
                { title: '接口格式' },
                React.createElement(
                  'select',
                  { style: S.control, value: format, onChange: event => save('format', event.target.value) },
                  FORMATS.map(([key, text]) => React.createElement('option', { key, value: key }, text)),
                ),
              ),
              React.createElement(
                Row,
                { title: 'Base URL', hintText: '如 https://dashscope.aliyuncs.com/compatible-mode/v1 或 http://127.0.0.1:11434/v1' },
                React.createElement('input', {
                  style: S.control,
                  type: 'text',
                  value: value.baseURL || '',
                  placeholder: 'https://…/v1',
                  onChange: event => setValue(current => ({ ...current, baseURL: event.target.value })),
                  onBlur: event => save('baseURL', event.target.value),
                }),
              ),
              React.createElement(
                Row,
                { title: '模型 ID', hintText: '如 qwen-plus、qwen2.5-coder:7b' },
                React.createElement('input', {
                  style: S.control,
                  type: 'text',
                  value: value.modelId || '',
                  placeholder: 'qwen-plus',
                  onChange: event => setValue(current => ({ ...current, modelId: event.target.value })),
                  onBlur: event => save('modelId', event.target.value),
                }),
              ),
              React.createElement(
                Row,
                { title: 'Key 环境变量', hintText: '本地模型一般留空' },
                React.createElement('input', {
                  style: S.control,
                  type: 'text',
                  value: value.apiKeyEnv || '',
                  placeholder: 'DASHSCOPE_API_KEY',
                  onChange: event => setValue(current => ({ ...current, apiKeyEnv: event.target.value })),
                  onBlur: event => save('apiKeyEnv', event.target.value),
                }),
              ),
            )
          : null,

        React.createElement('div', { style: S.section }, '注入与节流'),
        NUMBER_FIELDS.map(([key, title, hintText]) =>
          React.createElement(
            Row,
            { key, title, hintText },
            React.createElement('input', {
              style: S.control,
              type: 'number',
              value: value[key] ?? '',
              onChange: event => {
                const parsed = Number.parseFloat(event.target.value)
                setValue(current => ({ ...current, [key]: Number.isFinite(parsed) ? parsed : 0 }))
              },
              onBlur: event => {
                const parsed = Number.parseFloat(event.target.value)
                if (Number.isFinite(parsed)) save(key, parsed)
              },
            }),
          ),
        ),

        value.usage && value.usage.calls > 0
          ? React.createElement(
              'div',
              { style: S.footer },
              `抽取消耗：${value.usage.calls} 次调用 · 输入 ${value.usage.inputTokens} / 输出 ${value.usage.outputTokens} tokens`,
            )
          : null,

        error
          ? React.createElement('div', { style: S.error }, `保存失败：${error}`)
          : React.createElement(
              'div',
              { style: S.footer },
              '改完即生效。规则文件：~/.dsh/taste/TASTE.md（全局）或 <工作区>/.dsh/taste/TASTE.md（项目）。',
            ),
      )

      return React.createElement('div', { style: S.card }, header, body)
    }

    /** Client entry point: one collapsible card on the bundle's page. */
    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-code-taste' },
          SettingsCard,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
