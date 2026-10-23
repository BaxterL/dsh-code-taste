/**
 * Client half: the configuration card on the plugin's own page
 * (Plugins → Installed → dsh-code-taste).
 *
 * Hand-written in the browser module format — no build step. React comes from
 * the module table; configuration reads and writes go through the host-owned
 * `configForms` controller, so nothing here talks to the network directly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-code-taste',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    /** Namespace of the host entry this card configures: the package name. */
    const NS = 'dsh-code-taste'

    /**
     * The configForms namespace is the host entry id. For a bundle that is the
     * package name, but our patch row is `taste`, so ask for both and take
     * whichever the host actually serves.
     */
    const NS_CANDIDATES = [NS, 'taste']

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

    const box = { display: 'grid', gap: 10, margin: '10px 0 4px' }
    const row = { display: 'grid', gridTemplateColumns: 'minmax(180px, 260px) 1fr', gap: 12, alignItems: 'center' }
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
    const sectionTitle = { fontSize: 12, letterSpacing: 1, opacity: 0.6, margin: '14px 0 2px' }

    /** Read one snapshot from the controller, tolerating a not-yet-mounted form. */
    function readSnapshot(form) {
      if (form && typeof form.getSnapshot === 'function') {
        try {
          const snapshot = form.getSnapshot()
          if (snapshot && typeof snapshot === 'object') return snapshot
        } catch {
          // fall through
        }
      }
      return { value: {}, writable: false }
    }

    /** Subscribe to the controller; re-renders when the host value changes. */
    function useFormState(form) {
      const [snapshot, setSnapshot] = React.useState(() => readSnapshot(form))
      React.useEffect(() => {
        if (!form || typeof form.subscribe !== 'function') return undefined
        let alive = true
        const sync = () => {
          if (alive) setSnapshot(readSnapshot(form))
        }
        sync()
        const dispose = form.subscribe(sync)
        return () => {
          alive = false
          if (typeof dispose === 'function') dispose()
        }
      }, [form])
      return snapshot
    }

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
      const form = props.form
      const snapshot = useFormState(form)
      const value = (snapshot && snapshot.value) || {}
      const writable = snapshot ? snapshot.writable !== false : true
      const view = props.view
      const source = typeof value.source === 'string' ? value.source : 'none'
      const format = typeof value.format === 'string' ? value.format : 'openai'

      const set = (key, next) => {
        if (!writable) return
        if (typeof props.onSet === 'function') props.onSet(key, next)
      }

      if (view === 'summary') {
        const text = source === 'none'
          ? '抽取模型：不使用（零调用）'
          : source === 'host'
            ? '抽取模型：跟随当前会话'
            : `抽取模型：${format} · ${value.baseURL || '未填地址'}`
        return React.createElement('div', { style: { fontSize: 12.5, opacity: 0.75 } }, text)
      }

      return React.createElement(
        'div',
        { style: { padding: '4px 0 12px' } },
        React.createElement('div', { style: sectionTitle }, '抽取模型'),

        React.createElement(
          Field,
          { title: '模型来源' },
          React.createElement(
            'select',
            {
              style: control,
              value: source,
              disabled: !writable,
              onChange: event => set('source', event.target.value),
            },
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
                  {
                    style: control,
                    value: format,
                    disabled: !writable,
                    onChange: event => set('format', event.target.value),
                  },
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
                  disabled: !writable,
                  placeholder: 'https://…/v1',
                  onChange: event => set('baseURL', event.target.value),
                }),
              ),
              React.createElement(
                Field,
                { title: '模型 ID', hintText: '例如 qwen-plus、qwen2.5-coder:7b' },
                React.createElement('input', {
                  style: control,
                  type: 'text',
                  value: value.modelId || '',
                  disabled: !writable,
                  placeholder: 'qwen-plus',
                  onChange: event => set('modelId', event.target.value),
                }),
              ),
              React.createElement(
                Field,
                { title: 'Key 环境变量', hintText: '本地模型一般留空；不要在这里直接写 key' },
                React.createElement('input', {
                  style: control,
                  type: 'text',
                  value: value.apiKeyEnv || '',
                  disabled: !writable,
                  placeholder: 'DASHSCOPE_API_KEY',
                  onChange: event => set('apiKeyEnv', event.target.value),
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
              disabled: !writable,
              onChange: event => {
                const parsed = Number.parseFloat(event.target.value)
                set(key, Number.isFinite(parsed) ? parsed : 0)
              },
            }),
          ),
        ),

        React.createElement(
          'div',
          { style: { ...hint, marginTop: 12 } },
          '保存后下一次会话生效；规则文件在 ~/.dsh/taste/TASTE.md（全局）或 <工作区>/.dsh/taste/TASTE.md（项目）。',
        ),
      )
    }

    /** Client entry point: one card, guarded by whether the host serves this namespace. */
    function apply(ctx) {
      if (typeof console !== 'undefined' && console.info) {
        console.info('[dsh-code-taste] client card applying; configForms =', Boolean(ctx.configForms))
      }
      if (!ctx.configForms || typeof ctx.configForms.whileServed !== 'function') {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-code-taste] configForms 服务不可用，设置卡片未注册（宿主功能不受影响）')
        }
        return
      }

      const inject = () => {
        let form = null
        for (const id of NS_CANDIDATES) {
          if (form) break
          try {
            form = ctx.configForms.get(id)
          } catch {
            form = null
          }
        }
        return {
          form,
          onSet: (field, next) =>
            form && typeof form.set === 'function' ? form.set(field, next) : Promise.resolve(false),
          onUnset: field =>
            form && typeof form.unset === 'function' ? form.unset(field) : Promise.resolve(false),
        }
      }

      ctx.effect(
        () =>
          ctx.configForms.whileServed(NS_CANDIDATES, () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                { name: 'plugins.bundle.config', key: NS, inject },
                SettingsCard,
              ),
            ),
          ),
        'dsh-code-taste: settings card',
      )
    }

    return { inject: ['slots', 'configForms'], apply }
  },
})
