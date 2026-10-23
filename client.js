/**
 * Client half: the configuration card on the plugin's own page
 * (Plugins → Installed → 鲸味).
 *
 * Hand-written in the browser module format — no build step. Reads and writes go
 * to the host route `/dsh-code-taste/config`, which stores them in
 * `~/.dsh/taste/settings.json`. This follows the plugin market's pattern: the
 * card owns its own state instead of depending on the settings form service.
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
      ['host', '跟随当前会话模型（自带 DeepSeek）'],
      ['custom', '第三方 / 本地模型（OpenAI 或 Anthropic 兼容）'],
    ]

    const FORMATS = [
      ['openai', 'OpenAI 兼容 /chat/completions'],
      ['anthropic', 'Anthropic /v1/messages'],
    ]

    const NUMBER_FIELDS = [
      ['injectBudgetChars', '注入预算（字符）', '每轮写进提示词的规则长度上限'],
      ['maxOutputTokens', '单次抽取输出上限（token）', ''],
      ['timeoutMs', '请求超时（毫秒）', ''],
      ['minPending', '攒够多少条信号才抽取', ''],
      ['throttleMinutes', '两次抽取的最小间隔（分钟）', ''],
      ['maxInputChars', '单次抽取的输入上限（字符）', ''],
      ['maxRulesPerRun', '单次最多接受几条规则', ''],
    ]

    const row = { display: 'grid', gridTemplateColumns: 'minmax(180px, 260px) 1fr', gap: 12, alignItems: 'center', margin: '8px 0' }
    const label = { fontSize: 13, opacity: 0.85 }
    const hint = { fontSize: 11.5, opacity: 0.55, marginTop: 2 }
    const control = {
      font: 'inherit',
      fontSize: 13,
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid rgba(128,128,128,0.35)',
      background: 'transparent',
      color: 'inherit',
      width: '100%',
      boxSizing: 'border-box',
    }
    const sectionTitle = { fontSize: 12, letterSpacing: 1, opacity: 0.6, margin: '16px 0 2px' }

    function Field(props) {
      return React.createElement(
        'label',
        { style: row },
        React.createElement(
          'span',
          { style: label },
          props.title,
          props.hintText ? React.createElement('div', { style: hint }, props.hintText) : null,
        ),
        props.children,
      )
    }

    function SettingsCard(props) {
      const [value, setValue] = React.useState(null)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        let alive = true
        fetch(ENDPOINT, { cache: 'no-store' })
          .then(response => response.json())
          .then(body => {
            if (alive) setValue(body)
          })
          .catch(cause => {
            if (alive) setError(String(cause && cause.message ? cause.message : cause))
          })
        return () => {
          alive = false
        }
      }, [])

      const save = (field, next) => {
        setValue(current => (current ? { ...current, [field]: next } : current))
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ field, value: next }),
        })
          .then(response => response.json())
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
        if (!value) return null
        const text = value.source === 'none'
          ? '抽取模型：不使用（零调用）'
          : value.source === 'host'
            ? '抽取模型：跟随当前会话'
            : `抽取模型：${value.format} · ${value.baseURL || '未填地址'}`
        return React.createElement('div', { style: { fontSize: 12.5, opacity: 0.75 } }, text)
      }

      if (!value) {
        return React.createElement('div', { style: { fontSize: 12.5, opacity: 0.6, padding: '8px 0' } }, error || '加载中…')
      }

      const source = value.source || 'none'
      const format = value.format || 'openai'

      return React.createElement(
        'div',
        { style: { padding: '4px 0 14px' } },
        React.createElement('div', { style: sectionTitle }, '抽取模型'),

        React.createElement(
          Field,
          { title: '模型来源' },
          React.createElement(
            'select',
            { style: control, value: source, onChange: event => save('source', event.target.value) },
            SOURCES.map(([key, text]) => React.createElement('option', { key, value: key }, text)),
          ),
        ),

        source === 'custom'
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                Field,
                { title: '接口格式' },
                React.createElement(
                  'select',
                  { style: control, value: format, onChange: event => save('format', event.target.value) },
                  FORMATS.map(([key, text]) => React.createElement('option', { key, value: key }, text)),
                ),
              ),
              React.createElement(
                Field,
                { title: 'Base URL', hintText: '例如 https://dashscope.aliyuncs.com/compatible-mode/v1 或 http://127.0.0.1:11434/v1' },
                React.createElement('input', {
                  style: control,
                  type: 'text',
                  value: value.baseURL || '',
                  placeholder: 'https://…/v1',
                  onChange: event => setValue(current => ({ ...current, baseURL: event.target.value })),
                  onBlur: event => save('baseURL', event.target.value),
                }),
              ),
              React.createElement(
                Field,
                { title: '模型 ID', hintText: '例如 qwen-plus、qwen2.5-coder:7b' },
                React.createElement('input', {
                  style: control,
                  type: 'text',
                  value: value.modelId || '',
                  placeholder: 'qwen-plus',
                  onChange: event => setValue(current => ({ ...current, modelId: event.target.value })),
                  onBlur: event => save('modelId', event.target.value),
                }),
              ),
              React.createElement(
                Field,
                { title: 'Key 环境变量', hintText: '本地模型一般留空' },
                React.createElement('input', {
                  style: control,
                  type: 'text',
                  value: value.apiKeyEnv || '',
                  placeholder: 'DASHSCOPE_API_KEY',
                  onChange: event => setValue(current => ({ ...current, apiKeyEnv: event.target.value })),
                  onBlur: event => save('apiKeyEnv', event.target.value),
                }),
              ),
            )
          : null,

        React.createElement('div', { style: sectionTitle }, '注入与节流'),

        NUMBER_FIELDS.map(([key, title, hintText]) =>
          React.createElement(
            Field,
            { key, title, hintText },
            React.createElement('input', {
              style: control,
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

        error
          ? React.createElement('div', { style: { ...hint, color: '#e06c75', marginTop: 10 } }, `保存失败：${error}`)
          : React.createElement(
              'div',
              { style: { ...hint, marginTop: 12 } },
              '改完即生效。规则文件在 ~/.dsh/taste/TASTE.md（全局）或 <工作区>/.dsh/taste/TASTE.md（项目）。',
            ),
      )
    }

    /** Client entry point: one card on the bundle's page. */
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
